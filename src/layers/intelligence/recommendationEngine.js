'use strict';

/**
 * Layer 2 — Recommendation Engine.
 *
 * Cold start: popularity-based recommendations.
 * Warm start: co-view collaborative filtering — products frequently
 * viewed together across customer profiles score higher.
 */

function createRecommendationEngine({ store, },) {
  /** Global product popularity: view counts across all profiles. */
  async function popularityRanking(store_id,) {
    const profiles = await store.customers.find({ store_id, },);
    const counts = new Map();

    for (const profile of profiles) {
      for (const productId of profile.viewed_products || []) {
        counts.set(productId, (counts.get(productId,) || 0) + 1,);
      }
    }

    return [...counts.entries(),]
      .map(([product_id, views,],) => ({ product_id, views, }),)
      .sort((a, b,) => b.views - a.views,);
  }

  /** Co-occurrence map: product -> Map(other product -> count). */
  async function coViewMatrix(store_id,) {
    const profiles = await store.customers.find({ store_id, },);
    const matrix = new Map();

    for (const profile of profiles) {
      const viewed = profile.viewed_products || [];
      for (let i = 0; i < viewed.length; i += 1) {
        for (let j = 0; j < viewed.length; j += 1) {
          if (i === j) continue;
          if (!matrix.has(viewed[i],)) matrix.set(viewed[i], new Map(),);
          const row = matrix.get(viewed[i],);
          row.set(viewed[j], (row.get(viewed[j],) || 0) + 1,);
        }
      }
    }

    return matrix;
  }

  return {
    /**
     * Recommend up to `limit` products for a customer.
     * Excludes products they already viewed.
     */
    async recommend(store_id, customer_id, limit = 5,) {
      const profile = await store.customers.findOne({ store_id, identity: customer_id, },);
      const viewed = new Set(profile?.viewed_products || [],);
      const matrix = await coViewMatrix(store_id,);

      // Score candidates from co-views of what this customer viewed.
      const scores = new Map();
      for (const productId of viewed) {
        const row = matrix.get(productId,);
        if (!row) continue;
        for (const [candidate, count,] of row) {
          if (viewed.has(candidate,)) continue;
          scores.set(candidate, (scores.get(candidate,) || 0) + count,);
        }
      }

      const recommendations = [...scores.entries(),]
        .map(([product_id, score,],) => ({ product_id, score, strategy: 'co_view', }),)
        .sort((a, b,) => b.score - a.score,);

      // Cold start fallback: fill with popular products.
      if (recommendations.length < limit) {
        const popular = await popularityRanking(store_id,);
        for (const { product_id, views, } of popular) {
          if (recommendations.length >= limit) break;
          if (viewed.has(product_id,)) continue;
          if (recommendations.some((r,) => r.product_id === product_id,)) continue;
          recommendations.push({ product_id, score: views, strategy: 'popularity', },);
        }
      }

      return {
        store_id,
        customer_id,
        strategy: recommendations.some((r,) => r.strategy === 'co_view',)
          ? 'collaborative'
          : 'popularity',
        recommendations: recommendations.slice(0, limit,),
        generated_at: new Date().toISOString(),
      };
    },
  };
}

module.exports = { createRecommendationEngine, };
