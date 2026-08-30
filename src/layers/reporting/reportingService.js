"use strict";

/**
 * Layer 5 — Reporting Service.
 *
 * Builds the store dashboard: a single rollup combining data-layer
 * KPIs, intelligence health signals, automation performance and
 * attribution. Snapshots are persisted for trend-over-trend views.
 */

function createReportingService({ store, churnScoring, brandSentiment, channelOptimizer, attribution, config }) {
  /** Attribution-driven ROI vs the subscription cost (9.2). */
  async function roi(store_id) {
    const latest = await attribution.latest(store_id);
    const attributed = latest?.attributed_revenue || 0;
    const cost = config?.subscriptionCostMonthly || 49;

    return {
      store_id,
      attributed_revenue: attributed,
      subscription_cost: cost,
      net_gain: Number((attributed - cost).toFixed(2)),
      roi_percent: Number((((attributed - cost) / cost) * 100).toFixed(1)),
      multiplier: Number((attributed / cost).toFixed(2)),
      verdict: attributed >= cost ? "PROFITABLE" : "BUILDING",
      calculated_at: new Date().toISOString(),
    };
  }

  /** How "smart" the system is getting over time (9.5). */
  async function maturityScore(store_id) {
    const [events, customers, deliveries, rules, campaigns] = await Promise.all([
      store.events.find({ store_id }),
      store.customers.find({ store_id }),
      store.deliveries.find({ store_id }),
      store.rules.find({ store_id }),
      store.campaigns.find({ store_id }),
    ]);

    // Each dimension scores 0-100, then weighted.
    const clamp = (value) => Math.min(100, Math.round(value));
    const dimensions = {
      data_volume: clamp((events.length / 500) * 100),
      profile_coverage: clamp((customers.length / 50) * 100),
      automation_activity: clamp((deliveries.length / 20) * 100),
      customization: clamp(((rules.length + campaigns.length) / 5) * 100),
      learning_signal: clamp(
        (events.filter((e) => ["email_opened", "email_clicked", "whatsapp_read", "push_opened"].includes(e.event_type)).length / 50) * 100
      ),
    };

    const weights = { data_volume: 0.3, profile_coverage: 0.2, automation_activity: 0.2, customization: 0.15, learning_signal: 0.15 };
    const score = Math.round(
      Object.entries(dimensions).reduce((sum, [key, value]) => sum + value * weights[key], 0)
    );

    const stage =
      score >= 80 ? "AUTONOMOUS" : score >= 55 ? "OPTIMIZING" : score >= 30 ? "LEARNING" : "COLLECTING";

    return { store_id, score, stage, dimensions, scored_at: new Date().toISOString() };
  }

  return {
    roi,
    maturityScore,
    /** Full dashboard rollup for a store. */
    async storeReport(store_id) {
      const [events, customers, actions, deliveries] = await Promise.all([
        store.events.find({ store_id }),
        store.customers.find({ store_id }),
        store.actions.find({ store_id }),
        store.deliveries.find({ store_id }),
      ]);

      // Funnel from the event log.
      const count = (type) => events.filter((e) => e.event_type === type).length;
      const revenue = events
        .filter((e) => ["purchase", "checkout_completed"].includes(e.event_type))
        .reduce((sum, e) => sum + (e.total || 0), 0);

      const funnel = {
        product_views: count("product_view"),
        carts: count("cart_updated"),
        abandoned: count("cart_abandoned"),
        checkouts_started: count("checkout_started"),
        purchases: count("purchase"),
      };

      // Churn distribution.
      const scores = await churnScoring.scoreStore(store_id);
      const riskBands = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
      for (const score of scores) riskBands[score.risk_band] += 1;

      // Sentiment + channel learning.
      const sentiment = await brandSentiment.analyze(store_id, 50);
      const channelRates = await channelOptimizer.storeRates(store_id);

      // Automation performance.
      const delivered = actions.filter((a) => a.status === "delivered").length;
      const failed = actions.filter((a) => a.status === "failed").length;
      const latestAttribution = await attribution.latest(store_id);

      const report = {
        store_id,
        generated_at: new Date().toISOString(),
        overview: {
          customers: customers.length,
          events_tracked: events.length,
          revenue,
          actions_queued: actions.length,
          actions_delivered: delivered,
          actions_failed: failed,
          deliveries_recorded: deliveries.length,
        },
        funnel,
        churn: {
          scored_customers: scores.length,
          risk_bands: riskBands,
          top_at_risk: scores.slice(0, 5).map((s) => ({
            customer_id: s.customer_id,
            churn_score: s.churn_score,
            risk_band: s.risk_band,
          })),
        },
        sentiment: {
          health_score: sentiment.health_score,
          label: sentiment.overall_label,
          sample_count: sentiment.sample_count,
        },
        channels: channelRates,
        attribution: latestAttribution
          ? {
              conversions: latestAttribution.conversions,
              conversion_rate: latestAttribution.conversion_rate,
              attributed_revenue: latestAttribution.attributed_revenue,
              by_rule: latestAttribution.by_rule,
            }
          : null,
      };

      await store.reports.insert(report);
      return report;
    },

    /** Historical report snapshots. */
    async history(store_id, limit = 10) {
      const reports = await store.reports.find({ store_id });
      return reports
        .sort((a, b) => b.generated_at.localeCompare(a.generated_at))
        .slice(0, limit);
    },

    /**
     * Weekly digest (9.3) + sentiment trend (4.9): the admin-ready
     * summary combining the current rollup with deltas against the
     * previous snapshot.
     */
    async weeklyDigest(store_id) {
      const report = await this.storeReport(store_id);
      const snapshots = await this.history(store_id, 2);
      const previous = snapshots.find((s) => s._id !== report._id) || null;

      const sentimentTrend = {
        current: report.sentiment.health_score,
        previous: previous?.sentiment?.health_score ?? null,
        direction:
          previous === null
            ? "BASELINE"
            : report.sentiment.health_score > previous.sentiment.health_score
              ? "IMPROVING"
              : report.sentiment.health_score < previous.sentiment.health_score
                ? "DECLINING"
                : "STABLE",
      };

      const roiReport = await roi(store_id);
      const maturity = await maturityScore(store_id);

      return {
        store_id,
        period: "weekly",
        generated_at: report.generated_at,
        headline: {
          revenue: report.overview.revenue,
          actions_delivered: report.overview.actions_delivered,
          attributed_revenue: roiReport.attributed_revenue,
          roi_percent: roiReport.roi_percent,
          maturity_stage: maturity.stage,
        },
        sentiment_trend: sentimentTrend,
        churn: report.churn,
        funnel: report.funnel,
        channels: report.channels,
      };
    },

    /**
     * Custom report builder (9.6): filter the event log by date range
     * and event type, aggregate, and optionally export as CSV.
     */
    async customReport({ store_id, from = null, to = null, event_types = null, format = "json" } = {}) {
      if (!store_id) throw new Error("store_id is required.");

      const events = await store.events.find((e) => {
        if (e.store_id !== store_id) return false;
        if (from && e.timestamp < from) return false;
        if (to && e.timestamp > to) return false;
        if (event_types && !event_types.includes(e.event_type)) return false;
        return true;
      });

      const byType = {};
      let revenue = 0;
      const customers = new Set();
      for (const event of events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
        byType[event.event_type] = (byType[event.event_type] || 0) + 1;
        if (["purchase", "checkout_completed"].includes(event.event_type)) revenue += event.total || 0;
        if (event.customer_id || event.email) customers.add(event.customer_id || event.email);
      }

      const result = {
        store_id,
        filters: { from, to, event_types },
        events_matched: events.length,
        unique_customers: customers.size,
        revenue,
        by_event_type: byType,
        generated_at: new Date().toISOString(),
      };

      if (format === "csv") {
        const header = "event_id,event_type,customer,timestamp,total";
        const rows = events.map(
          (e) =>
            `${e._id},${e.event_type},${e.customer_id || e.email || ""},${e.timestamp},${e.total ?? ""}`
        );
        result.csv = [header, ...rows].join("\n");
      }

      return result;
    },
  };
}

module.exports = { createReportingService };
