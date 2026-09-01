'use strict';

/**
 * Consent Management Service
 *
 * Central authority for customer consent state across all messaging
 * channels (email, WhatsApp, push). Every send path must check
 * consent before delivery.
 *
 * Consent categories align with Shopify's protected-customer-data
 * requirements and Meta's WhatsApp Business Policy.
 *
 * Categories:
 *   - analytics:     behavioral tracking (page_view, product_view)
 *   - marketing:     promotional email/WhatsApp/push
 *   - recovery:      transactional cart/checkout recovery
 *   - essential:     always permitted (order confirmations, privacy)
 */

const crypto = require('crypto',);

const CONSENT_CATEGORIES = ['analytics', 'marketing', 'recovery', 'essential',];

const CHANNELS = ['email', 'whatsapp', 'push',];

/**
 * Consent levels required per event type.
 * "essential" is always implied; "recovery" requires at least recovery
 * consent; "marketing" requires explicit marketing consent.
 */
const EVENT_CONSENT_LEVEL = {
  page_view: 'analytics',
  product_view: 'analytics',
  cart_updated: 'analytics',
  cart_abandoned: 'recovery',
  checkout_started: 'recovery',
  checkout_completed: 'essential',
  purchase: 'essential',
  search: 'analytics',
  email_opened: 'marketing',
  email_clicked: 'marketing',
  whatsapp_sent: 'recovery',
  whatsapp_read: 'recovery',
  whatsapp_replied: 'recovery',
  push_sent: 'marketing',
  push_opened: 'marketing',
  competitor_view: 'analytics',
  refund: 'essential',
};

/**
 * Message classification: transactional/recovery messages can be sent
 * with recovery consent; marketing messages require marketing consent.
 */
const MESSAGE_CLASSIFICATION = {
  cart_recovery: 'recovery',
  recovery_message: 'recovery',
  checkout_recovery: 'recovery',
  checkout_nudge: 'recovery',
  browse_recovery: 'recovery',
  browse_abandonment: 'recovery',
  order_confirmation: 'essential',
  shipping_update: 'essential',
  promotional: 'marketing',
  campaign: 'marketing',
  win_back: 'marketing',
  winback_offer: 'marketing',
  vip_offer: 'marketing',
  vip_surprise: 'marketing',
};

function createConsentService({ store, },) {
  return {
    CONSENT_CATEGORIES,
    CHANNELS,
    EVENT_CONSENT_LEVEL,
    MESSAGE_CLASSIFICATION,

    /**
     * Get or create the consent record for a customer at an installation.
     */
    async getConsent(shopInstallationId, customerIdentity,) {
      if (!shopInstallationId || !customerIdentity) return null;
      const existing = await store.consentRecords.findOne({
        shopInstallationId,
        customerIdentity,
      },);
      return existing || null;
    },

    /**
     * Record or update consent for a customer.
     * categories is an object: { analytics: true, marketing: false, recovery: true }
     */
    async setConsent(shopInstallationId, customerIdentity, categories, meta = {},) {
      if (!shopInstallationId || !customerIdentity) {
        throw new Error('shopInstallationId and customerIdentity are required.',);
      }

      const existing = await store.consentRecords.findOne({
        shopInstallationId,
        customerIdentity,
      },);

      const consent = {
        analytics: false,
        marketing: false,
        recovery: false,
        ...(existing?.categories || {}),
        ...categories,
      };

      // essential is always true — it cannot be revoked
      consent.essential = true;

      const record = {
        shopInstallationId,
        customerIdentity: String(customerIdentity,).toLowerCase().trim(),
        categories: consent,
        granted_at: new Date().toISOString(),
        source: meta.source || 'merchant', // merchant, customer_self_service, implied
        ip_or_ua: meta.ip_or_ua || null,
        updated_at: new Date().toISOString(),
      };

      if (existing) {
        return store.consentRecords.update(existing._id, record,);
      }
      return store.consentRecords.insert(record,);
    },

    /**
     * Check whether a specific consent category is granted.
     * "essential" always returns true.
     * Default: when no consent record exists, all categories are
     * considered granted (implied consent). Once a merchant creates
     * an explicit consent record, only granted categories are allowed.
     */
    async hasConsent(shopInstallationId, customerIdentity, category,) {
      if (category === 'essential') return true;
      if (!CONSENT_CATEGORIES.includes(category,)) return false;

      const record = await this.getConsent(shopInstallationId, customerIdentity,);
      if (!record) {
        // No explicit consent record: implied consent (default allow).
        // This preserves backward compatibility and only enforces once
        // the merchant has configured explicit consent management.
        return true;
      }
      return record.categories[category] === true;
    },

    /**
     * Check whether a message of a given classification can be sent
     * to this customer on this channel.
     */
    async canSend(shopInstallationId, customerIdentity, messageClassification, channel,) {
      const requiredCategory = MESSAGE_CLASSIFICATION[messageClassification] || 'marketing';
      const hasCategory = await this.hasConsent(shopInstallationId, customerIdentity, requiredCategory,);
      if (!hasCategory) return { allowed: false, reason: `missing_${requiredCategory}_consent`, };

      // Check channel-specific suppression
      const suppressed = await this.isChannelSuppressed(shopInstallationId, customerIdentity, channel,);
      if (suppressed) return { allowed: false, reason: 'channel_suppressed', };

      return { allowed: true, category: requiredCategory, };
    },

    /**
     * Check whether an event type requires consent that the customer
     * has not granted. Used by the tracker to gate behavioral events.
     */
    async canTrackEvent(shopInstallationId, customerIdentity, eventType,) {
      const requiredCategory = EVENT_CONSENT_LEVEL[eventType] || 'analytics';
      const has = await this.hasConsent(shopInstallationId, customerIdentity, requiredCategory,);
      return { allowed: has, category: requiredCategory, };
    },

    /**
     * Revoke all consent for a customer (e.g. on redact/uninstall).
     */
    async revokeAllConsent(shopInstallationId, customerIdentity,) {
      const existing = await store.consentRecords.findOne({
        shopInstallationId,
        customerIdentity,
      },);
      if (!existing) return { revoked: false, };

      return store.consentRecords.update(existing._id, {
        categories: { analytics: false, marketing: false, recovery: false, essential: true, },
        revoked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },);
    },

    /**
     * Revoke consent for a specific installation (on app uninstall).
     * Marks all customer records for that installation as revoked.
     */
    async revokeInstallationConsent(shopInstallationId,) {
      const records = await store.consentRecords.find({ shopInstallationId, },);
      let count = 0;
      for (const r of records) {
        await store.consentRecords.update(r._id, {
          categories: { analytics: false, marketing: false, recovery: false, essential: true, },
          revoked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },);
        count++;
      }
      return { revoked: true, count, };
    },

    // ── Channel-level suppression (opt-out) ──────────────────────────

    /**
     * Suppress a customer on a specific channel (e.g. WhatsApp opt-out).
     */
    async suppressChannel(shopInstallationId, customerIdentity, channel, reason = 'OPT_OUT',) {
      if (!CHANNELS.includes(channel,)) throw new Error(`Unknown channel: ${channel}`,);

      const existing = await store.channelSuppressions.findOne({
        shopInstallationId,
        customerIdentity: String(customerIdentity,).toLowerCase().trim(),
        channel,
      },);

      if (existing) {
        return store.channelSuppressions.update(existing._id, {
          reason,
          suppressed_at: new Date().toISOString(),
        },);
      }

      return store.channelSuppressions.insert({
        shopInstallationId,
        customerIdentity: String(customerIdentity,).toLowerCase().trim(),
        channel,
        reason,
        suppressed_at: new Date().toISOString(),
      },);
    },

    /**
     * Check if a customer is suppressed on a channel.
     */
    async isChannelSuppressed(shopInstallationId, customerIdentity, channel,) {
      const record = await store.channelSuppressions.findOne({
        shopInstallationId,
        customerIdentity: String(customerIdentity,).toLowerCase().trim(),
        channel,
      },);
      // If the record was uns-suppressed, it's no longer active.
      if (record && record.unsuppressed_at) return false;
      return !!record;
    },

    /**
     * Remove channel suppression (re-opt-in).
     */
    async unsuppressChannel(shopInstallationId, customerIdentity, channel,) {
      const existing = await store.channelSuppressions.findOne({
        shopInstallationId,
        customerIdentity: String(customerIdentity,).toLowerCase().trim(),
        channel,
      },);
      if (!existing) return { unsuppressed: false, };
      await store.channelSuppressions.update(existing._id, {
        unsuppressed_at: new Date().toISOString(),
      },);
      return { unsuppressed: true, };
    },

    /**
     * Global email suppression (cross-installation do-not-send).
     */
    async isEmailGloballySuppressed(email,) {
      const normalized = String(email || '',).toLowerCase().trim();
      if (!normalized) return false;
      const record = await store.emailSuppressions.findOne({ email: normalized, },);
      return !!record;
    },

    async suppressEmailGlobally(email, options = {},) {
      const normalized = String(email || '',).toLowerCase().trim();
      if (!normalized || !normalized.includes('@',)) {
        throw new Error('Invalid email address.',);
      }
      const existing = await store.emailSuppressions.findOne({ email: normalized, },);
      if (existing) return { email: normalized, suppressed: true, existing: true, };

      return store.emailSuppressions.insert({
        email: normalized,
        reason: options.reason || 'UNSUBSCRIBE',
        source: options.source || 'SELF_SERVICE',
        shopInstallationId: options.shopInstallationId || null,
        suppressed_at: new Date().toISOString(),
      },);
    },

    /**
     * Build a tamper-proof unsubscribe token.
     */
    buildUnsubscribeToken(email, shopInstallationId,) {
      const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.SHOPIFY_API_SECRET || '';
      if (!secret) return '';
      const payload = Buffer.from(
        JSON.stringify({ e: email.toLowerCase().trim(), i: shopInstallationId || '', },),
      )
        .toString('base64',)
        .replace(/\+/g, '-',)
        .replace(/\//g, '_',)
        .replace(/=+$/, '',);
      const sig = crypto
        .createHmac('sha256', secret,)
        .update(payload,)
        .digest('base64',)
        .replace(/\+/g, '-',)
        .replace(/\//g, '_',)
        .replace(/=+$/, '',);
      return `${payload}.${sig}`;
    },

    /**
     * Verify and parse an unsubscribe token. Returns null if invalid.
     */
    parseUnsubscribeToken(token,) {
      try {
        const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.SHOPIFY_API_SECRET || '';
        if (!secret) return null;
        const raw = String(token || '',).trim();
        const dot = raw.lastIndexOf('.',);
        if (dot <= 0) return null;
        const payload = raw.slice(0, dot,);
        const signature = raw.slice(dot + 1,);
        const expected = crypto
          .createHmac('sha256', secret,)
          .update(payload,)
          .digest('base64',)
          .replace(/\+/g, '-',)
          .replace(/\//g, '_',)
          .replace(/=+$/, '',);
        const a = Buffer.from(signature,);
        const b = Buffer.from(expected,);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b,)) return null;
        const decoded = JSON.parse(
          Buffer.from(payload.replace(/-/g, '+',).replace(/_/g, '/',), 'base64',).toString('utf8',),
        );
        if (!decoded.e || !decoded.e.includes('@',)) return null;
        return { email: decoded.e.toLowerCase().trim(), shopInstallationId: decoded.i || null, };
      } catch {
        return null;
      }
    },
  };
}

module.exports = {
  createConsentService,
  CONSENT_CATEGORIES: ['analytics', 'marketing', 'recovery', 'essential',],
  CHANNELS: ['email', 'whatsapp', 'push',],
};
