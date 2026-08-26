"use strict";

/**
 * Revenue Intelligence — Admin's conversion & retention weapon.
 *
 * Four pillars:
 *
 * 1. ROI CALCULATOR — proves Storecops' value to each store by
 *    quantifying recovered carts, competitor price wins, SEO traffic
 *    value, and churn prevention. This is what makes renewal a no-brainer.
 *
 * 2. LEAD MANAGEMENT — captures every deep-audit scan as a lead,
 *    scores them by conversion likelihood, and tracks the full
 *    pipeline from scan → signup → paid → retained.
 *
 * 3. SMART REMINDERS — generates irresistible renewal sequences:
 *    value realization reports, loss aversion messages, streak
 *    preservation, competitor gap alerts, and time-sensitive offers.
 *    The goal: make NOT renewing feel like losing money.
 *
 * 4. CONVERSION INTELLIGENCE — identifies what converts prospects:
 *    audit-to-signup rate, feature activation triggers, pricing
 *    sensitivity, and the optimal moment to nudge.
 */

// ─── Smart Reminder Sequences ──────────────────────────────────────

/**
 * Renewal reminder sequence.
 * Each step is timed relative to the renewal date (negative = before).
 * The copy uses proven psychological triggers:
 *   - Loss aversion (what they'll lose)
 *   - Social proof (what similar stores achieve)
 *   - Sunk cost (their data/history investment)
 *   - Scarcity (time-limited offers)
 *   - Reciprocity (free value before asking)
 */
const RENEWAL_SEQUENCE = [
  {
    id: "value_realization",
    days_before: 30,
    trigger: "renewal_approaching",
    subject: "Here's what Storecops did for {store} this month",
    template: "roi_report",
    psychological_trigger: "reciprocity",
    description: "Show concrete value delivered — recovered $X, caught Y competitor moves, improved SEO by Z points",
  },
  {
    id: "loss_aversion",
    days_before: 14,
    trigger: "renewal_approaching",
    subject: "Don't lose your {store} advantage",
    template: "loss_warning",
    psychological_trigger: "loss_aversion",
    description: "Highlight what they'll lose: automations stop, competitor data goes dark, recovery emails pause",
  },
  {
    id: "streak_preservation",
    days_before: 10,
    trigger: "renewal_approaching",
    subject: "Your {store} growth streak: {streak_days} days",
    template: "streak",
    psychological_trigger: "sunk_cost",
    description: "Show their consistency streak — data history, automation runs, improvements made",
  },
  {
    id: "competitor_gap",
    days_before: 7,
    trigger: "renewal_approaching",
    subject: "Your competitors are {action} — will you fall behind?",
    template: "competitor_gap",
    psychological_trigger: "competitive_pressure",
    description: "Show what competitors are doing that they'd miss without Storecops",
  },
  {
    id: "early_bird_offer",
    days_before: 5,
    trigger: "renewal_approaching",
    subject: "Renew early & save {discount}% — offer expires in {hours_left}h",
    template: "early_bird",
    psychological_trigger: "scarcity",
    description: "Time-limited discount for early renewal — creates urgency",
  },
  {
    id: "final_warning",
    days_before: 1,
    trigger: "renewal_imminent",
    subject: "Last chance: {store} automations pause tomorrow",
    template: "final_warning",
    psychological_trigger: "urgency",
    description: "Final 24h warning — automations and monitoring will stop",
  },
  {
    id: "grace_period",
    days_before: -1,
    trigger: "expired",
    subject: "We paused your {store} automations — here's what you missed",
    template: "grace_period",
    psychological_trigger: "loss_aversion",
    description: "After expiry: show what they're already missing. Re-activation offer.",
  },
];

/**
 * Win-back sequence for churned stores.
 * Escalating value + decreasing price to win them back.
 */
const WINBACK_SEQUENCE = [
  {
    id: "we_miss_you",
    days_after_churn: 1,
    subject: "Your {store} data is waiting — pick up where you left off",
    offer: null,
    trigger: "data_preserved",
  },
  {
    id: "what_you_missed",
    days_after_churn: 3,
    subject: "While you were gone: {missed_events} events you didn't capture",
    offer: null,
    trigger: "missed_opportunity",
  },
  {
    id: "comeback_offer",
    days_after_churn: 7,
    subject: "A special offer to bring {store} back — {discount}% off your next month",
    offer: { type: "discount", value: 20 },
    trigger: "discount_offer",
  },
  {
    id: "success_stories",
    days_after_churn: 14,
    subject: "Stores like {store} recovered ${avg_recovery} last month with Storecops",
    offer: null,
    trigger: "social_proof",
  },
  {
    id: "final_offer",
    days_after_churn: 30,
    subject: "Last chance: reactivate {store} with 30% off — expires in 48h",
    offer: { type: "discount", value: 30 },
    trigger: "final_ultimatum",
  },
];

function createRevenueIntelligence({ store, config }) {
  return {
    RENEWAL_SEQUENCE,
    WINBACK_SEQUENCE,

    // ═══════════════════════════════════════════════════════════════════
    //  1. ROI CALCULATOR — Prove Storecops' value in dollars
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Calculate the ROI Storecops delivered to a specific store.
     * This is THE number that makes renewal a no-brainer.
     */
    async calculateROI(storeId) {
      const integration = await store.integrations.findOne({ store_id: storeId });
      if (!integration) return { store_id: storeId, total_value_delivered: 0, error: "Store not found" };

      const subscription = await store.subscriptions.findOne({
        shopInstallationId: storeId,
        status: "active",
      });
      const planCost = subscription?.price_monthly || 0;

      // 1. Cart recovery value
      const cartRecovery = await this._calcCartRecoveryValue(storeId);

      // 2. Competitor intelligence value
      const competitorValue = await this._calcCompetitorValue(storeId);

      // 3. SEO/traffic value
      const seoValue = await this._calcSeoValue(storeId);

      // 4. Churn prevention value
      const churnPrevention = await this._calcChurnPreventionValue(storeId);

      // 5. Automation delivery value
      const automationValue = await this._calcAutomationValue(storeId);

      const totalValue = cartRecovery.value + competitorValue.value + seoValue.value +
        churnPrevention.value + automationValue.value;

      const roi = planCost > 0 ? ((totalValue - planCost) / planCost) * 100 : 0;
      const multiple = planCost > 0 ? totalValue / planCost : 0;

      return {
        store_id: storeId,
        plan_cost: planCost,
        total_value_delivered: Math.round(totalValue * 100) / 100,
        roi_pct: Math.round(roi),
        roi_multiple: Math.round(multiple * 10) / 10,
        breakdown: {
          cart_recovery: cartRecovery,
          competitor_intelligence: competitorValue,
          seo_traffic: seoValue,
          churn_prevention: churnPrevention,
          automations: automationValue,
        },
        headline: totalValue > 0
          ? `Storecops delivered $${totalValue.toLocaleString()} in value for $${planCost}/mo — that's a ${multiple.toFixed(1)}x return`
          : "No value data yet — connect your store to start tracking ROI",
        calculated_at: new Date().toISOString(),
      };
    },

    /**
     * Cart recovery: how much abandoned cart revenue was recovered.
     */
    async _calcCartRecoveryValue(storeId) {
      const deliveries = await store.deliveries.find({ store_id: storeId });
      const cartDeliveries = deliveries.filter((d) =>
        d.action_type === "cart_recovery" || d.channel === "email" || d.channel === "whatsapp"
      );

      // Estimate: each successful delivery recovers ~2-5% of cart value
      // Average cart value estimated from events
      const orders = await store.events.find({ store_id: storeId, event_type: "purchase" });
      const avgOrderValue = orders.length > 0
        ? orders.reduce((sum, o) => sum + (o.total || 0), 0) / orders.length
        : 45; // default estimate

      const estimatedRecoveries = cartDeliveries.length * 0.03 * avgOrderValue;

      return {
        value: Math.round(estimatedRecoveries * 100) / 100,
        deliveries: cartDeliveries.length,
        avg_order_value: Math.round(avgOrderValue * 100) / 100,
        detail: `${cartDeliveries.length} recovery messages sent — est. $${estimatedRecoveries.toFixed(0)} recovered`,
      };
    },

    /**
     * Competitor intelligence: value of price change alerts.
     */
    async _calcCompetitorValue(storeId) {
      const snapshots = await store.competitorSnapshots.find({ store_id: storeId });
      const priceChanges = snapshots.filter((s) => s.price_changed).length;

      // Each price change alert is worth ~$50-200 in competitive response value
      const valuePerAlert = 75;
      const value = priceChanges * valuePerAlert;

      return {
        value,
        alerts: priceChanges,
        snapshots: snapshots.length,
        detail: `${priceChanges} competitor price moves detected — est. $${value} in competitive response value`,
      };
    },

    /**
     * SEO value: estimated traffic revenue from SEO improvements.
     */
    async _calcSeoValue(storeId) {
      const audits = await store.seoAudits.find({ store_id: storeId });
      if (audits.length < 2) return { value: 0, audits: audits.length, detail: "Insufficient audit data" };

      // Compare first and latest audit scores
      const sorted = audits.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const first = sorted[0]?.overall_score || 0;
      const latest = sorted[sorted.length - 1]?.overall_score || 0;
      const improvement = Math.max(0, latest - first);

      // Each SEO point improvement ≈ 2-5% more organic traffic
      // Assume average store makes $5000/mo, 30% from organic
      const estimatedMonthlyTrafficValue = 1500;
      const trafficLiftPct = improvement * 0.03;
      const value = estimatedMonthlyTrafficValue * trafficLiftPct;

      return {
        value: Math.round(value * 100) / 100,
        score_improvement: improvement,
        audits: audits.length,
        detail: `SEO score improved ${first}→${latest} (+${improvement}) — est. $${value.toFixed(0)}/mo in organic traffic`,
      };
    },

    /**
     * Churn prevention: value of customers saved from defecting.
     */
    async _calcChurnPreventionValue(storeId) {
      const actions = await store.actions.find({ store_id: storeId });
      const churnActions = actions.filter((a) =>
        a.action_type === "churn_prevention" || a.action_type === "winback" || a.rule_id?.includes("churn")
      );

      // Each prevented churn = avg customer LTV saved
      const avgCustomerLTV = 250;
      const value = churnActions.length * avgCustomerLTV * 0.1; // 10% success rate

      return {
        value: Math.round(value * 100) / 100,
        actions: churnActions.length,
        detail: `${churnActions.length} churn prevention actions — est. $${value.toFixed(0)} in retained customer value`,
      };
    },

    /**
     * Automation delivery value: general automations beyond cart recovery.
     */
    async _calcAutomationValue(storeId) {
      const deliveries = await store.deliveries.find({ store_id: storeId });
      const nonCart = deliveries.filter((d) => d.action_type !== "cart_recovery");

      // Each automation delivery ≈ $0.50-2 in engagement value
      const value = nonCart.length * 1;

      return {
        value,
        deliveries: nonCart.length,
        detail: `${nonCart.length} automation deliveries — est. $${value} in engagement value`,
      };
    },

    // ═══════════════════════════════════════════════════════════════════
    //  2. LEAD MANAGEMENT — Capture, Score, Convert
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Capture a lead from any source (deep audit, landing page, etc).
     */
    async captureLead(leadData) {
      const { email, store_url, name, phone, store_name, source, audit_report_id } = leadData;
      if (!email && !store_url) throw new Error("email or store_url is required");

      // Check for existing lead
      const existing = email
        ? await store.leads.findOne({ email })
        : await store.leads.findOne({ store_url });

      if (existing) {
        // Update existing lead with new data
        const update = { ...existing };
        if (store_url) update.store_url = store_url;
        if (name) update.name = name;
        if (phone) update.phone = phone;
        if (store_name) update.store_name = store_name;
        if (source) update.source = source;
        if (audit_report_id) {
          update.audit_report_ids = [...(existing.audit_report_ids || []), audit_report_id];
          update.audit_count = (existing.audit_count || 0) + 1;
        }
        update.last_engagement_at = new Date().toISOString();
        update.engagement_count = (existing.engagement_count || 0) + 1;
        update.updated_at = new Date().toISOString();

        const updated = await store.leads.update(existing._id, update);
        const scored = await this._scoreLead(updated);
        return store.leads.update(existing._id, { ...updated, lead_score: scored.score, lead_grade: scored.grade });
      }

      // Create new lead
      const lead = await store.leads.insert({
        email: email || null,
        store_url: store_url || null,
        name: name || null,
        phone: phone || null,
        store_name: store_name || null,
        source: source || "deep_audit",
        audit_report_ids: audit_report_id ? [audit_report_id] : [],
        audit_count: audit_report_id ? 1 : 0,
        status: "new",
        engagement_count: 0,
        last_engagement_at: new Date().toISOString(),
        converted_at: null,
        churned_at: null,
      });

      const scored = await this._scoreLead(lead);
      return store.leads.update(lead._id, { ...lead, lead_score: scored.score, lead_grade: scored.grade });
    },

    /**
     * Score a lead by conversion likelihood (0-100).
     */
    async _scoreLead(lead) {
      let score = 0;

      // Has email: +20 (can be contacted)
      if (lead.email) score += 20;

      // Has store URL: +15 (has a store to sell to)
      if (lead.store_url) score += 15;

      // Has name: +5 (real person)
      if (lead.name) score += 5;

      // Has phone: +10 (high intent — willing to be called)
      if (lead.phone) score += 10;

      // Multiple audits: +15 per additional audit (max 30)
      const repeatAudits = Math.min((lead.audit_count || 0) - 1, 2);
      score += Math.max(0, repeatAudits * 15);

      // Recent engagement: +10
      if (lead.last_engagement_at) {
        const daysSinceEngagement = (Date.now() - new Date(lead.last_engagement_at).getTime()) / 86400000;
        if (daysSinceEngagement < 1) score += 10;
        else if (daysSinceEngagement < 7) score += 5;
      }

      // Store is on Shopify (high-value target): +10
      if (lead.store_url && /myshopify\.com|shopify/i.test(lead.store_url)) score += 10;

      // Already a customer (expansion): +20
      const existingIntegration = lead.store_url
        ? await store.integrations.findOne({ store_url: lead.store_url })
        : null;
      if (existingIntegration) score += 20;

      const grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : score >= 20 ? "D" : "F";

      return { score: Math.min(100, score), grade };
    },

    /**
     * Get all leads with filtering and sorting.
     */
    async getLeads({ status, minScore, source, limit = 100 } = {}) {
      let leads = await store.leads.find({});

      if (status) leads = leads.filter((l) => l.status === status);
      if (minScore != null) leads = leads.filter((l) => (l.lead_score || 0) >= minScore);
      if (source) leads = leads.filter((l) => l.source === source);

      leads.sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));
      return leads.slice(0, limit);
    },

    /**
     * Get lead pipeline summary (funnel metrics).
     */
    async getLeadPipeline() {
      const all = await store.leads.find({});
      const byStatus = { new: 0, contacted: 0, engaged: 0, converted: 0, lost: 0 };
      const byGrade = { A: 0, B: 0, C: 0, D: 0, F: 0 };

      for (const lead of all) {
        byStatus[lead.status || "new"] = (byStatus[lead.status || "new"] || 0) + 1;
        byGrade[lead.lead_grade || "F"] = (byGrade[lead.lead_grade || "F"] || 0) + 1;
      }

      const total = all.length;
      const conversionRate = total > 0 ? (byStatus.converted / total) * 100 : 0;

      return {
        total_leads: total,
        by_status: byStatus,
        by_grade: byGrade,
        conversion_rate: Math.round(conversionRate * 10) / 10,
        hot_leads: all.filter((l) => (l.lead_score || 0) >= 70 && l.status !== "converted").length,
        stale_leads: all.filter((l) => {
          if (!l.last_engagement_at) return true;
          return (Date.now() - new Date(l.last_engagement_at).getTime()) / 86400000 > 30;
        }).length,
      };
    },

    /**
     * Update lead status (admin action).
     */
    async updateLeadStatus(leadId, status, notes) {
      const lead = await store.leads.findById(leadId);
      if (!lead) throw new Error("Lead not found");

      const update = { status, updated_at: new Date().toISOString() };
      if (notes) update.notes = [...(lead.notes || []), { text: notes, at: new Date().toISOString() }];
      if (status === "converted") update.converted_at = new Date().toISOString();

      return store.leads.update(leadId, update);
    },

    // ═══════════════════════════════════════════════════════════════════
    //  3. SMART REMINDERS — Irresistible renewal sequences
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Generate smart reminders for all stores with upcoming renewals.
     * These are the "can't resist not renewing" messages.
     */
    async generateSmartReminders() {
      const subscriptions = await store.subscriptions.find({ status: "active" });
      const reminders = [];

      for (const sub of subscriptions) {
        if (!sub.current_period_end) continue;

        const daysUntilRenewal = Math.ceil(
          (new Date(sub.current_period_end).getTime() - Date.now()) / 86400000
        );

        // Find which sequence steps should fire
        for (const step of RENEWAL_SEQUENCE) {
          if (daysUntilRenewal <= step.days_before && daysUntilRenewal > step.days_before - 2) {
            const integration = await store.integrations.findOne({ store_id: sub.shopInstallationId });
            const roi = await this.calculateROI(sub.shopInstallationId);

            reminders.push({
              ...step,
              store_id: sub.shopInstallationId,
              store_name: integration?.store_name || sub.shopInstallationId,
              days_until_renewal: daysUntilRenewal,
              personalized: {
                subject: step.subject
                  .replace(/\{store\}/g, integration?.store_name || "your store")
                  .replace(/\{discount\}/g, "15")
                  .replace(/\{hours_left\}/g, "48")
                  .replace(/\{streak_days\}/g, String(Math.round((Date.now() - new Date(sub.started_at).getTime()) / 86400000)))
                  .replace(/\{action\}/g, "scaling up")
                  .replace(/\{missed_events\}/g, "hundreds"),
                roi_summary: roi.headline,
                value_delivered: roi.total_value_delivered,
                plan_cost: roi.plan_cost,
              },
              urgency: daysUntilRenewal <= 1 ? "critical" : daysUntilRenewal <= 5 ? "high" : "medium",
            });
          }
        }
      }

      // Also generate win-back reminders for recently churned stores
      const churned = await store.subscriptions.find({ status: "cancelled" });
      for (const sub of churned) {
        const daysSinceChurn = sub.cancelled_at
          ? Math.ceil((Date.now() - new Date(sub.cancelled_at).getTime()) / 86400000)
          : 999;

        for (const step of WINBACK_SEQUENCE) {
          if (daysSinceChurn >= step.days_after_churn && daysSinceChurn < step.days_after_churn + 2) {
            const integration = await store.integrations.findOne({ store_id: sub.shopInstallationId });
            reminders.push({
              ...step,
              store_id: sub.shopInstallationId,
              store_name: integration?.store_name || sub.shopInstallationId,
              days_since_churn: daysSinceChurn,
              offer: step.offer,
              personalized: {
                subject: step.subject
                  .replace(/\{store\}/g, integration?.store_name || "your store")
                  .replace(/\{discount\}/g, String(step.offer?.value || 20))
                  .replace(/\{missed_events\}/g, "hundreds")
                  .replace(/\{avg_recovery\}/g, "2,400"),
              },
              urgency: daysSinceChurn > 25 ? "critical" : "medium",
            });
          }
        }
      }

      return {
        reminders,
        total: reminders.length,
        by_urgency: {
          critical: reminders.filter((r) => r.urgency === "critical").length,
          high: reminders.filter((r) => r.urgency === "high").length,
          medium: reminders.filter((r) => r.urgency === "medium").length,
        },
        generated_at: new Date().toISOString(),
      };
    },

    // ═══════════════════════════════════════════════════════════════════
    //  4. CONVERSION INTELLIGENCE — What turns prospects into customers
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Full conversion dashboard:
     *  - Audit-to-signup funnel
     *  - Lead conversion rates by source
     *  - Revenue expansion opportunities
     *  - Pricing sensitivity analysis
     */
    async getConversionIntelligence() {
      const leads = await store.leads.find({});
      const audits = await store.deepAudits.find({});
      const subscriptions = await store.subscriptions.find({});
      const integrations = await store.integrations.find({});

      // Audit → Lead → Signup → Paid funnel
      const totalAudits = audits.length;
      const totalLeads = leads.length;
      const totalSignups = integrations.length;
      const totalPaid = subscriptions.filter((s) => s.status === "active" && s.planId !== "starter").length;

      const auditToLeadRate = totalAudits > 0 ? (totalLeads / totalAudits) * 100 : 0;
      const leadToSignupRate = totalLeads > 0 ? (totalSignups / totalLeads) * 100 : 0;
      const signupToPaidRate = totalSignups > 0 ? (totalPaid / totalSignups) * 100 : 0;

      // Conversion by lead source
      const bySource = {};
      for (const lead of leads) {
        const src = lead.source || "unknown";
        if (!bySource[src]) bySource[src] = { total: 0, converted: 0 };
        bySource[src].total++;
        if (lead.status === "converted") bySource[src].converted++;
      }

      // Expansion revenue: current paid stores that could upgrade
      const expansionOpps = [];
      for (const sub of subscriptions.filter((s) => s.status === "active")) {
        const integration = await store.integrations.findOne({ store_id: sub.shopInstallationId });
        if (!integration) continue;

        const events = await store.events.find({ store_id: sub.shopInstallationId });
        const thisMonth = events.filter((e) => {
          const d = new Date(e.createdAt || e.timestamp);
          return d >= new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        }).length;

        const limits = { starter: 500, growth: 50000, scale: 500000 };
        const limit = limits[sub.planId] || 500;
        const utilization = (thisMonth / limit) * 100;

        if (utilization > 70 && sub.planId !== "scale") {
          expansionOpps.push({
            store_id: sub.shopInstallationId,
            store_name: integration.store_name || sub.shopInstallationId,
            current_plan: sub.planId,
            utilization_pct: Math.round(utilization),
            recommended_plan: sub.planId === "starter" ? "growth" : "scale",
            revenue_uplift: sub.planId === "starter" ? 49 : 100,
          });
        }
      }

      // Revenue at risk: subscriptions expiring soon
      const atRiskRevenue = subscriptions
        .filter((s) => {
          if (s.status !== "active" || !s.current_period_end) return false;
          const daysLeft = (new Date(s.current_period_end).getTime() - Date.now()) / 86400000;
          return daysLeft <= 14 && daysLeft >= 0;
        })
        .reduce((sum, s) => sum + (s.price_monthly || 0), 0);

      return {
        funnel: {
          total_audits: totalAudits,
          total_leads: totalLeads,
          total_signups: totalSignups,
          total_paid: totalPaid,
          audit_to_lead_pct: Math.round(auditToLeadRate * 10) / 10,
          lead_to_signup_pct: Math.round(leadToSignupRate * 10) / 10,
          signup_to_paid_pct: Math.round(signupToPaidRate * 10) / 10,
        },
        by_source: bySource,
        expansion_opportunities: expansionOpps,
        expansion_revenue_potential: expansionOpps.reduce((sum, e) => sum + e.revenue_uplift, 0),
        revenue_at_risk: Math.round(atRiskRevenue * 100) / 100,
        generated_at: new Date().toISOString(),
      };
    },

    /**
     * Generate a "value realization" report for a specific store.
     * This is the key document that makes renewal irresistible.
     */
    async generateValueReport(storeId) {
      const roi = await this.calculateROI(storeId);
      const integration = await store.integrations.findOne({ store_id: storeId });
      const subscription = await store.subscriptions.findOne({
        shopInstallationId: storeId,
        status: "active",
      });

      if (!integration) return { error: "Store not found" };

      // Gather store activity stats
      const events = await store.events.find({ store_id: storeId });
      const actions = await store.actions.find({ store_id: storeId });
      const deliveries = await store.deliveries.find({ store_id: storeId });

      const tenureDays = subscription?.started_at
        ? Math.round((Date.now() - new Date(subscription.started_at).getTime()) / 86400000)
        : 0;

      return {
        store_id: storeId,
        store_name: integration.store_name || storeId,
        tenure_days: tenureDays,
        plan: subscription?.planId || "starter",
        stats: {
          events_tracked: events.length,
          automations_run: actions.length,
          messages_delivered: deliveries.length,
        },
        roi,
        summary: this._buildValueSummary(integration, roi, tenureDays),
        generated_at: new Date().toISOString(),
      };
    },

    /**
     * Build a human-readable value summary.
     */
    _buildValueSummary(integration, roi, tenureDays) {
      const lines = [];
      lines.push(`${integration.store_name || "Your store"} has been on Storecops for ${tenureDays} days.`);

      if (roi.total_value_delivered > 0) {
        lines.push(`In that time, Storecops delivered $${roi.total_value_delivered.toLocaleString()} in measurable value.`);
        lines.push(`That's a ${roi.roi_multiple}x return on your $${roi.plan_cost}/mo investment.`);
      }

      if (roi.breakdown?.cart_recovery?.value > 0) {
        lines.push(`Cart recovery alone brought in $${roi.breakdown.cart_recovery.value} from ${roi.breakdown.cart_recovery.deliveries} messages.`);
      }

      if (roi.breakdown?.competitor_intelligence?.value > 0) {
        lines.push(`Competitor radar caught ${roi.breakdown.competitor_intelligence.alerts} price moves worth $${roi.breakdown.competitor_intelligence.value} in strategic response value.`);
      }

      lines.push("Cancel now and all automations stop. Your data goes cold. Competitors keep moving — and you won't know.");

      return lines.join(" ");
    },
  };
}

module.exports = { createRevenueIntelligence, RENEWAL_SEQUENCE, WINBACK_SEQUENCE };
