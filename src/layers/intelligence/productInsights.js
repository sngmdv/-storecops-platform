'use strict';

/**
 * Layer 2 — Product Insights Engine.
 *
 * Turns sales velocity + the live stock ledger into plain-language
 * suggestions for the store owner: what's selling fast, what's
 * lagging, what's dead weight, and — most urgently — what must be
 * restocked before it runs out.
 */

const THRESHOLDS = {
  fast_units_per_day: 1.5, // >= this counts as a fast mover
  slow_units_per_day: 0.3, // > 0 but below this counts as slow
};

function createProductInsights({ store, inventoryIntelligence, inventoryLedger, },) {
  return {
    /**
     * Full product health + suggestion report.
     *
     * Combines purchase history (velocity, revenue) with current stock
     * levels and supplier lead times.
     */
    async analyze(store_id, windowDays = 30,) {
      const [velocity, levels,] = await Promise.all([
        inventoryIntelligence.velocity(store_id, windowDays,),
        inventoryLedger.levels(store_id,),
      ],);

      // Revenue per product (when item prices are available).
      const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000,).toISOString();
      const sales = await store.events.find(
        (e,) =>
          e.store_id === store_id &&
          ['purchase', 'checkout_completed',].includes(e.event_type,) &&
          e.timestamp >= cutoff,
      );
      const revenueByProduct = new Map();
      const ordersByProduct = new Map();
      for (const event of sales) {
        for (const item of event.items || []) {
          const key = String(item.product_id,);
          if (typeof item.price === 'number') {
            revenueByProduct.set(
              key,
              (revenueByProduct.get(key,) || 0) + item.price * (item.quantity || 1),
            );
          }
          ordersByProduct.set(key, (ordersByProduct.get(key,) || 0) + 1,);
        }
      }

      // Union of everything sold and everything stocked.
      const productIds = new Set([...Object.keys(velocity,), ...levels.map((l,) => l.product_id,),],);
      const stockByProduct = new Map(levels.map((l,) => [l.product_id, l,],),);

      const fast_movers = [];
      const slow_movers = [];
      const dead_stock = [];
      const restock_urgent = [];
      const stockout_predictions = [];
      const healthy = [];

      for (const product_id of productIds) {
        const rate = velocity[product_id];
        const units_per_day = rate?.units_per_day || 0;
        const units_sold = rate?.units_sold || 0;
        const entry = stockByProduct.get(product_id,);
        const stock = entry?.stock ?? null;
        const leadTime = entry?.lead_time_days || 7;
        const revenue = revenueByProduct.get(product_id,) || null;
        const orders = ordersByProduct.get(product_id,) || 0;
        const days_of_cover =
          stock !== null && units_per_day > 0 ? Math.floor(stock / units_per_day,) : null;

        // Stockout prediction (6.2): exact date + urgency tier.
        let stockout_date = null;
        let stockout_urgency = null;
        if (days_of_cover !== null) {
          stockout_date = new Date(Date.now() + days_of_cover * 24 * 60 * 60 * 1000,)
            .toISOString()
            .slice(0, 10,);
          stockout_urgency =
            days_of_cover <= 3 ? 'HIGH' : days_of_cover <= 7 ? 'MEDIUM' : days_of_cover <= 14 ? 'LOW' : null;
        }

        const base = {
          product_id,
          units_sold,
          units_per_day,
          orders,
          revenue,
          stock,
          lead_time_days: leadTime,
          days_of_cover,
          reorder_point:
            units_per_day > 0 ? Number((units_per_day * leadTime * 1.5).toFixed(1,),) : null,
          stockout_date,
          stockout_urgency,
        };

        if (stockout_urgency) {
          stockout_predictions.push({
            product_id,
            stock,
            units_per_day,
            stockout_date,
            urgency: stockout_urgency,
            message: `${product_id} runs out around ${stockout_date} (${days_of_cover} day(s) of cover at ${units_per_day}/day).`,
          },);
        }

        // Restock logic runs for every selling product with known stock.
        if (stock !== null && units_per_day > 0) {
          const reorder_point = units_per_day * leadTime * 1.5;
          if (stock <= units_per_day * leadTime) {
            const suggested_qty = Math.ceil(units_per_day * leadTime * 2 - stock,);
            restock_urgent.push({
              ...base,
              severity: stock === 0 ? 'OUT_OF_STOCK' : 'RESTOCK_NOW',
              suggested_qty,
              suggestion:
                stock === 0
                  ? `${product_id} is OUT OF STOCK while selling ${units_per_day}/day — order ${suggested_qty} units immediately.`
                  : `${product_id} has ~${days_of_cover} day(s) of cover left and a ${leadTime}-day lead time — restock ${suggested_qty} units now.`,
            },);
            continue; // restock urgency outranks pace labels
          }
          if (stock <= reorder_point) {
            const suggested_qty = Math.ceil(units_per_day * leadTime * 2 - stock,);
            restock_urgent.push({
              ...base,
              severity: 'REORDER_SOON',
              suggested_qty,
              suggestion: `${product_id} will hit its reorder point soon — plan a ${suggested_qty}-unit order.`,
            },);
            continue;
          }
        }

        if (units_per_day >= THRESHOLDS.fast_units_per_day) {
          fast_movers.push({
            ...base,
            suggestion: `${product_id} is a fast mover (${units_per_day} units/day). Keep it stocked and consider bundling or upselling it.`,
          },);
        } else if (units_per_day > THRESHOLDS.slow_units_per_day) {
          slow_movers.push({
            ...base,
            markdown_pct: 10,
            suggestion: `${product_id} sells slowly (${units_per_day} units/day). A 10% markdown or better placement could clear it faster.`,
          },);
        } else if (units_sold === 0 && stock !== null && stock > 0) {
          dead_stock.push({
            ...base,
            markdown_pct: 25,
            suggestion: `${product_id} holds ${stock} unit(s) but hasn't sold in ${windowDays} days. A 25-30% clearance markdown would free up capital.`,
          },);
        } else if (units_sold > 0) {
          slow_movers.push({
            ...base,
            markdown_pct: 10,
            suggestion: `${product_id} had only ${units_sold} sale(s) in ${windowDays} days — it needs visibility, a price review, or a 10% markdown.`,
          },);
        } else {
          healthy.push(base,);
        }
      }

      const byVelocity = (a, b,) => b.units_per_day - a.units_per_day;
      fast_movers.sort(byVelocity,);
      slow_movers.sort(byVelocity,);
      restock_urgent.sort((a, b,) => (a.days_of_cover ?? -1) - (b.days_of_cover ?? -1),);
      const urgencyOrder = { HIGH: 0, MEDIUM: 1, LOW: 2, };
      stockout_predictions.sort((a, b,) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency],);

      return {
        store_id,
        window_days: windowDays,
        generated_at: new Date().toISOString(),
        summary: {
          products_analyzed: productIds.size,
          fast_movers: fast_movers.length,
          slow_movers: slow_movers.length,
          dead_stock: dead_stock.length,
          needs_restock: restock_urgent.length,
          stockout_risks: stockout_predictions.length,
        },
        stockout_predictions,
        restock_urgent,
        fast_movers,
        slow_movers,
        dead_stock,
        thresholds: THRESHOLDS,
      };
    },
  };
}

module.exports = { createProductInsights, THRESHOLDS, };
