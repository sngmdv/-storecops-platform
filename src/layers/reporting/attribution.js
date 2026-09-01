'use strict';

/**
 * Layer 5 — Attribution Engine (Layer 6 growth loop).
 *
 * Links executed actions to what happened afterwards: did the customer
 * who got a recovery message actually purchase? Attributed revenue is
 * computed per rule and per channel so the platform can tell which
 * automations earn money. Forecast accuracy is audited the same way.
 */

const ATTRIBUTION_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function createAttributionEngine({ store, },) {
  /** Purchases for a customer within `days` after `fromIso`. */
  async function purchasesAfter(store_id, customer_id, fromIso, days,) {
    const cutoff = new Date(new Date(fromIso,).getTime() + days * DAY_MS,).toISOString();
    const events = await store.events.find(
      (e,) =>
        e.store_id === store_id &&
        (e.customer_id === customer_id || e.email === customer_id) &&
        ['purchase', 'checkout_completed',].includes(e.event_type,) &&
        e.timestamp >= fromIso &&
        e.timestamp <= cutoff,
    );
    return events;
  }

  return {
    /**
     * Attribute conversions for every delivered action of a store.
     * Results are persisted so reports can slice them by rule/channel.
     */
    async attributeStore(store_id, windowDays = ATTRIBUTION_WINDOW_DAYS,) {
      const delivered = await store.actions.find(
        (a,) => a.store_id === store_id && a.status === 'delivered' && a.customer_id,
      );

      const rows = [];
      let attributedRevenue = 0;
      let conversions = 0;

      for (const action of delivered) {
        const purchases = await purchasesAfter(
          store_id,
          action.customer_id,
          action.delivered_at || action.created_at,
          windowDays,
        );

        const converted = purchases.length > 0;
        const revenue = purchases.reduce((sum, e,) => sum + (e.total || 0), 0,);

        if (converted) {
          conversions += 1;
          attributedRevenue += revenue;
        }

        rows.push({
          action_id: action._id,
          rule_id: action.rule_id,
          customer_id: action.customer_id,
          channel: action.channel,
          delivered_at: action.delivered_at,
          converted,
          purchases: purchases.length,
          revenue,
        },);
      }

      // Aggregate per rule and per channel.
      const byRule = new Map();
      const byChannel = new Map();
      for (const row of rows) {
        const bucket = (map, key,) => {
          if (!map.has(key,)) map.set(key, { delivered: 0, conversions: 0, revenue: 0, },);
          return map.get(key,);
        };
        const ruleBucket = bucket(byRule, row.rule_id,);
        const channelBucket = bucket(byChannel, row.channel,);
        for (const b of [ruleBucket, channelBucket,]) {
          b.delivered += 1;
          if (row.converted) {
            b.conversions += 1;
            b.revenue += row.revenue;
          }
        }
      }

      const report = await store.attributions.insert({
        store_id,
        window_days: windowDays,
        total_delivered: rows.length,
        conversions,
        conversion_rate: rows.length > 0 ? conversions / rows.length : 0,
        attributed_revenue: attributedRevenue,
        by_rule: Object.fromEntries(byRule,),
        by_channel: Object.fromEntries(byChannel,),
        rows,
        computed_at: new Date().toISOString(),
      },);

      return report;
    },

    /** Latest attribution report for a store. */
    async latest(store_id,) {
      const reports = await store.attributions.find({ store_id, },);
      return reports.sort((a, b,) => b.computed_at.localeCompare(a.computed_at,),)[0] || null;
    },

    /**
     * Forecast accuracy audit: compare persisted forecasts against
     * actual sales that occurred after the forecast was made.
     */
    async forecastAccuracy(store_id,) {
      const forecasts = await store.forecasts.find({ store_id, },);
      const audits = [];

      for (const forecast of forecasts) {
        const after = new Date(forecast.created_at,).toISOString();
        const horizonEnd = new Date(
          new Date(forecast.created_at,).getTime() + forecast.horizon_days * DAY_MS,
        ).toISOString();

        const events = await store.events.find(
          (e,) =>
            e.store_id === store_id &&
            ['purchase', 'checkout_completed',].includes(e.event_type,) &&
            e.timestamp >= after &&
            e.timestamp <= horizonEnd &&
            (!forecast.product_id ||
              (e.items || []).some((item,) => item.product_id === forecast.product_id,)),
        );

        const actual = events.reduce(
          (sum, e,) => sum + (e.items || []).reduce((s, i,) => s + (i.quantity || 1), 0,),
          0,
        );

        const predicted = forecast.total_forecast;
        const error = predicted > 0 ? Math.abs(actual - predicted,) / predicted : actual === 0 ? 0 : 1;

        audits.push({
          forecast_id: forecast._id,
          product_id: forecast.product_id,
          predicted,
          actual,
          error_pct: Number((error * 100).toFixed(1,),),
          window_complete: Date.now() >= new Date(horizonEnd,).getTime(),
        },);
      }

      return { store_id, audits, audited_at: new Date().toISOString(), };
    },
  };
}

module.exports = { createAttributionEngine, ATTRIBUTION_WINDOW_DAYS, };
