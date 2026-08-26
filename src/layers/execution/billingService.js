"use strict";

/**
 * Billing & Entitlements Service
 *
 * Manages Shopify Billing subscriptions, plan definitions, and
 * server-side feature gating. Premium features (WhatsApp recovery,
 * advanced SEO, campaigns) are locked server-side — the frontend
 * UI is only a convenience layer.
 *
 * Plan tiers:
 *   - starter:  Free — live monitoring, stock alerts, 500 events/mo
 *   - growth:   $49/mo — full automation engine
 *   - scale:    $149/mo — multi-store, team roles, priority support
 */

const crypto = require("crypto");

/**
 * Plan definitions. Each plan lists the features/entitlements it
 * includes. The server checks these before executing any premium action.
 */
const PLANS = {
  starter: {
    id: "starter",
    name: "Starter",
    priceMonthly: 0,
    priceAnnual: 0,
    currency: "USD",
    features: {
      live_orders: true,
      stock_monitoring: true,
      product_insights: true,
      stockout_alerts: true,
      max_stores: 1,
      max_events_per_month: 500,
      cart_recovery: false,
      whatsapp_recovery: false,
      churn_scoring: false,
      competitor_radar: false,
      pricing_intelligence: false,
      campaigns: false,
      retargeting: false,
      seo_suite: false,
      attribution: false,
      custom_reports: false,
      team_roles: false,
      priority_support: false,
    },
  },

  growth: {
    id: "growth",
    name: "Growth",
    priceMonthly: 49,
    priceAnnual: 39,
    currency: "USD",
    features: {
      live_orders: true,
      stock_monitoring: true,
      product_insights: true,
      stockout_alerts: true,
      max_stores: 1,
      max_events_per_month: 50000,
      cart_recovery: true,
      whatsapp_recovery: true,
      churn_scoring: true,
      competitor_radar: true,
      pricing_intelligence: true,
      campaigns: true,
      retargeting: true,
      seo_suite: true,
      attribution: true,
      custom_reports: false,
      team_roles: false,
      priority_support: false,
    },
  },

  scale: {
    id: "scale",
    name: "Scale",
    priceMonthly: 149,
    priceAnnual: 119,
    currency: "USD",
    features: {
      live_orders: true,
      stock_monitoring: true,
      product_insights: true,
      stockout_alerts: true,
      max_stores: 5,
      max_events_per_month: 500000,
      cart_recovery: true,
      whatsapp_recovery: true,
      churn_scoring: true,
      competitor_radar: true,
      pricing_intelligence: true,
      campaigns: true,
      retargeting: true,
      seo_suite: true,
      attribution: true,
      custom_reports: true,
      team_roles: true,
      priority_support: true,
    },
  },
};

/**
 * Regional pricing configuration. Prices are set server-side; the
 * frontend must never be trusted for currency decisions.
 */
const REGIONAL_PRICING = {
  USD: { growth: 49, scale: 149 },
  EUR: { growth: 45, scale: 139 },
  GBP: { growth: 39, scale: 119 },
  INR: { growth: 3999, scale: 11999 },
  CAD: { growth: 65, scale: 199 },
  AUD: { growth: 75, scale: 229 },
};

function createBillingService({ store, config }) {
  return {
    PLANS,
    REGIONAL_PRICING,

    /**
     * Task 41: Create a Shopify Recurring Application Charge.
     *
     * Calls POST /admin/api/2025-01/recurring_application_charges.json
     * to create a charge, then returns the confirmation_url the merchant
     * must approve. After approval, Shopify fires the
     * app_subscriptions/update webhook.
     *
     * @param {string} shopDomain  e.g. "my-store.myshopify.com"
     * @param {string} accessToken  Shopify store access token
     * @param {string} planId       "growth" | "scale"
     * @param {object} opts         { return_url, currency, test }
     */
    async createShopifyCharge(shopDomain, accessToken, planId, opts = {}) {
      const plan = PLANS[planId];
      if (!plan) throw new Error(`Unknown plan: ${planId}`);
      if (plan.priceMonthly === 0) throw new Error("Cannot create a charge for a free plan.");

      const domain = String(shopDomain || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
      const base = `https://${domain.endsWith(".myshopify.com") ? domain : domain + ".myshopify.com"}/admin/api/${config.shopifyApiVersion || "2025-01"}`;
      const currency = opts.currency || "USD";
      const price = this.getRegionalPrice(planId, currency).monthly;

      const returnUrl = opts.return_url || config.publicUrl || "https://storecops.com/app";

      const payload = {
        recurring_application_charge: {
          name: `Storecops ${plan.name}`,
          price,
          return_url: returnUrl,
          test: opts.test || false,
          trial_days: 14,
          capped_amount: price,
          terms: `$${price}/month — ${plan.name} plan`,
        },
      };

      const res = await fetch(`${base}/recurring_application_charges.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Shopify charge creation failed (${res.status}): ${JSON.stringify(body.errors || body)}`);
      }

      const { recurring_application_charge: charge } = await res.json();

      // Persist the pending charge so we can reconcile after approval.
      await store.subscriptions.insert({
        shopInstallationId: opts.shopInstallationId || shopDomain,
        planId,
        status: "pending_approval",
        shopifyChargeId: String(charge.id),
        currency,
        price_monthly: price,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      return {
        charge_id: charge.id,
        confirmation_url: charge.confirmation_url,
        status: charge.status,
        plan: planId,
        price,
        currency,
      };
    },

    /**
     * Task 43: Handle the Shopify app_subscriptions/update webhook.
     *
     * Shopify sends this when a charge is accepted, declined, expired,
     * or cancelled. We look up the charge by ID and update the local
     * subscription record accordingly.
     */
    async handleShopifySubscriptionWebhook(payload) {
      const {
        id: charge_id,
        status, // accepted, declined, expired, cancelled, pending
        name,
        shopInstallationId,
      } = payload || {};

      if (!charge_id) throw new Error("charge id is required in webhook payload.");

      // Find the subscription by Shopify charge ID.
      const all = await store.subscriptions.find({});
      const sub = all.find(
        (s) => s.shopifyChargeId === String(charge_id)
      );

      if (!sub) {
        // Charge not tracked locally — could be from a previous install.
        // Create a minimal record so we don't lose the event.
        return store.subscriptions.insert({
          shopInstallationId: shopInstallationId || "unknown",
          planId: "growth",
          status: status === "accepted" ? "active" : status,
          shopifyChargeId: String(charge_id),
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          cancelled_at: status === "cancelled" ? new Date().toISOString() : null,
        });
      }

      const update = {
        status: status === "accepted" ? "active" : status,
        cancelled_at: status === "cancelled" ? new Date().toISOString() : sub.cancelled_at,
        updated_at: new Date().toISOString(),
      };

      return store.subscriptions.update(sub._id, { ...sub, ...update });
    },

    /**
     * Get the current plan/entitlement for a shop installation.
     * Defaults to "starter" if no subscription exists.
     */
    async getEntitlement(shopInstallationId) {
      if (!shopInstallationId) return PLANS.starter;

      const subscription = await store.subscriptions.findOne({
        shopInstallationId,
        status: "active",
      });

      if (!subscription) return { ...PLANS.starter, subscription: null };

      const plan = PLANS[subscription.planId] || PLANS.starter;
      return {
        ...plan,
        subscription: {
          id: subscription._id,
          shopifyChargeId: subscription.shopifyChargeId || null,
          status: subscription.status,
          started_at: subscription.started_at,
          current_period_end: subscription.current_period_end,
        },
      };
    },

    /**
     * Server-side feature gate. Call before executing any premium action.
     * Throws if the feature is not available on the current plan.
     */
    async requireFeature(shopInstallationId, featureName) {
      const entitlement = await this.getEntitlement(shopInstallationId);
      if (!entitlement.features[featureName]) {
        const err = new Error(
          `Feature "${featureName}" requires a plan upgrade. Current plan: ${entitlement.id}.`
        );
        err.code = "FEATURE_LOCKED";
        err.requiredPlan = Object.entries(PLANS).find(
          ([, p]) => p.features[featureName]
        )?.[0];
        throw err;
      }
      return entitlement;
    },

    /**
     * Express middleware: checks entitlement before route handler.
     */
    requireFeatureMiddleware(featureName) {
      return async (req, res, next) => {
        try {
          const shopInstallationId = req.shopInstallationId || req.body?.shopInstallationId;
          if (!shopInstallationId) {
            return res.status(400).json({ error: "shopInstallationId is required." });
          }
          await this.requireFeature(shopInstallationId, featureName);
          next();
        } catch (err) {
          if (err.code === "FEATURE_LOCKED") {
            return res.status(402).json({
              error: err.message,
              code: "FEATURE_LOCKED",
              required_plan: err.requiredPlan,
            });
          }
          next(err);
        }
      };
    },

    /**
     * Record or update a Shopify Billing subscription.
     * Called after Shopify confirms a charge/subscription via webhook or API.
     */
    async upsertSubscription(shopInstallationId, subscriptionData) {
      const existing = await store.subscriptions.findOne({ shopInstallationId });

      const record = {
        shopInstallationId,
        planId: subscriptionData.planId || "growth",
        status: subscriptionData.status || "active", // active, cancelled, expired, past_due
        shopifyChargeId: subscriptionData.shopifyChargeId || null,
        shopifySubscriptionId: subscriptionData.shopifySubscriptionId || null,
        currency: subscriptionData.currency || "USD",
        price_monthly: subscriptionData.price_monthly || PLANS[subscriptionData.planId || "growth"]?.priceMonthly || 0,
        started_at: subscriptionData.started_at || new Date().toISOString(),
        current_period_end: subscriptionData.current_period_end || null,
        cancelled_at: subscriptionData.cancelled_at || null,
        updated_at: new Date().toISOString(),
      };

      if (existing) {
        return store.subscriptions.update(existing._id, record);
      }
      return store.subscriptions.insert(record);
    },

    /**
     * Handle subscription lifecycle events from internal systems
     * or non-Shopify billing webhooks.
     */
    async handleSubscriptionEvent(event) {
      const { shopInstallationId, action, charge_id, status } = event;

      if (!shopInstallationId) throw new Error("shopInstallationId is required.");

      switch (action) {
        case "accepted":
        case "activated":
          return this.upsertSubscription(shopInstallationId, {
            shopifyChargeId: charge_id,
            status: "active",
          });

        case "declined":
        case "expired":
          return this.upsertSubscription(shopInstallationId, {
            shopifyChargeId: charge_id,
            status: action === "declined" ? "past_due" : "expired",
          });

        case "cancelled":
          return this.upsertSubscription(shopInstallationId, {
            shopifyChargeId: charge_id,
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
          });

        default:
          return { handled: false, action };
      }
    },

    /**
     * Get the regional price for a plan in a given currency.
     * Server-side only — frontend must not determine pricing.
     */
    getRegionalPrice(planId, currency = "USD") {
      const region = REGIONAL_PRICING[currency] || REGIONAL_PRICING.USD;
      return {
        plan: planId,
        currency,
        monthly: region[planId] || PLANS[planId]?.priceMonthly || 0,
      };
    },

    /**
     * Check if a shop has an active paid subscription.
     */
    async isPaid(shopInstallationId) {
      const entitlement = await this.getEntitlement(shopInstallationId);
      return entitlement.id !== "starter" && entitlement.subscription?.status === "active";
    },

    /**
     * List all subscriptions for admin/reporting.
     */
    async listSubscriptions({ status } = {}) {
      const filter = status ? { status } : {};
      return store.subscriptions.find(filter);
    },
  };
}

module.exports = { createBillingService, PLANS, REGIONAL_PRICING };
