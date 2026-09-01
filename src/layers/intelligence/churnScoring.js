'use strict';

/**
 * Layer 2 — Churn-Risk Scoring Engine.
 *
 * RFM-based heuristic model (transparent, deterministic, upgradeable to
 * a trained classifier later). Scores each customer 0-100 where higher
 * means higher churn risk, and emits the factors that drove the score.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(value, min, max,) {
  return Math.max(min, Math.min(max, value,),);
}

function createChurnScoringEngine({ store, config, },) {
  const inactiveDays = config.intelligence.churnInactiveDays;

  /** Score one customer profile. */
  function scoreProfile(profile, now = Date.now(),) {
    const factors = [];
    let risk = 0;

    // Recency: days since last activity relative to the inactivity window.
    const daysSinceSeen = profile.last_seen
      ? (now - new Date(profile.last_seen,).getTime()) / DAY_MS
      : inactiveDays;
    const recencyRisk = clamp((daysSinceSeen / inactiveDays) * 60, 0, 60,);
    risk += recencyRisk;
    factors.push({
      factor: 'recency',
      detail: `${daysSinceSeen.toFixed(1,)} days since last activity`,
      contribution: Math.round(recencyRisk,),
    },);

    // Cart abandonment pressure: abandoned but never converted.
    if (profile.abandoned_carts > 0 && profile.purchases === 0) {
      const abandonmentRisk = clamp(profile.abandoned_carts * 8, 0, 20,);
      risk += abandonmentRisk;
      factors.push({
        factor: 'unconverted_abandonment',
        detail: `${profile.abandoned_carts} abandoned cart(s), zero purchases`,
        contribution: Math.round(abandonmentRisk,),
      },);
    }

    // Engagement decay: heavy viewer who stopped buying.
    if (profile.product_views >= 5 && profile.purchases === 0) {
      risk += 10;
      factors.push({
        factor: 'browse_without_buy',
        detail: `${profile.product_views} product views without a purchase`,
        contribution: 10,
      },);
    }

    // Loyal customers get protective credit.
    if (profile.purchases >= 3) {
      risk -= 15;
      factors.push({
        factor: 'loyalty_credit',
        detail: `${profile.purchases} historical purchases`,
        contribution: -15,
      },);
    }

    const finalScore = clamp(Math.round(risk,), 0, 100,);

    let band = 'LOW';
    if (finalScore >= 70) band = 'CRITICAL';
    else if (finalScore >= 45) band = 'HIGH';
    else if (finalScore >= 25) band = 'MEDIUM';

    return {
      customer_id: profile.identity,
      store_id: profile.store_id,
      churn_score: finalScore,
      risk_band: band,
      factors,
      scored_at: new Date(now,).toISOString(),
    };
  }

  return {
    scoreProfile,

    /** Score one customer by identity. */
    async scoreCustomer(store_id, customer_id,) {
      const profile = await store.customers.findOne({ store_id, identity: customer_id, },);
      if (!profile) return null;
      return scoreProfile(profile,);
    },

    /** Batch-score a store's customers, worst first. */
    async scoreStore(store_id,) {
      const profiles = await store.customers.find(
        (profile,) => profile.store_id === store_id && !profile.merged_into,
      );
      return profiles
        .map((profile,) => scoreProfile(profile,),)
        .sort((a, b,) => b.churn_score - a.churn_score,);
    },
  };
}

module.exports = { createChurnScoringEngine, };
