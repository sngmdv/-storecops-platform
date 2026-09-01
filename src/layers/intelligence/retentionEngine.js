'use strict';

/**
 * Retention Engine — Admin's revenue protection command center.
 *
 * Reasoning & modern SaaS retention tactics baked in:
 *
 * 1. HEALTH SCORING (0-100) — weighted composite of 6 engagement signals.
 *    Each signal is normalized to 0-100 then multiplied by its weight.
 *    Weights are tuned so that *usage* matters more than *presence*.
 *
 * 2. CHURN PREDICTION — maps health score + trend + tenure into risk bands.
 *    A store that was healthy but is declining fast is riskier than one
 *    that was always low. Trend direction matters.
 *
 * 3. INTERVENTION RECOMMENDATIONS — for each at-risk store, the engine
 *    recommends a specific, actionable intervention based on WHY they're
 *    at risk (not just that they are). Modern retention research shows
 *    that targeted interventions outperform generic "we miss you" emails.
 *
 * 4. REVENUE ANALYTICS — MRR, churn rate, expansion revenue, LTV, NRR.
 *    These are the metrics investors and operators care about.
 *
 * 5. AUTOMATED RETENTION FLOWS — the engine generates intervention
 *    campaigns that the admin can trigger: value realization emails,
 *    upgrade nudges, win-back offers, success story shares.
 *
 * 6. UPGRADE PATHING — identifies free/starter stores that are hitting
 *    limits and are prime candidates for conversion to paid plans.
 */

const WEIGHTS = {
  feature_adoption: 0.25,
  engagement_recency: 0.20,
  data_freshness: 0.20,
  plan_utilization: 0.15,
  growth_trajectory: 0.10,
  automation_activity: 0.10,
};

const RISK_BANDS = {
  CRITICAL: { min: 0, max: 25, color: 'red', label: 'Critical — churn imminent', },
  HIGH: { min: 26, max: 45, color: 'red', label: 'High — declining engagement', },
  MEDIUM: { min: 46, max: 65, color: 'amber', label: 'Medium — needs attention', },
  LOW: { min: 66, max: 80, color: 'green', label: 'Low — healthy usage', },
  THRIVING: { min: 81, max: 100, color: 'green', label: 'Thriving — power user', },
};

/**
 * Intervention templates keyed by churn reason.
 * Each has a channel, subject line pattern, and urgency level.
 */
const INTERVENTION_TEMPLATES = {
  low_feature_adoption: {
    id: 'value_realization',
    channel: 'email',
    urgency: 'high',
    subject: 'You\'re missing {feature} — here\'s how it grows stores',
    body: 'Hi {name}, your store {store} has {plan} access but hasn\'t tried {feature} yet. Stores using it see 34% more revenue in 60 days. Want a 2-min walkthrough?',
    cta: 'Show me how',
  },
  low_engagement: {
    id: 're_engagement',
    channel: 'email',
    urgency: 'medium',
    subject: 'Your store {store} — {days} days since last check-in',
    body: 'Hi {name}, we noticed you haven\'t logged into Storecops in {days} days. Your competitors are being tracked 24/7 — here\'s what changed while you were away.',
    cta: 'See what I missed',
  },
  data_stale: {
    id: 'sync_nudge',
    channel: 'email',
    urgency: 'high',
    subject: 'Your store data is {days} days old — let\'s reconnect',
    body: 'Hi {name}, Storecops hasn\'t received data from {store} in {days} days. Your automations are paused and you\'re missing recovery opportunities. One click to reconnect.',
    cta: 'Reconnect now',
  },
  plan_limit_hit: {
    id: 'upgrade_nudge',
    channel: 'email',
    urgency: 'medium',
    subject: 'You hit your {plan} limit — {pct}% upgrade discount inside',
    body: 'Hi {name}, your store {store} processed {events} events this month, which exceeds your {plan} plan limit. Upgrade to {next_plan} to keep all automations running + get {next_feature}.',
    cta: 'Upgrade now',
  },
  declining_revenue: {
    id: 'success_story',
    channel: 'email',
    urgency: 'medium',
    subject: 'How {similar_store} recovered $12k in abandoned carts last month',
    body: 'Hi {name}, stores like yours in {vertical} are recovering 15-20% of abandoned carts with Storecops automations. Here\'s the exact playbook.',
    cta: 'See the playbook',
  },
  trial_expiring: {
    id: 'trial_conversion',
    channel: 'email',
    urgency: 'critical',
    subject: 'Your Storecops trial ends in {days} days — don\'t lose your data',
    body: 'Hi {name}, your {plan} trial for {store} ends in {days} days. You\'ve tracked {events} events and recovered {recovered} in carts. Upgrade now to keep everything running.',
    cta: 'Keep my store growing',
  },
  renewal_upcoming: {
    id: 'renewal_reminder',
    channel: 'email',
    urgency: 'medium',
    subject: 'Your Storecops plan renews in {days} days — here\'s your ROI',
    body: 'Hi {name}, your {plan} plan for {store} renews on {date}. This period: Storecops recovered ${recovered} in abandoned carts, caught {competitor_changes} competitor price moves, and improved your SEO score by {seo_delta} points.',
    cta: 'View my ROI report',
  },
  expansion_opportunity: {
    id: 'expansion_nudge',
    channel: 'email',
    urgency: 'low',
    subject: 'Unlock {feature} for {store} — stores like yours see 2x ROI',
    body: 'Hi {name}, based on your usage patterns, we think {store} would benefit from {feature}. Stores on {next_plan} using it average ${avg_lift} more monthly revenue.',
    cta: 'Explore {next_plan}',
  },
};

function createRetentionEngine({ store, config, },) {
  return {
    WEIGHTS,
    RISK_BANDS,
    INTERVENTION_TEMPLATES,

    /**
     * Calculate a health score (0-100) for a store.
     * Returns the overall score plus each component breakdown.
     */
    async calculateHealthScore(storeId,) {
      const now = Date.now();
      const integration = await store.integrations.findOne({ store_id: storeId, },);
      if (!integration) return { store_id: storeId, score: 0, error: 'Store not found', };

      // 1. Feature Adoption (0-100)
      //    What % of plan features has this store actually triggered?
      const featureAdoption = await this._scoreFeatureAdoption(storeId, integration,);

      // 2. Engagement Recency (0-100)
      //    How recently did the store owner interact with the dashboard?
      const engagementRecency = this._scoreRecency(integration.last_dashboard_access || integration.last_sync_at,);

      // 3. Data Freshness (0-100)
      //    How recent is the last data sync from the store?
      const dataFreshness = this._scoreRecency(integration.last_sync_at, { fresh: 1, stale: 7, dead: 30, },);

      // 4. Plan Utilization (0-100)
      //    How much of their plan capacity are they using?
      const planUtilization = await this._scorePlanUtilization(storeId, integration,);

      // 5. Growth Trajectory (0-100)
      //    Are their events/revenue trending up or down?
      const growthTrajectory = await this._scoreGrowth(storeId,);

      // 6. Automation Activity (0-100)
      //    Are their automations running and delivering results?
      const automationActivity = await this._scoreAutomation(storeId,);

      const score = Math.round(
        featureAdoption.score * WEIGHTS.feature_adoption +
        engagementRecency.score * WEIGHTS.engagement_recency +
        dataFreshness.score * WEIGHTS.data_freshness +
        planUtilization.score * WEIGHTS.plan_utilization +
        growthTrajectory.score * WEIGHTS.growth_trajectory +
        automationActivity.score * WEIGHTS.automation_activity,
      );

      const risk = this._classifyRisk(score, integration,);
      const reasons = this._identifyChurnReasons({
        featureAdoption, engagementRecency, dataFreshness,
        planUtilization, growthTrajectory, automationActivity,
      },);

      return {
        store_id: storeId,
        score,
        risk,
        components: {
          feature_adoption: featureAdoption,
          engagement_recency: engagementRecency,
          data_freshness: dataFreshness,
          plan_utilization: planUtilization,
          growth_trajectory: growthTrajectory,
          automation_activity: automationActivity,
        },
        reasons,
        calculated_at: new Date().toISOString(),
      };
    },

    /**
     * Score feature adoption: what % of the store's plan features
     * have been actively used (generated at least 1 action/event).
     */
    async _scoreFeatureAdoption(storeId, integration,) {
      const subscription = await store.subscriptions.findOne({
        shopInstallationId: storeId,
        status: 'active',
      },);
      const planId = subscription?.planId || 'starter';
      const planFeatures = this._getPlanFeatureList(planId,);

      if (planFeatures.length === 0) {
        return { score: 50, detail: 'Free plan — limited features to adopt', used: 0, total: 0, };
      }

      // Check which features have corresponding actions/events
      const actions = await store.actions.find({ store_id: storeId, },);
      const actionTypes = new Set(actions.map((a,) => a.action_type || a.rule_id,),);
      const events = await store.events.find({ store_id: storeId, },);
      const eventTypes = new Set(events.map((e,) => e.event_type,),);

      let used = 0;
      for (const feature of planFeatures) {
        if (actionTypes.has(feature,) || eventTypes.has(feature,) || eventTypes.has(`feature_${feature}`,)) {
          used++;
        }
      }

      const pct = planFeatures.length > 0 ? (used / planFeatures.length) * 100 : 50;
      return {
        score: Math.min(100, Math.round(pct,),),
        detail: `${used}/${planFeatures.length} plan features actively used`,
        used,
        total: planFeatures.length,
      };
    },

    /**
     * Score recency: maps days-since-last-activity to 0-100.
     * Thresholds are configurable via opts.
     */
    _scoreRecency(isoDate, opts = {},) {
      const fresh = opts.fresh || 0.5; // days
      const stale = opts.stale || 3;
      const dead = opts.dead || 14;

      if (!isoDate) return { score: 0, detail: 'No activity recorded', days: null, };

      const days = (Date.now() - new Date(isoDate,).getTime()) / 86400000;

      if (days <= fresh) return { score: 100, detail: `Active ${days < 1 ? 'today' : days.toFixed(1,) + 'd ago'}`, days, };
      if (days <= stale) return { score: 75, detail: `Active ${days.toFixed(1,)}d ago`, days, };
      if (days <= dead) return { score: 40, detail: `Last active ${days.toFixed(1,)}d ago`, days, };
      return { score: 10, detail: `Last active ${Math.round(days,)}d ago — critical`, days, };
    },

    /**
     * Score plan utilization: how much of their plan capacity is used.
     * Stores using 30-80% are healthy. <10% = disengaged. >100% = upgrade ready.
     */
    async _scorePlanUtilization(storeId, integration,) {
      const subscription = await store.subscriptions.findOne({
        shopInstallationId: storeId,
        status: 'active',
      },);
      const planId = subscription?.planId || 'starter';
      const planLimits = this._getPlanEventLimit(planId,);

      const monthStart = new Date();
      monthStart.setDate(1,);
      monthStart.setHours(0, 0, 0, 0,);

      const events = await store.events.find((e,) =>
        e.store_id === storeId && new Date(e.createdAt || e.timestamp,) >= monthStart,
      );
      const eventCount = events.length;
      const pct = planLimits > 0 ? (eventCount / planLimits) * 100 : 0;

      let score;
      if (pct === 0) score = 5; // not using at all
      else if (pct < 10) score = 25; // barely using
      else if (pct < 30) score = 50; // light usage
      else if (pct <= 80) score = 85; // healthy usage
      else if (pct <= 100) score = 95; // maxing out (good — engaged)
      else score = 100; // over limit — needs upgrade (very engaged)

      return {
        score,
        detail: `${eventCount}/${planLimits.toLocaleString()} events this month (${Math.round(pct,)}% of ${planId} limit)`,
        eventCount,
        planLimit: planLimits,
        utilizationPct: Math.round(pct,),
      };
    },

    /**
     * Score growth trajectory: compare recent events to previous period.
     * Growing = good, declining = concerning.
     */
    async _scoreGrowth(storeId,) {
      const now = new Date();
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1,);
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1,);
      const lastMonthEnd = thisMonthStart;

      const thisMonthEvents = await store.events.find((e,) =>
        e.store_id === storeId && new Date(e.createdAt || e.timestamp,) >= thisMonthStart,
      );
      const lastMonthEvents = await store.events.find((e,) => {
        const t = new Date(e.createdAt || e.timestamp,);
        return e.store_id === storeId && t >= lastMonthStart && t < lastMonthEnd;
      },);

      const thisCount = thisMonthEvents.length;
      const lastCount = lastMonthEvents.length;

      if (lastCount === 0 && thisCount === 0) {
        return { score: 20, detail: 'No events in last 2 months', thisMonth: 0, lastMonth: 0, trend: 'flat', };
      }
      if (lastCount === 0) {
        return { score: 70, detail: `New activity: ${thisCount} events this month`, thisMonth: thisCount, lastMonth: 0, trend: 'new', };
      }

      const change = ((thisCount - lastCount) / lastCount) * 100;

      let score;
      if (change >= 20) score = 95;
      else if (change >= 5) score = 80;
      else if (change >= -10) score = 65;
      else if (change >= -30) score = 40;
      else if (change >= -50) score = 20;
      else score = 5;

      return {
        score,
        detail: `${change >= 0 ? '+' : ''}${change.toFixed(0,)}% vs last month (${thisCount} vs ${lastCount} events)`,
        thisMonth: thisCount,
        lastMonth: lastCount,
        trend: change >= 5 ? 'growing' : change >= -10 ? 'flat' : 'declining',
      };
    },

    /**
     * Score automation activity: are automations running and delivering?
     */
    async _scoreAutomation(storeId,) {
      const actions = await store.actions.find({ store_id: storeId, },);
      const deliveries = await store.deliveries.find({ store_id: storeId, },);

      if (actions.length === 0 && deliveries.length === 0) {
        return { score: 10, detail: 'No automations configured or delivered', actions: 0, deliveries: 0, };
      }

      const activeRules = actions.filter((a,) => a.status === 'active' || a.status === 'completed',).length;
      const recentDeliveries = deliveries.filter((d,) => {
        const age = (Date.now() - new Date(d.createdAt || d.delivered_at,).getTime()) / 86400000;
        return age <= 7;
      },).length;

      let score = 0;
      if (activeRules > 0) score += 40;
      if (activeRules >= 3) score += 20;
      if (recentDeliveries > 0) score += 25;
      if (recentDeliveries >= 5) score += 15;

      return {
        score: Math.min(100, score,),
        detail: `${activeRules} active rules, ${recentDeliveries} deliveries in 7d`,
        actions: activeRules,
        deliveries: recentDeliveries,
      };
    },

    /**
     * Classify a health score into a risk band.
     * Factors in store tenure — new stores get a grace period.
     */
    _classifyRisk(score, integration,) {
      const tenureDays = integration?.created_at
        ? (Date.now() - new Date(integration.created_at,).getTime()) / 86400000
        : 0;

      // New stores (< 7 days) get bumped up one band — they haven't had time to engage
      const adjustedScore = tenureDays < 7 ? Math.min(100, score + 15,) : score;

      for (const [band, range,] of Object.entries(RISK_BANDS,)) {
        if (adjustedScore >= range.min && adjustedScore <= range.max) {
          return {
            band,
            label: range.label,
            color: range.color,
            adjusted_score: adjustedScore,
            raw_score: score,
            is_new_store: tenureDays < 7,
            tenure_days: Math.round(tenureDays,),
          };
        }
      }

      return { band: 'MEDIUM', label: 'Unknown', color: 'amber', adjusted_score: adjustedScore, raw_score: score, };
    },

    /**
     * Identify specific churn reasons from component scores.
     * Returns prioritized list of reasons with matching interventions.
     */
    _identifyChurnReasons(components,) {
      const reasons = [];

      if (components.featureAdoption.score < 40) {
        reasons.push({
          reason: 'low_feature_adoption',
          severity: components.featureAdoption.score < 20 ? 'critical' : 'high',
          detail: components.featureAdoption.detail,
          intervention: INTERVENTION_TEMPLATES.low_feature_adoption,
        },);
      }

      if (components.engagementRecency.score < 40) {
        reasons.push({
          reason: 'low_engagement',
          severity: components.engagementRecency.days > 14 ? 'critical' : 'high',
          detail: components.engagementRecency.detail,
          intervention: INTERVENTION_TEMPLATES.low_engagement,
        },);
      }

      if (components.dataFreshness.score < 40) {
        reasons.push({
          reason: 'data_stale',
          severity: components.dataFreshness.days > 30 ? 'critical' : 'high',
          detail: components.dataFreshness.detail,
          intervention: INTERVENTION_TEMPLATES.data_stale,
        },);
      }

      if (components.growthTrajectory.score < 40) {
        reasons.push({
          reason: 'declining_revenue',
          severity: components.growthTrajectory.trend === 'declining' ? 'critical' : 'medium',
          detail: components.growthTrajectory.detail,
          intervention: INTERVENTION_TEMPLATES.declining_revenue,
        },);
      }

      if (components.automationActivity.score < 30) {
        reasons.push({
          reason: 'no_automation_activity',
          severity: components.automationActivity.score < 15 ? 'critical' : 'high',
          detail: components.automationActivity.detail,
          intervention: INTERVENTION_TEMPLATES.low_feature_adoption,
        },);
      }

      // Sort by severity
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, };
      reasons.sort((a, b,) => {
        const sa = severityOrder[a.severity] ?? 9;
        const sb = severityOrder[b.severity] ?? 9;
        return sa - sb;
      },);

      return reasons;
    },

    /**
     * Get plan feature list for adoption scoring.
     */
    _getPlanFeatureList(planId,) {
      const featureMap = {
        starter: ['live_orders', 'stock_monitoring', 'product_insights', 'stockout_alerts',],
        growth: ['live_orders', 'stock_monitoring', 'product_insights', 'stockout_alerts',
          'cart_recovery', 'whatsapp_recovery', 'churn_scoring', 'competitor_radar',
          'pricing_intelligence', 'campaigns', 'retargeting', 'seo_suite', 'attribution',],
        scale: ['live_orders', 'stock_monitoring', 'product_insights', 'stockout_alerts',
          'cart_recovery', 'whatsapp_recovery', 'churn_scoring', 'competitor_radar',
          'pricing_intelligence', 'campaigns', 'retargeting', 'seo_suite', 'attribution',
          'custom_reports', 'team_roles', 'priority_support',],
      };
      return featureMap[planId] || featureMap.starter;
    },

    /**
     * Get plan event limit for utilization scoring.
     */
    _getPlanEventLimit(planId,) {
      const limits = { starter: 500, growth: 50000, scale: 500000, };
      return limits[planId] || 500;
    },

    // ─── Revenue Analytics ─────────────────────────────────────────────

    /**
     * Calculate platform-wide revenue metrics.
     * Returns MRR, churn rate, expansion revenue, LTV, NRR.
     */
    async getRevenueMetrics() {
      const subscriptions = await store.subscriptions.find({},);
      const allStores = await store.integrations.find({},);

      const active = subscriptions.filter((s,) => s.status === 'active',);
      const cancelled = subscriptions.filter((s,) => s.status === 'cancelled',);
      const pastDue = subscriptions.filter((s,) => s.status === 'past_due',);

      // MRR: sum of all active subscription prices
      const mrr = active.reduce((sum, s,) => sum + (s.price_monthly || 0), 0,);

      // ARR
      const arr = mrr * 12;

      // Churn rate: cancelled / total active+cancelled in period
      const totalRelevant = active.length + cancelled.length;
      const churnRate = totalRelevant > 0 ? (cancelled.length / totalRelevant) * 100 : 0;

      // Average Revenue Per Account
      const arpa = active.length > 0 ? mrr / active.length : 0;

      // LTV estimate: ARPA / monthly churn rate
      const monthlyChurnRate = churnRate / 100;
      const ltv = monthlyChurnRate > 0 ? arpa / monthlyChurnRate : arpa * 12;

      // Expansion potential: stores on free/starter that could upgrade
      const freeStores = allStores.filter((s,) => {
        const sub = active.find((a,) => a.shopInstallationId === s.store_id,);
        return !sub || sub.planId === 'starter';
      },).length;

      // Net Revenue Retention (simplified)
      const nrr = 100 - churnRate;

      return {
        mrr: Math.round(mrr * 100,) / 100,
        arr: Math.round(arr * 100,) / 100,
        churn_rate: Math.round(churnRate * 100,) / 100,
        arpa: Math.round(arpa * 100,) / 100,
        ltv: Math.round(ltv * 100,) / 100,
        nrr: Math.round(nrr * 100,) / 100,
        total_stores: allStores.length,
        active_subscriptions: active.length,
        cancelled_subscriptions: cancelled.length,
        past_due_subscriptions: pastDue.length,
        free_stores: freeStores,
        expansion_potential: freeStores,
        calculated_at: new Date().toISOString(),
      };
    },

    // ─── Store-Level Retention Analysis ────────────────────────────────

    /**
     * Analyze all stores and return a retention dashboard payload.
     * This is the main endpoint the admin calls to see the full picture.
     */
    async analyzeAllStores() {
      const allStores = await store.integrations.find({},);
      const subscriptions = await store.subscriptions.find({},);

      const results = [];
      for (const s of allStores) {
        const health = await this.calculateHealthScore(s.store_id,);
        const storeSub = subscriptions.find((sub,) => sub.shopInstallationId === s.store_id,);
        results.push({
          store_id: s.store_id,
          store_name: s.store_name || s.store_id,
          platform: s.type || 'unknown',
          plan: storeSub?.planId || 'starter',
          plan_price: storeSub?.price_monthly || 0,
          status: s.status || 'unknown',
          health,
          subscription: storeSub ? {
            status: storeSub.status,
            started_at: storeSub.started_at,
            current_period_end: storeSub.current_period_end,
          } : null,
        },);
      }

      // Sort by health score ascending (most at-risk first)
      results.sort((a, b,) => a.health.score - b.health.score,);

      const metrics = await this.getRevenueMetrics();

      // Group by risk band
      const byRisk = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [], THRIVING: [], };
      for (const r of results) {
        const band = r.health.risk?.band || 'MEDIUM';
        byRisk[band] = byRisk[band] || [];
        byRisk[band].push(r,);
      }

      return {
        metrics,
        stores: results,
        risk_summary: {
          critical: byRisk.CRITICAL.length,
          high: byRisk.HIGH.length,
          medium: byRisk.MEDIUM.length,
          low: byRisk.LOW.length,
          thriving: byRisk.THRIVING.length,
        },
        upgrade_candidates: this._findUpgradeCandidates(results,),
        generated_at: new Date().toISOString(),
      };
    },

    /**
     * Find stores that are prime upgrade candidates.
     * Criteria: on free/starter plan, high engagement, hitting limits.
     */
    _findUpgradeCandidates(storeResults,) {
      return storeResults
        .filter((r,) => {
          const plan = r.plan;
          const util = r.health.components?.plan_utilization;
          const engagement = r.health.components?.engagementRecency;
          return (plan === 'starter' || plan === 'free') &&
            ((util?.utilizationPct || 0) > 60 || (engagement?.score || 0) > 70);
        },)
        .map((r,) => ({
          store_id: r.store_id,
          store_name: r.store_name,
          current_plan: r.plan,
          utilization_pct: r.health.components?.plan_utilization?.utilizationPct || 0,
          health_score: r.health.score,
          recommended_plan: (r.health.components?.plan_utilization?.utilizationPct || 0) > 100 ? 'scale' : 'growth',
          reason: `High engagement (${r.health.score} health) on ${r.plan} plan — ready for more`,
        }),);
    },

    /**
     * Generate specific retention interventions for a store.
     * Returns a list of actionable campaigns the admin can trigger.
     */
    async generateInterventions(storeId,) {
      const health = await this.calculateHealthScore(storeId,);
      const integration = await store.integrations.findOne({ store_id: storeId, },);
      const subscription = await store.subscriptions.findOne({
        shopInstallationId: storeId,
        status: 'active',
      },);

      const interventions = [];

      // Generate interventions based on churn reasons
      for (const reason of health.reasons) {
        if (reason.intervention) {
          interventions.push({
            ...reason.intervention,
            reason: reason.reason,
            severity: reason.severity,
            personalized: this._personalizeTemplate(reason.intervention, {
              store: integration,
              subscription,
              health,
            },),
          },);
        }
      }

      // Check for upgrade opportunity
      const util = health.components?.plan_utilization;
      if (util?.utilizationPct > 80 && subscription?.planId !== 'scale') {
        const nextPlan = subscription?.planId === 'growth' ? 'scale' : 'growth';
        interventions.push({
          ...INTERVENTION_TEMPLATES.plan_limit_hit,
          reason: 'plan_limit_hit',
          severity: util.utilizationPct > 100 ? 'high' : 'medium',
          personalized: this._personalizeTemplate(INTERVENTION_TEMPLATES.plan_limit_hit, {
            store: integration,
            subscription,
            health,
            nextPlan,
          },),
        },);
      }

      // Check for renewal upcoming
      if (subscription?.current_period_end) {
        const daysUntilRenewal = (new Date(subscription.current_period_end,).getTime() - Date.now()) / 86400000;
        if (daysUntilRenewal > 0 && daysUntilRenewal <= 14) {
          interventions.push({
            ...INTERVENTION_TEMPLATES.renewal_upcoming,
            reason: 'renewal_upcoming',
            severity: daysUntilRenewal <= 3 ? 'critical' : 'medium',
            personalized: this._personalizeTemplate(INTERVENTION_TEMPLATES.renewal_upcoming, {
              store: integration,
              subscription,
              health,
              renewalDays: Math.round(daysUntilRenewal,),
            },),
          },);
        }
      }

      return {
        store_id: storeId,
        health_score: health.score,
        risk_band: health.risk?.band,
        interventions,
        generated_at: new Date().toISOString(),
      };
    },

    /**
     * Personalize an intervention template with store-specific data.
     */
    _personalizeTemplate(template, { store: integration, subscription, health, nextPlan, renewalDays, },) {
      const storeName = integration?.store_name || integration?.store_id || 'your store';
      const planName = subscription?.planId || 'starter';
      const events = health?.components?.plan_utilization?.eventCount || 0;
      const days = health?.components?.engagementRecency?.days || 0;

      return {
        subject: (template.subject || '')
          .replace(/\{store\}/g, storeName,)
          .replace(/\{name\}/g, 'there',)
          .replace(/\{plan\}/g, planName,)
          .replace(/\{days\}/g, String(Math.round(days,),),)
          .replace(/\{events\}/g, String(events,),)
          .replace(/\{next_plan\}/g, nextPlan || 'Growth',)
          .replace(/\{feature\}/g, this._suggestUntriedFeature(planName, health,),)
          .replace(/\{pct\}/g, '15',)
          .replace(/\{recovered\}/g, '0',)
          .replace(/\{competitor_changes\}/g, '0',)
          .replace(/\{seo_delta\}/g, '0',)
          .replace(/\{similar_store\}/g, 'a similar store',)
          .replace(/\{vertical\}/g, 'your industry',)
          .replace(/\{avg_lift\}/g, '2,400',)
          .replace(/\{date\}/g, renewalDays ? new Date(Date.now() + renewalDays * 86400000,).toLocaleDateString() : 'soon',),
        body: (template.body || '')
          .replace(/\{store\}/g, storeName,)
          .replace(/\{name\}/g, 'there',)
          .replace(/\{plan\}/g, planName,)
          .replace(/\{days\}/g, String(Math.round(days,),),)
          .replace(/\{events\}/g, String(events,),)
          .replace(/\{next_plan\}/g, nextPlan || 'Growth',)
          .replace(/\{feature\}/g, this._suggestUntriedFeature(planName, health,),)
          .replace(/\{pct\}/g, '15',)
          .replace(/\{recovered\}/g, '0',)
          .replace(/\{competitor_changes\}/g, '0',)
          .replace(/\{seo_delta\}/g, '0',)
          .replace(/\{similar_store\}/g, 'a similar store',)
          .replace(/\{vertical\}/g, 'your industry',)
          .replace(/\{avg_lift\}/g, '2,400',)
          .replace(/\{date\}/g, renewalDays ? new Date(Date.now() + renewalDays * 86400000,).toLocaleDateString() : 'soon',),
        cta: template.cta || 'Learn more',
      };
    },

    /**
     * Suggest an untried feature based on the store's plan.
     */
    _suggestUntriedFeature(planId, health,) {
      const features = {
        starter: 'stockout alerts',
        growth: 'cart recovery automations',
        scale: 'custom reports & team roles',
      };
      return features[planId] || 'advanced automations';
    },

    /**
     * Record a retention snapshot for historical tracking.
     */
    async recordSnapshot(analysis,) {
      return store.retentionSnapshots.insert({
        metrics: analysis.metrics,
        risk_summary: analysis.risk_summary,
        store_count: analysis.stores.length,
        upgrade_candidates: analysis.upgrade_candidates.length,
        recorded_at: new Date().toISOString(),
      },);
    },

    /**
     * Get retention history (past snapshots).
     */
    async getHistory(limit = 30,) {
      const all = await store.retentionSnapshots.find({},);
      all.sort((a, b,) => new Date(b.recorded_at,) - new Date(a.recorded_at,),);
      return all.slice(0, limit,);
    },
  };
}

module.exports = { createRetentionEngine, WEIGHTS, RISK_BANDS, INTERVENTION_TEMPLATES, };
