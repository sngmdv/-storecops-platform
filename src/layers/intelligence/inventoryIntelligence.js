'use strict';

/**
 * Layer 2 — Inventory Velocity Intelligence Engine.
 *
 * Computes per-product sales velocity from purchase events, flags
 * stockout risk, and suggests reorder quantities based on velocity and
 * lead time.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function createInventoryIntelligence({ store, },) {
  /** Daily units sold per product over the window. */
  async function velocity(store_id, windowDays = 30,) {
    const cutoff = new Date(Date.now() - windowDays * DAY_MS,).toISOString();
    const events = await store.events.find(
      (e,) =>
        e.store_id === store_id &&
        ['purchase', 'checkout_completed',].includes(e.event_type,) &&
        e.timestamp >= cutoff,
    );

    const byProduct = new Map();

    for (const event of events) {
      const items = event.items || (event.product_id ? [{ product_id: event.product_id, quantity: 1, },] : []);

      for (const item of items) {
        const key = String(item.product_id,);
        const existing = byProduct.get(key,) || { units: 0, orders: 0, };
        existing.units += Number(item.quantity,) || 1;
        existing.orders += 1;
        byProduct.set(key, existing,);
      }
    }

    const result = {};
    for (const [product_id, { units, orders, },] of byProduct) {
      result[product_id] = {
        units_sold: units,
        orders,
        units_per_day: Number((units / windowDays).toFixed(3,),),
      };
    }
    return result;
  }

  return {
    velocity,

    /**
     * Full stock health report.
     *
     * inventory: [{ product_id, stock, lead_time_days }]
     */
    async analyze(store_id, inventory = [], windowDays = 30,) {
      const rates = await velocity(store_id, windowDays,);
      const products = [];

      for (const item of inventory) {
        const rate = rates[item.product_id]?.units_per_day || 0;
        const stock = Number(item.stock,) || 0;
        const leadTime = Number(item.lead_time_days,) || 7;

        const daysOfCover = rate > 0 ? stock / rate : Infinity;
        const reorderPoint = rate * leadTime * 1.5; // 50% safety buffer

        let status = 'HEALTHY';
        if (rate > 0 && daysOfCover <= leadTime) status = 'STOCKOUT_RISK';
        else if (rate > 0 && stock <= reorderPoint) status = 'REORDER_SOON';
        else if (rate === 0 && stock > 0) status = 'NO_DEMAND';

        products.push({
          product_id: item.product_id,
          stock,
          units_per_day: rate,
          days_of_cover: daysOfCover === Infinity ? null : Math.round(daysOfCover,),
          reorder_point: Math.ceil(reorderPoint,),
          suggested_reorder_qty: stock <= reorderPoint ? Math.ceil(rate * leadTime * 2 - stock,) : 0,
          status,
        },);
      }

      return {
        store_id,
        window_days: windowDays,
        analyzed_at: new Date().toISOString(),
        alerts: products.filter((p,) => p.status === 'STOCKOUT_RISK',),
        products,
      };
    },
  };
}

module.exports = { createInventoryIntelligence, };
