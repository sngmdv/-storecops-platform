"use strict";

/**
 * Trial Management Service
 *
 * Manages 14-day free trials with feature gating:
 *   - 14-day trial period for new merchants
 *   - Feature access control during trial
 *   - Trial countdown and status tracking
 *   - Upgrade prompts and conversion tracking
 *   - Automatic trial expiry handling
 *
 * Trial feature access:
 *   - Core Foundation: FULL access (proves value)
 *   - Revenue Recovery: FULL access ("Aha! moment")
 *   - Intelligence Preview: LIMITED (shows preview with "Upgrade" CTA)
 *   - Reporting: FULL access (shows what the app has done)
 */

const TRIAL_DURATION_DAYS = 14;

// Feature access during trial
const TRIAL_FEATURES = {
  // Full access during trial
  full: [
    "live_orders", "stock_monitoring", "product_insights", "stockout_alerts",
    "cart_recovery", "browse_abandonment", "revenue_recovery",
    "reports", "attribution", "basic_analytics",
  ],
  // Limited access (preview with upgrade prompt)
  limited: [
    "churn_scoring", "competitor_radar", "pricing_intelligence",
    "campaigns", "retargeting", "seo_suite", "dynamic_pricing",
    "trend_detection", "ad_intelligence", "sentiment_tracking",
  ],
  // No access during trial
  none: [
    "whatsapp_recovery", "custom_reports", "team_roles", "priority_support",
    "api_access", "webhooks", "custom_integrations",
  ],
};

function createTrialService({ store, config }) {

  /**
   * Start a trial for a new merchant.
   */
  async function startTrial(merchantId, storeId, plan = "growth") {
    const existing = await store.trials.findOne({ merchant_id: merchantId });
    if (existing) return existing;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TRIAL_DURATION_DAYS * 86400000);

    const trial = {
      merchant_id: merchantId,
      store_id: storeId,
      plan,
      status: "active", // active -> expired -> converted -> cancelled
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      days_remaining: TRIAL_DURATION_DAYS,
      features_access: "full",
      upgraded: false,
      converted_at: null,
      created_at: now.toISOString(),
    };

    await store.trials.insert(trial);
    return trial;
  }

  /**
   * Get trial status for a merchant.
   */
  async function getTrialStatus(merchantId) {
    const trial = await store.trials.findOne({ merchant_id: merchantId });
    if (!trial) {
      return {
        has_trial: false,
        status: "none",
        days_remaining: 0,
        features: {},
      };
    }

    const now = new Date();
    const expiresAt = new Date(trial.expires_at);
    const daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / 86400000));
    const isExpired = daysRemaining === 0 && trial.status === "active";

    // Auto-expire if needed
    if (isExpired && trial.status === "active") {
      await store.trials.update(trial._id, { status: "expired" });
      trial.status = "expired";
    }

    return {
      has_trial: true,
      status: trial.status,
      plan: trial.plan,
      days_remaining: daysRemaining,
      total_days: TRIAL_DURATION_DAYS,
      started_at: trial.started_at,
      expires_at: trial.expires_at,
      percentage_complete: Math.round(((TRIAL_DURATION_DAYS - daysRemaining) / TRIAL_DURATION_DAYS) * 100),
      features: getFeatureAccess(trial.status, daysRemaining),
      is_expired: trial.status === "expired",
      can_upgrade: trial.status === "active" || trial.status === "expired",
    };
  }

  /**
   * Check if a merchant can access a specific feature.
   */
  async function canAccessFeature(merchantId, feature) {
    const trial = await store.trials.findOne({ merchant_id: merchantId });
    
    if (!trial || trial.status === "converted" || trial.status === "cancelled") {
      // No trial or trial ended — check actual subscription
      return { allowed: true, reason: "subscriber" };
    }

    if (trial.status === "expired") {
      return {
        allowed: false,
        reason: "trial_expired",
        upgrade_required: true,
      };
    }

    // Active trial — check feature access
    if (TRIAL_FEATURES.full.includes(feature)) {
      return { allowed: true, reason: "trial_active" };
    }

    if (TRIAL_FEATURES.limited.includes(feature)) {
      return {
        allowed: false,
        reason: "trial_limited",
        upgrade_required: true,
        preview: true, // Show preview with upgrade prompt
      };
    }

    return {
      allowed: false,
      reason: "trial_restricted",
      upgrade_required: true,
    };
  }

  /**
   * Convert trial to paid subscription.
   */
  async function convertTrial(merchantId, subscriptionId) {
    const trial = await store.trials.findOne({ merchant_id: merchantId });
    if (!trial) return { converted: false, error: "No active trial" };

    await store.trials.update(trial._id, {
      status: "converted",
      converted_at: new Date().toISOString(),
      subscription_id: subscriptionId,
      upgraded: true,
    });

    return { converted: true, plan: trial.plan };
  }

  /**
   * Cancel trial.
   */
  async function cancelTrial(merchantId) {
    const trial = await store.trials.findOne({ merchant_id: merchantId });
    if (!trial) return { cancelled: false, error: "No active trial" };

    await store.trials.update(trial._id, {
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
    });

    return { cancelled: true };
  }

  /**
   * Get trial analytics for admin dashboard.
   */
  async function getAnalytics() {
    const allTrials = await store.trials.find({});
    
    const now = new Date();
    const activeTrials = allTrials.filter(t => t.status === "active");
    const expiredTrials = allTrials.filter(t => t.status === "expired");
    const convertedTrials = allTrials.filter(t => t.status === "converted");
    const cancelledTrials = allTrials.filter(t => t.status === "cancelled");

    // Conversion rate
    const totalEnded = expiredTrials.length + convertedTrials.length + cancelledTrials.length;
    const conversionRate = totalEnded > 0 ? (convertedTrials.length / totalEnded) * 100 : 0;

    // Average days to convert
    const daysToConvert = convertedTrials
      .filter(t => t.converted_at && t.started_at)
      .map(t => {
        const start = new Date(t.started_at);
        const end = new Date(t.converted_at);
        return Math.ceil((end - start) / 86400000);
      });
    const avgDaysToConvert = daysToConvert.length > 0
      ? daysToConvert.reduce((a, b) => a + b, 0) / daysToConvert.length
      : 0;

    // Expiring soon (within 3 days)
    const expiringSoon = activeTrials.filter(t => {
      const expiresAt = new Date(t.expires_at);
      const daysLeft = Math.ceil((expiresAt - now) / 86400000);
      return daysLeft <= 3 && daysLeft > 0;
    });

    return {
      total_trials: allTrials.length,
      active: activeTrials.length,
      expired: expiredTrials.length,
      converted: convertedTrials.length,
      cancelled: cancelledTrials.length,
      conversion_rate: Math.round(conversionRate * 10) / 10,
      avg_days_to_convert: Math.round(avgDaysToConvert * 10) / 10,
      expiring_soon: expiringSoon.length,
      expiring_soon_list: expiringSoon.map(t => ({
        merchant_id: t.merchant_id,
        days_left: Math.ceil((new Date(t.expires_at) - now) / 86400000),
      })),
    };
  }

  /**
   * Send trial expiry reminders (called by scheduler).
   */
  async function getExpiringTrials(daysBeforeExpiry = 3) {
    const now = new Date();
    const cutoff = new Date(now.getTime() + daysBeforeExpiry * 86400000);

    const activeTrials = await store.trials.find({ status: "active" });
    return activeTrials.filter(t => {
      const expiresAt = new Date(t.expires_at);
      return expiresAt <= cutoff && expiresAt > now;
    });
  }

  /**
   * Get feature access map for a trial status.
   */
  function getFeatureAccess(status, daysRemaining) {
    if (status === "converted" || status === "cancelled") {
      return { full: TRIAL_FEATURES.full, limited: [], restricted: [] };
    }

    if (status === "expired") {
      return { full: [], limited: [], restricted: [...TRIAL_FEATURES.full, ...TRIAL_FEATURES.limited] };
    }

    // Active trial
    return {
      full: TRIAL_FEATURES.full,
      limited: TRIAL_FEATURES.limited,
      restricted: TRIAL_FEATURES.none,
      days_remaining: daysRemaining,
    };
  }

  return {
    startTrial,
    getTrialStatus,
    canAccessFeature,
    convertTrial,
    cancelTrial,
    getAnalytics,
    getExpiringTrials,
    TRIAL_DURATION_DAYS,
    TRIAL_FEATURES,
  };
}

module.exports = { createTrialService };
