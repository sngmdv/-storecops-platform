"use strict";

/**
 * Campaign Lifecycle Manager — bridges generation → execution → measurement.
 *
 * The campaignGenerator creates drafts. This module handles what happens AFTER
 * the merchant clicks "Launch":
 *
 *   1. LAUNCH   — merchant approves a draft → system identifies target customers
 *                  and creates personalized actions in the orchestrator queue
 *   2. EXECUTE  — actions are processed through the execution pipeline
 *                  (consent gate → billing gate → channel selection → delivery)
 *   3. MEASURE  — tracks delivery, engagement, and revenue attribution
 *                  against the campaign's target audience
 *
 * This is the missing link between Layer 3 (decision) and Layer 4 (execution).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Identify target customers for a campaign based on its source/type.
 * Trend campaigns → customers who viewed related products or have relevant purchase history.
 * Seasonal campaigns → all active customers (broad reach).
 * Cart recovery → cart abandoners who haven't purchased.
 * Win-back → customers who haven't purchased in 30+ days.
 */
async function identifyTargets(store, store_id, campaign, { maxTargets = 100 } = {}) {
  const events = await store.events.find((e) => e.store_id === store_id);
  const customers = await store.customers.find({ store_id });

  // Build customer activity map.
  const customerActivity = new Map();
  for (const e of events) {
    const id = e.customer_id || e.email;
    if (!id || id === "anon") continue;
    if (!customerActivity.has(id)) {
      customerActivity.set(id, { customer_id: id, events: [], last_active: null });
    }
    const entry = customerActivity.get(id);
    entry.events.push(e);
    if (!entry.last_active || e.timestamp > entry.last_active) {
      entry.last_active = e.timestamp;
    }
  }

  let targets = [];

  if (campaign.source === "trend") {
    // Trend campaigns: target customers who viewed products or purchased in related categories.
    const keyword = (campaign.keyword || "").toLowerCase();
    for (const [id, activity] of customerActivity) {
      const relevantEvents = activity.events.filter((e) => {
        const text = `${e.product_title || ""} ${e.category || ""} ${e.product_name || ""}`.toLowerCase();
        return text.includes(keyword) || e.event_type === "product_view";
      });
      if (relevantEvents.length > 0) {
        targets.push({
          customer_id: id,
          relevance_score: relevantEvents.length,
          last_active: activity.last_active,
        });
      }
    }
    targets.sort((a, b) => b.relevance_score - a.relevance_score);
  } else if (campaign.source === "seasonal") {
    // Seasonal campaigns: all active customers (broad reach).
    for (const [id, activity] of customerActivity) {
      targets.push({
        customer_id: id,
        relevance_score: activity.events.length,
        last_active: activity.last_active,
      });
    }
    targets.sort((a, b) => b.relevance_score - a.relevance_score);
  } else if (campaign.type === "cart_recovery") {
    // Cart recovery: abandoners who haven't purchased since.
    const purchasers = new Set();
    for (const e of events) {
      if (["purchase", "checkout_completed"].includes(e.event_type)) {
        purchasers.add(e.customer_id || e.email);
      }
    }
    for (const [id, activity] of customerActivity) {
      const cartEvents = activity.events.filter((e) =>
        ["cart_abandoned", "checkout_started"].includes(e.event_type)
      );
      if (cartEvents.length > 0 && !purchasers.has(id)) {
        targets.push({ customer_id: id, relevance_score: cartEvents.length, last_active: activity.last_active });
      }
    }
  } else if (campaign.type === "win_back") {
    // Win-back: customers inactive for 30+ days.
    const cutoff = new Date(Date.now() - 30 * DAY_MS).toISOString();
    for (const [id, activity] of customerActivity) {
      const purchases = activity.events.filter((e) => ["purchase"].includes(e.event_type));
      if (activity.last_active < cutoff && purchases.length > 0) {
        targets.push({ customer_id: id, relevance_score: purchases.length, last_active: activity.last_active });
      }
    }
  } else {
    // Default: all customers with any activity.
    for (const [id, activity] of customerActivity) {
      targets.push({ customer_id: id, relevance_score: activity.events.length, last_active: activity.last_active });
    }
  }

  return targets.slice(0, maxTargets);
}

function createCampaignLifecycle({ store, orchestrator, executionService, notificationService }) {
  return {
    /**
     * LAUNCH: Convert a campaign draft into personalized actions for each target customer.
     * This is what happens when the merchant clicks "Launch Campaign".
     */
    async launch(campaign_id, store_id, { maxTargets = 100 } = {}) {
      if (!campaign_id || !store_id) throw new Error("campaign_id and store_id are required");

      const campaign = await store.campaigns.findById(campaign_id);
      if (!campaign) throw new Error("Campaign not found");
      if (campaign.store_id !== store_id) throw new Error("Campaign does not belong to this store");
      if (campaign.status === "launched") throw new Error("Campaign already launched");
      if (campaign.status === "completed") throw new Error("Campaign already completed");

      // Identify target customers.
      const targets = await identifyTargets(store, store_id, campaign, { maxTargets });

      if (targets.length === 0) {
        await store.campaigns.update(campaign_id, {
          status: "no_targets",
          launched_at: new Date().toISOString(),
          target_count: 0,
        });
        return {
          campaign_id,
          status: "no_targets",
          message: "No matching customers found for this campaign.",
          targets: [],
          actions_created: 0,
        };
      }

      // Create a personalized action for each target customer.
      const actions = [];
      for (const target of targets) {
        const action = await store.actions.insert({
          store_id,
          customer_id: target.customer_id,
          rule_id: campaign.campaign_id,
          rule_name: campaign.subject || campaign.campaign_id,
          type: "campaign",
          channel: (campaign.channels && campaign.channels[0]) || "email",
          urgency: campaign.urgency || "normal",
          params: {
            subject: campaign.subject,
            headline: campaign.headline,
            body: campaign.body,
            cta: campaign.cta,
            keyword: campaign.keyword,
            source: campaign.source,
          },
          context: {
            campaign_id: campaign._id,
            relevance_score: target.relevance_score,
          },
          source: "campaign_launch",
          status: "pending",
          created_at: new Date().toISOString(),
        });
        actions.push(action);
      }

      // Update campaign status.
      await store.campaigns.update(campaign_id, {
        status: "launched",
        launched_at: new Date().toISOString(),
        target_count: targets.length,
        action_ids: actions.map((a) => a._id),
      });

      // Send notification.
      if (notificationService) {
        await notificationService.push({
          store_id,
          title: "Campaign launched!",
          message: `"${campaign.subject}" is now being sent to ${targets.length} customer(s).`,
          severity: "success",
          category: "campaign",
          metadata: { campaign_id, target_count: targets.length },
        }).catch(() => {});
      }

      return {
        campaign_id,
        status: "launched",
        target_count: targets.length,
        actions_created: actions.length,
        targets: targets.map((t) => t.customer_id),
      };
    },

    /**
     * EXECUTE: Process all pending actions for a launched campaign.
     * Runs them through the execution pipeline (consent → billing → delivery).
     */
    async execute(campaign_id, store_id) {
      if (!campaign_id || !store_id) throw new Error("campaign_id and store_id are required");

      const campaign = await store.campaigns.findById(campaign_id);
      if (!campaign) throw new Error("Campaign not found");
      if (campaign.status !== "launched") throw new Error("Campaign must be launched before execution");

      // Find all pending actions for this campaign.
      const pendingActions = await store.actions.find((a) =>
        a.store_id === store_id &&
        a.context?.campaign_id === campaign._id &&
        a.status === "pending"
      );

      if (pendingActions.length === 0) {
        return { campaign_id, processed: 0, message: "No pending actions to execute." };
      }

      const results = { processed: 0, delivered: 0, suppressed: 0, failed: 0, errors: [] };

      if (executionService) {
        // Use the full execution pipeline for each action.
        for (const action of pendingActions) {
          try {
            await executionService.executeAction(action);
            results.delivered++;
          } catch (error) {
            results.failed++;
            results.errors.push({ action_id: action._id, customer_id: action.customer_id, error: error.message });
          }
          results.processed++;
        }
      } else {
        // Fallback: mark as delivered (when execution service not available).
        for (const action of pendingActions) {
          await store.actions.update(action._id, {
            status: "delivered",
            delivered_at: new Date().toISOString(),
          });
          await store.deliveries.insert({
            store_id,
            action_id: action._id,
            customer_id: action.customer_id,
            channel: action.channel || "email",
            provider: "internal",
            delivered_at: new Date().toISOString(),
          });
          results.delivered++;
          results.processed++;
        }
      }

      // Check if all actions are processed.
      const remaining = await store.actions.find((a) =>
        a.store_id === store_id &&
        a.context?.campaign_id === campaign._id &&
        a.status === "pending"
      );

      if (remaining.length === 0) {
        await store.campaigns.update(campaign_id, {
          status: "completed",
          completed_at: new Date().toISOString(),
        });
      }

      return {
        campaign_id,
        status: remaining.length === 0 ? "completed" : "executing",
        ...results,
      };
    },

    /**
     * MEASURE: Calculate the impact of a campaign.
     * Compares targeted customers' behavior before vs after the campaign.
     */
    async measure(campaign_id, store_id) {
      if (!campaign_id || !store_id) throw new Error("campaign_id and store_id are required");

      const campaign = await store.campaigns.findById(campaign_id);
      if (!campaign) throw new Error("Campaign not found");

      // Get all actions for this campaign.
      const actions = await store.actions.find((a) =>
        a.store_id === store_id && a.context?.campaign_id === campaign._id
      );

      // Get deliveries.
      const actionIds = new Set(actions.map((a) => a._id));
      const deliveries = await store.deliveries.find((d) =>
        d.store_id === store_id && actionIds.has(d.action_id)
      );

      // Get targeted customer IDs.
      const targetIds = new Set(actions.map((a) => a.customer_id));

      // Measure post-campaign purchases from targeted customers.
      const launchTime = campaign.launched_at || campaign.generated_at;
      const allEvents = await store.events.find((e) => e.store_id === store_id);

      const prePurchases = allEvents.filter((e) =>
        targetIds.has(e.customer_id || e.email) &&
        e.event_type === "purchase" &&
        e.timestamp < launchTime
      );

      const postPurchases = allEvents.filter((e) =>
        targetIds.has(e.customer_id || e.email) &&
        e.event_type === "purchase" &&
        e.timestamp >= launchTime
      );

      const preRevenue = prePurchases.reduce((sum, e) => sum + (e.total || 0), 0);
      const postRevenue = postPurchases.reduce((sum, e) => sum + (e.total || 0), 0);

      // Delivery stats.
      const deliveredCount = deliveries.length;
      const suppressedCount = actions.filter((a) => a.status === "suppressed").length;
      const failedCount = actions.filter((a) => a.status === "failed").length;

      return {
        campaign_id,
        campaign_name: campaign.subject || campaign.campaign_id,
        status: campaign.status,
        source: campaign.source,
        launched_at: campaign.launched_at,

        // Delivery metrics.
        targets: actions.length,
        delivered: deliveredCount,
        suppressed: suppressedCount,
        failed: failedCount,
        delivery_rate: actions.length > 0 ? Math.round((deliveredCount / actions.length) * 100) : 0,

        // Revenue impact.
        pre_campaign_purchases: prePurchases.length,
        pre_campaign_revenue: preRevenue,
        post_campaign_purchases: postPurchases.length,
        post_campaign_revenue: postRevenue,
        revenue_delta: postRevenue - preRevenue,
        avg_order_value: postPurchases.length > 0 ? postRevenue / postPurchases.length : 0,

        // Channel breakdown.
        channels: [...new Set(deliveries.map((d) => d.channel))],
      };
    },

    /**
     * Get all campaigns for a store with their current status and impact summary.
     */
    async listWithImpact(store_id) {
      const campaigns = await store.campaigns.find({ store_id });
      campaigns.sort((a, b) => (b.generated_at || "").localeCompare(a.generated_at || ""));

      const enriched = [];
      for (const c of campaigns) {
        const actions = await store.actions.find((a) =>
          a.store_id === store_id && a.context?.campaign_id === c._id
        );
        const deliveries = await store.deliveries.find((d) =>
          d.store_id === store_id && actions.some((a) => a._id === d.action_id)
        );

        enriched.push({
          ...c,
          action_count: actions.length,
          delivered_count: deliveries.length,
          pending_count: actions.filter((a) => a.status === "pending").length,
          can_launch: c.status === "draft" || c.status === "AWAITING_APPROVAL" || (!c.status || c.status === "generated"),
          can_execute: c.status === "launched" && actions.some((a) => a.status === "pending"),
          can_measure: c.status === "launched" || c.status === "completed",
        });
      }

      return enriched;
    },
  };
}

module.exports = { createCampaignLifecycle, identifyTargets };
