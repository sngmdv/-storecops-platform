'use strict';

/**
 * Feature Adoption Tracker
 *
 * Tracks per-client feature usage and generates heatmap data:
 * - Records feature activations and usage
 * - Calculates adoption rates per feature
 * - Generates heatmap data for admin dashboard
 * - Identifies power users and under-utilized features
 */

const FEATURES = [
  { id: 'cart_recovery', name: 'Cart Recovery', category: 'automation', },
  { id: 'browse_abandonment', name: 'Browse Abandonment', category: 'automation', },
  { id: 'winback_campaigns', name: 'Win-back Campaigns', category: 'automation', },
  { id: 'churn_scoring', name: 'Churn Scoring', category: 'intelligence', },
  { id: 'competitor_tracking', name: 'Competitor Tracking', category: 'intelligence', },
  { id: 'seo_audit', name: 'SEO Audit', category: 'intelligence', },
  { id: 'sentiment_monitoring', name: 'Sentiment Monitoring', category: 'intelligence', },
  { id: 'demand_forecasting', name: 'Demand Forecasting', category: 'intelligence', },
  { id: 'inventory_advisor', name: 'Inventory Advisor', category: 'operations', },
  { id: 'recommendations', name: 'Product Recommendations', category: 'growth', },
  { id: 'referral_program', name: 'Referral Program', category: 'growth', },
  { id: 'weekly_reports', name: 'Weekly Reports', category: 'reporting', },
  { id: 'revenue_attribution', name: 'Revenue Attribution', category: 'reporting', },
  { id: 'whatsapp_recovery', name: 'WhatsApp Recovery', category: 'communication', },
  { id: 'email_campaigns', name: 'Email Campaigns', category: 'communication', },
];

function createFeatureAdoption({ store, },) {
  /**
   * Record a feature activation for a store.
   */
  async function recordActivation(store_id, feature_id, metadata = {},) {
    if (!FEATURES.find((f,) => f.id === feature_id,)) {
      throw new Error(`Unknown feature: ${feature_id}`,);
    }

    const existing = await store.featureUsage?.findOne({
      store_id,
      feature_id,
    },);

    if (existing) {
      return store.featureUsage.update(existing._id, {
        last_used_at: new Date().toISOString(),
        usage_count: (existing.usage_count || 0) + 1,
        metadata: { ...existing.metadata, ...metadata, },
      },);
    }

    return store.featureUsage?.insert({
      store_id,
      feature_id,
      first_used_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      usage_count: 1,
      metadata,
    },);
  }

  /**
   * Get feature usage for a store.
   */
  async function getStoreUsage(store_id,) {
    const usage = await store.featureUsage?.find({ store_id, },) || [];

    return FEATURES.map((feature,) => {
      const record = usage.find((u,) => u.feature_id === feature.id,);
      return {
        ...feature,
        activated: !!record,
        first_used_at: record?.first_used_at || null,
        last_used_at: record?.last_used_at || null,
        usage_count: record?.usage_count || 0,
      };
    },);
  }

  /**
   * Get adoption heatmap data across all stores.
   */
  async function getHeatmapData() {
    const allUsage = await store.featureUsage?.find({},) || [];
    const stores = await store.onboardingStates?.find({},) || [];
    const storeIds = stores.map((s,) => s.store_id,);

    // Build heatmap: rows = stores, columns = features
    const heatmap = {
      features: FEATURES.map((f,) => f.id,),
      feature_names: FEATURES.map((f,) => f.name,),
      feature_categories: FEATURES.map((f,) => f.category,),
      stores: [],
      summary: {
        total_stores: storeIds.length,
        feature_adoption: {},
      },
    };

    // Calculate feature adoption rates
    for (const feature of FEATURES) {
      const storesUsing = allUsage.filter(
        (u,) => u.feature_id === feature.id && storeIds.includes(u.store_id,),
      ).length;
      heatmap.summary.feature_adoption[feature.id] = {
        name: feature.name,
        stores_using: storesUsing,
        adoption_rate: storeIds.length > 0 ? (storesUsing / storeIds.length) * 100 : 0,
      };
    }

    // Build per-store rows
    for (const storeId of storeIds) {
      const storeUsage = allUsage.filter((u,) => u.store_id === storeId,);
      const row = {
        store_id: storeId,
        features: {},
        score: 0,
      };

      let activatedCount = 0;
      for (const feature of FEATURES) {
        const record = storeUsage.find((u,) => u.feature_id === feature.id,);
        row.features[feature.id] = {
          activated: !!record,
          usage_count: record?.usage_count || 0,
          last_used_at: record?.last_used_at || null,
        };
        if (record) activatedCount++;
      }

      row.score = Math.round((activatedCount / FEATURES.length) * 100,);
      heatmap.stores.push(row,);
    }

    // Sort by score descending
    heatmap.stores.sort((a, b,) => b.score - a.score,);

    return heatmap;
  }

  /**
   * Get feature adoption summary for admin dashboard.
   */
  async function getAdoptionSummary() {
    const heatmap = await getHeatmapData();

    // Find power users (high adoption)
    const powerUsers = heatmap.stores.filter((s,) => s.score >= 70,);

    // Find under-utilized features
    const underUtilized = Object.values(heatmap.summary.feature_adoption,)
      .filter((f,) => f.adoption_rate < 30,)
      .sort((a, b,) => a.adoption_rate - b.adoption_rate,);

    // Calculate category adoption
    const categoryAdoption = {};
    for (const feature of FEATURES) {
      if (!categoryAdoption[feature.category]) {
        categoryAdoption[feature.category] = { total: 0, activated: 0, };
      }
      categoryAdoption[feature.category].total++;
      const adoption = heatmap.summary.feature_adoption[feature.id];
      if (adoption && adoption.adoption_rate > 0) {
        categoryAdoption[feature.category].activated++;
      }
    }

    // Convert to rates
    for (const [cat, data,] of Object.entries(categoryAdoption,)) {
      categoryAdoption[cat] = {
        ...data,
        adoption_rate: data.total > 0 ? (data.activated / data.total) * 100 : 0,
      };
    }

    return {
      total_stores: heatmap.summary.total_stores,
      avg_adoption_score:
        heatmap.stores.length > 0
          ? Math.round(heatmap.stores.reduce((sum, s,) => sum + s.score, 0,) / heatmap.stores.length,)
          : 0,
      power_users: powerUsers.length,
      under_utilized_features: underUtilized,
      category_adoption: categoryAdoption,
      feature_adoption: heatmap.summary.feature_adoption,
    };
  }

  return {
    FEATURES,
    recordActivation,
    getStoreUsage,
    getHeatmapData,
    getAdoptionSummary,
  };
}

module.exports = { createFeatureAdoption, FEATURES, };
