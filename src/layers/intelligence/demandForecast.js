'use strict';

/**
 * Layer 2 — Demand Forecast Engine.
 *
 * Statistical forecasting from the event log: daily sales series per
 * product are projected forward with ordinary least squares, with a
 * weekday-seasonality adjustment. Forecasts are persisted so accuracy
 * can be audited later (predicted vs actual — the growth loop).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function createDemandForecastEngine({ store, config, },) {
  const windowDays = config.intelligence.forecastWindow;

  /** Bucket purchase quantities into daily totals for a product. */
  async function dailySeries(store_id, product_id, days,) {
    const cutoff = new Date(Date.now() - days * DAY_MS,).toISOString();
    const events = await store.events.find(
      (e,) =>
        e.store_id === store_id &&
        ['purchase', 'checkout_completed',].includes(e.event_type,) &&
        e.timestamp >= cutoff,
    );

    const totals = new Map();

    for (const event of events) {
      const items = event.items || [];
      for (const item of items) {
        if (product_id && item.product_id !== product_id) continue;
        const day = event.timestamp.slice(0, 10,);
        totals.set(day, (totals.get(day,) || 0) + (item.quantity || 1),);
      }
    }

    // Fill gaps with zeros so the regression sees real days.
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * DAY_MS,).toISOString().slice(0, 10,);
      series.push({ day, units: totals.get(day,) || 0, },);
    }
    return series;
  }

  /** Ordinary least squares: returns { slope, intercept }. */
  function linearFit(values,) {
    const n = values.length;
    if (n === 0) return { slope: 0, intercept: 0, };
    if (n === 1) return { slope: 0, intercept: values[0], };

    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;

    values.forEach((y, x,) => {
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    },);

    const denominator = n * sumXX - sumX * sumX;
    const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept, };
  }

  return {
    /**
     * Forecast demand for one product (or the whole store when
     * product_id is omitted) over the next `horizonDays`.
     */
    async forecast({ store_id, product_id = null, horizonDays = 7, },) {
      if (!store_id) throw new Error('store_id is required.',);

      const historyDays = Math.max(windowDays, 14,);
      const series = await dailySeries(store_id, product_id, historyDays,);
      const { slope, intercept, } = linearFit(series.map((point,) => point.units,),);

      const totalObserved = series.reduce((sum, point,) => sum + point.units, 0,);
      const weekdayAverage = new Array(7,).fill(0,);
      const weekdayCounts = new Array(7,).fill(0,);
      series.forEach((point,) => {
        const dow = new Date(point.day,).getDay();
        weekdayAverage[dow] += point.units;
        weekdayCounts[dow] += 1;
      },);
      const overallMean = totalObserved / Math.max(series.length, 1,);

      const projections = [];
      let totalForecast = 0;

      for (let i = 1; i <= horizonDays; i++) {
        const date = new Date(Date.now() + i * DAY_MS,);
        const trend = intercept + slope * (series.length + i);
        const dow = date.getDay();
        const seasonal =
          weekdayCounts[dow] > 0 && overallMean > 0
            ? weekdayAverage[dow] / weekdayCounts[dow] / overallMean
            : 1;
        const units = Math.max(0, trend * seasonal,);

        projections.push({ day: date.toISOString().slice(0, 10,), units: Math.round(units * 10,) / 10, },);
        totalForecast += units;
      }

      const forecast = await store.forecasts.insert({
        store_id,
        product_id,
        horizon_days: horizonDays,
        history_days: historyDays,
        slope: Math.round(slope * 1000,) / 1000,
        total_observed: totalObserved,
        total_forecast: Math.round(totalForecast,),
        projections,
        created_at: new Date().toISOString(),
      },);

      return forecast;
    },

    /** Persisted forecast history for audit. */
    async history(store_id, limit = 20,) {
      const forecasts = await store.forecasts.find({ store_id, },);
      return forecasts
        .sort((a, b,) => b.created_at.localeCompare(a.created_at,),)
        .slice(0, limit,);
    },
  };
}

module.exports = { createDemandForecastEngine, };
