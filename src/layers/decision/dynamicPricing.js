"use strict";

/**
 * Layer 3 — Dynamic Pricing Engine.
 *
 * Produces price recommendations per product by balancing three
 * signals: competitor positioning (latest snapshots), inventory
 * velocity (hot vs cold products) and demand trend (forecast slope).
 * Suggestions stay inside configurable guardrails so nothing wild
 * ever ships to a storefront.
 */

function createDynamicPricingEngine({ store, competitorIngestor, inventoryIntelligence, demandForecastEngine }) {
  const GUARDRAIL = { min_change_pct: -20, max_change_pct: 15 };

  function clampChange(pct) {
    return Math.max(GUARDRAIL.min_change_pct, Math.min(GUARDRAIL.max_change_pct, pct));
  }

  return {
    GUARDRAIL,

    /**
     * Recommend a price for one product.
     *
     * input: { store_id, product_id, current_price }
     */
    async recommend({ store_id, product_id, current_price }) {
      if (!store_id || !product_id) throw new Error("store_id and product_id are required.");
      if (typeof current_price !== "number" || current_price <= 0) {
        throw new Error("current_price must be a positive number.");
      }

      const signals = [];
      let adjustmentPct = 0;

      // Signal 1: competitor positioning.
      const snapshots = await competitorIngestor.latestSnapshots(store_id);
      const competitorPrices = [];
      for (const snapshot of snapshots) {
        // Try exact ID match first, then fuzzy name match
        let match = snapshot.products.find((p) => p.id === product_id && p.in_stock);
        if (!match) {
          // Fuzzy match: find competitor product with similar name
          const productName = product_id.replace(/[-_]/g, " ").toLowerCase();
          match = snapshot.products.find((p) => {
            if (!p.in_stock) return false;
            const cname = (p.name || p.id || "").replace(/[-_]/g, " ").toLowerCase();
            // Check if names share significant overlap
            const words = productName.split(/\s+/).filter(Boolean);
            const matchCount = words.filter((w) => cname.includes(w)).length;
            return matchCount >= Math.ceil(words.length * 0.5) && words.length > 0;
          });
        }
        if (match) competitorPrices.push({ competitor: snapshot.competitor, price: match.price });
      }

      if (competitorPrices.length > 0) {
        const cheapest = Math.min(...competitorPrices.map((c) => c.price));
        const gapPct = ((current_price - cheapest) / cheapest) * 100;

        if (gapPct > 10) {
          // Priced far above the market: pressure to come down.
          adjustmentPct -= Math.min(gapPct / 4, 8);
          signals.push({
            signal: "competitor_gap",
            detail: `${gapPct.toFixed(1)}% above cheapest competitor`,
            effect_pct: Number((-Math.min(gapPct / 4, 8)).toFixed(2)),
          });
        } else if (gapPct < -5) {
          // Undercutting everyone: room to raise margin.
          adjustmentPct += Math.min(Math.abs(gapPct) / 4, 6);
          signals.push({
            signal: "competitor_gap",
            detail: `${Math.abs(gapPct).toFixed(1)}% below cheapest competitor`,
            effect_pct: Number(Math.min(Math.abs(gapPct) / 4, 6).toFixed(2)),
          });
        }
      }

      // Signal 2: inventory velocity.
      try {
        const velocityReport = await inventoryIntelligence.velocity(store_id, 14);
        const productVelocity = velocityReport[product_id];

        if (productVelocity) {
          if (productVelocity.units_per_day >= 3) {
            adjustmentPct += 3;
            signals.push({
              signal: "high_velocity",
              detail: `${productVelocity.units_per_day} units/day`,
              effect_pct: 3,
            });
          } else if (productVelocity.units_per_day < 0.5 && productVelocity.units_per_day > 0) {
            adjustmentPct -= 3;
            signals.push({
              signal: "low_velocity",
              detail: `${productVelocity.units_per_day} units/day`,
              effect_pct: -3,
            });
          }
        }
      } catch {
        // Velocity is optional — pricing must not fail without sales data.
      }

      // Signal 3: demand trend from the latest forecast.
      try {
        const forecasts = await demandForecastEngine.history(store_id, 5);
        const latest = forecasts.find((f) => f.product_id === product_id);
        if (latest && latest.slope !== 0) {
          const effect = clampChange(latest.slope * 10);
          adjustmentPct += effect;
          signals.push({
            signal: latest.slope > 0 ? "rising_demand" : "falling_demand",
            detail: `forecast slope ${latest.slope} units/day`,
            effect_pct: Number(effect.toFixed(2)),
          });
        }
      } catch {
        // Forecast is optional too.
      }

      const finalChange = clampChange(adjustmentPct);
      const recommended = Number((current_price * (1 + finalChange / 100)).toFixed(2));

      return {
        store_id,
        product_id,
        current_price,
        recommended_price: recommended,
        change_pct: Number(finalChange.toFixed(2)),
        direction: finalChange > 0 ? "increase" : finalChange < 0 ? "decrease" : "hold",
        signals,
        competitor_prices: competitorPrices,
        guardrails: GUARDRAIL,
        computed_at: new Date().toISOString(),
      };
    },
  };
}

module.exports = { createDynamicPricingEngine };
