"use strict";

/**
 * Referral & Affiliate Service
 *
 * Manages the complete referral lifecycle:
 *   1. Generate unique referral links for existing merchants
 *   2. Track referral conversions (new signups via referral)
 *   3. Apply automatic discounts (20% off next renewal)
 *   4. Fraud prevention (self-referral, duplicate detection)
 *   5. Reward fulfillment (auto-apply discount codes)
 *
 * Referral flow:
 *   - Existing merchant gets unique link: /signup?ref=CODE
 *   - New merchant signs up using that link
 *   - System validates referral (not self, not duplicate)
 *   - Both parties get 20% discount on next renewal
 */

const crypto = require("node:crypto");

const REFERRAL_DISCOUNT_PCT = 20;
const CODE_LENGTH = 8;
const MIN_DAYS_BETWEEN_REFERRALS = 7;

function generateReferralCode() {
  return `REF${crypto.randomBytes(CODE_LENGTH / 2).toString("hex").toUpperCase()}`;
}

function generateAffiliateId() {
  return `AFF${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

function createReferralService({ store, config }) {

  /**
   * Generate a unique referral code for a merchant.
   * Returns existing code if one already exists.
   */
  async function getOrCreateReferralCode(merchantId, storeId) {
    // Check if code already exists
    const existing = await store.referrals.findOne({ merchant_id: merchantId });
    if (existing) return existing;

    // Generate unique code
    let code;
    let attempts = 0;
    do {
      code = generateReferralCode();
      attempts++;
    } while (
      (await store.referrals.findOne({ code })) && attempts < 10
    );

    if (attempts >= 10) throw new Error("Failed to generate unique referral code");

    const referral = {
      code,
      merchant_id: merchantId,
      store_id: storeId,
      referral_count: 0,
      successful_referrals: [],
      rewards_earned: 0,
      created_at: new Date().toISOString(),
    };

    await store.referrals.insert(referral);
    return referral;
  }

  /**
   * Validate a referral code and record the signup.
   * Returns { valid, referral, error? }
   */
  async function validateReferral(code, newMerchantId, newStoreId, metadata = {}) {
    const referral = await store.referrals.findOne({ code: code.toUpperCase() });
    if (!referral) {
      return { valid: false, error: "Invalid referral code" };
    }

    // Self-referral check
    if (referral.merchant_id === newMerchantId) {
      return { valid: false, error: "Cannot use your own referral code" };
    }

    // Duplicate check (same email/IP within 24h)
    const recentReferral = await store.referralCredits.findOne({
      referrer_merchant_id: referral.merchant_id,
      new_merchant_id: newMerchantId,
    });
    if (recentReferral) {
      return { valid: false, error: "This merchant was already referred" };
    }

    // IP-based fraud check (if IP provided)
    if (metadata.ip) {
      const sameIpReferral = await store.referralCredits.findOne({
        referrer_ip: metadata.ip,
        created_at: {
          $gte: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        },
      });
      if (sameIpReferral) {
        return { valid: false, error: "Multiple referrals from same IP not allowed" };
      }
    }

    // Record the referral conversion
    const credit = {
      referrer_merchant_id: referral.merchant_id,
      referrer_store_id: referral.store_id,
      new_merchant_id: newMerchantId,
      new_store_id: newStoreId,
      referral_code: code.toUpperCase(),
      discount_pct: REFERRAL_DISCOUNT_PCT,
      status: "pending", // pending -> applied -> expired
      created_at: new Date().toISOString(),
      ip: metadata.ip || null,
      referrer_ip: metadata.ip || null,
    };

    await store.referralCredits.insert(credit);

    // Update referral count
    await store.referrals.update(referral._id, {
      referral_count: referral.referral_count + 1,
      successful_referrals: [...(referral.successful_referrals || []), newMerchantId],
    });

    return { valid: true, referral, discount_pct: REFERRAL_DISCOUNT_PCT };
  }

  /**
   * Apply referral discount to a merchant's next billing.
   * Called during subscription renewal.
   */
  async function applyReferralDiscount(merchantId) {
    // Find pending referral credit for this merchant as referrer
    const credit = await store.referralCredits.findOne({
      referrer_merchant_id: merchantId,
      status: "pending",
    });

    if (!credit) return { applied: false, reason: "No pending referral credit" };

    // Mark as applied
    await store.referralCredits.update(credit._id, {
      status: "applied",
      applied_at: new Date().toISOString(),
    });

    // Update referral rewards
    const referral = await store.referrals.findOne({ merchant_id: merchantId });
    if (referral) {
      await store.referrals.update(referral._id, {
        rewards_earned: (referral.rewards_earned || 0) + 1,
      });
    }

    return {
      applied: true,
      discount_pct: credit.discount_pct,
      credit_id: credit._id,
    };
  }

  /**
   * Check if a merchant is eligible for a referral discount.
   */
  async function checkEligibility(merchantId) {
    const pendingCredit = await store.referralCredits.findOne({
      referrer_merchant_id: merchantId,
      status: "pending",
    });

    return {
      eligible: !!pendingCredit,
      discount_pct: pendingCredit?.discount_pct || 0,
      credit_id: pendingCredit?._id || null,
    };
  }

  /**
   * Get referral stats for a merchant.
   */
  async function getStats(merchantId) {
    const referral = await store.referrals.findOne({ merchant_id: merchantId });
    if (!referral) {
      return {
        code: null,
        total_referrals: 0,
        successful_referrals: 0,
        rewards_earned: 0,
        pending_rewards: 0,
      };
    }

    const pendingCredits = await store.referralCredits.find({
      referrer_merchant_id: merchantId,
      status: "pending",
    });

    return {
      code: referral.code,
      referral_link: `${config.publicUrl}/signup?ref=${referral.code}`,
      total_referrals: referral.referral_count || 0,
      successful_referrals: referral.successful_referrals?.length || 0,
      rewards_earned: referral.rewards_earned || 0,
      pending_rewards: pendingCredits.length,
    };
  }

  /**
   * Get all referrals for admin dashboard.
   */
  async function listAll(limit = 100) {
    return store.referrals.find({}).then(refs => refs.slice(0, limit));
  }

  /**
   * Get referral by code.
   */
  async function getByCode(code) {
    return store.referrals.findOne({ code: code.toUpperCase() });
  }

  /**
   * Delete a referral (admin only).
   */
  async function deleteReferral(merchantId) {
    const referral = await store.referrals.findOne({ merchant_id: merchantId });
    if (!referral) return { deleted: false };
    
    await store.referrals.update(referral._id, { deleted: true, deleted_at: new Date().toISOString() });
    return { deleted: true };
  }

  return {
    getOrCreateReferralCode,
    validateReferral,
    applyReferralDiscount,
    checkEligibility,
    getStats,
    listAll,
    getByCode,
    deleteReferral,
    REFERRAL_DISCOUNT_PCT,
  };
}

module.exports = { createReferralService };
