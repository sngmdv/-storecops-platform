'use strict';

/**
 * Secret Rotation & Revocation Service
 *
 * Manages the lifecycle of all long-lived secrets and tokens:
 *   - Shopify access tokens (canonical, per-installation)
 *   - Meta/WhatsApp access tokens
 *   - API keys (master and tenant)
 *   - Ingest keys (write-only, for tracking snippet)
 *   - OAuth connector client secrets
 *
 * Task 27: Add secret rotation/revocation procedures
 */

const crypto = require('crypto',);

const SECRET_TYPES = {
  SHOPIFY_ACCESS_TOKEN: 'shopify_access_token',
  META_ACCESS_TOKEN: 'meta_access_token',
  WHATSAPP_TOKEN: 'whatsapp_token',
  API_KEY: 'api_key',
  INGEST_KEY: 'ingest_key',
  OAUTH_CLIENT_SECRET: 'oauth_client_secret',
  WEBHOOK_SECRET: 'webhook_secret',
};

const ROTATION_REASONS = {
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
  COMPROMISED: 'compromised',
  EMPLOYEE_DEPARTED: 'employee_departed',
  SECURITY_INCIDENT: 'security_incident',
};

function createSecretRotationService({ store, auditLog, },) {
  return {
    SECRET_TYPES,
    ROTATION_REASONS,

    /**
     * Record a secret in the rotation ledger. This tracks when each
     * secret was issued, when it expires, and whether it has been revoked.
     */
    async recordSecret(shopInstallationId, secretType, meta = {},) {
      const record = {
        shopInstallationId: shopInstallationId || null,
        secretType,
        fingerprint: meta.fingerprint || crypto.randomBytes(8,).toString('hex',),
        issued_at: new Date().toISOString(),
        expires_at: meta.expires_at || null,
        rotated_at: null,
        revoked: false,
        revoked_at: null,
        rotation_reason: null,
        rotated_by: meta.rotated_by || null,
        notes: meta.notes || null,
      };

      await store.secretLedger.insert(record,);
      return record;
    },

    /**
     * Revoke a specific secret by fingerprint.
     */
    async revokeSecret(fingerprint, options = {},) {
      const record = await store.secretLedger.findOne({ fingerprint, },);
      if (!record) return { revoked: false, reason: 'not_found', };
      if (record.revoked) return { revoked: true, already: true, };

      const updated = await store.secretLedger.update(record._id, {
        revoked: true,
        revoked_at: new Date().toISOString(),
        rotation_reason: options.reason || ROTATION_REASONS.MANUAL,
        rotated_by: options.rotated_by || 'system',
        notes: options.notes || null,
      },);

      if (auditLog) {
        await auditLog.record(
          options.rotated_by || 'system',
          'secret_revoked',
          {
            secretType: record.secretType,
            shopInstallationId: record.shopInstallationId,
            fingerprint: record.fingerprint,
            reason: options.reason || ROTATION_REASONS.MANUAL,
          },
        );
      }

      return { revoked: true, record: updated, };
    },

    /**
     * Revoke all secrets for a shop installation (e.g. on uninstall).
     */
    async revokeAllSecrets(shopInstallationId, options = {},) {
      const records = await store.secretLedger.find(
        (r,) => r.shopInstallationId === shopInstallationId && !r.revoked,
      );

      let count = 0;
      for (const record of records) {
        await store.secretLedger.update(record._id, {
          revoked: true,
          revoked_at: new Date().toISOString(),
          rotation_reason: options.reason || ROTATION_REASONS.MANUAL,
          rotated_by: options.rotated_by || 'system',
        },);
        count++;
      }

      if (auditLog && count > 0) {
        await auditLog.record(
          options.rotated_by || 'system',
          'all_secrets_revoked',
          {
            shopInstallationId,
            count,
            reason: options.reason || ROTATION_REASONS.MANUAL,
          },
        );
      }

      return { revoked: true, count, };
    },

    /**
     * Rotate a Shopify access token: revoke the old one and record the new.
     */
    async rotateShopifyToken(shopInstallationId, newToken, options = {},) {
      // Revoke existing active tokens for this installation
      await this.revokeAllSecrets(shopInstallationId, {
        reason: options.reason || ROTATION_REASONS.MANUAL,
        rotated_by: options.rotated_by || 'system',
      },);

      // Compute a fingerprint (first 8 chars of SHA-256 hash — never store full token)
      const fingerprint = crypto
        .createHash('sha256',)
        .update(newToken,)
        .digest('hex',)
        .slice(0, 16,);

      await this.recordSecret(shopInstallationId, SECRET_TYPES.SHOPIFY_ACCESS_TOKEN, {
        fingerprint,
        expires_at: options.expires_at || null,
        rotated_by: options.rotated_by || 'system',
      },);

      return { rotated: true, fingerprint, };
    },

    /**
     * Rotate an API key for a tenant.
     */
    async rotateApiKey(shopInstallationId, options = {},) {
      await this.revokeAllSecrets(shopInstallationId, {
        reason: options.reason || ROTATION_REASONS.MANUAL,
        rotated_by: options.rotated_by || 'system',
      },);

      const newKey = `sk_${crypto.randomBytes(24,).toString('hex',)}`;
      const fingerprint = crypto
        .createHash('sha256',)
        .update(newKey,)
        .digest('hex',)
        .slice(0, 16,);

      await this.recordSecret(shopInstallationId, SECRET_TYPES.API_KEY, {
        fingerprint,
        rotated_by: options.rotated_by || 'system',
      },);

      return { rotated: true, newKey, fingerprint, };
    },

    /**
     * Generate a new write-only ingest key.
     */
    async generateIngestKey(shopInstallationId, options = {},) {
      const newKey = `pub_${crypto.randomBytes(12,).toString('hex',)}`;
      const fingerprint = crypto
        .createHash('sha256',)
        .update(newKey,)
        .digest('hex',)
        .slice(0, 16,);

      await this.recordSecret(shopInstallationId, SECRET_TYPES.INGEST_KEY, {
        fingerprint,
        rotated_by: options.rotated_by || 'system',
      },);

      return { generated: true, newKey, fingerprint, };
    },

    /**
     * List all secrets for a shop installation (audit view).
     * Never returns actual secret values — only fingerprints and metadata.
     */
    async listSecrets(shopInstallationId,) {
      const records = await store.secretLedger.find({ shopInstallationId, },);
      return records
        .sort((a, b,) => b.issued_at.localeCompare(a.issued_at,),)
        .map((r,) => ({
          secretType: r.secretType,
          fingerprint: r.fingerprint,
          issued_at: r.issued_at,
          expires_at: r.expires_at,
          revoked: r.revoked,
          revoked_at: r.revoked_at,
          rotation_reason: r.rotation_reason,
        }),);
    },

    /**
     * Check if a secret (by fingerprint) is still valid.
     */
    async isSecretValid(fingerprint,) {
      const record = await store.secretLedger.findOne({ fingerprint, },);
      if (!record) return false;
      if (record.revoked) return false;
      if (record.expires_at && new Date(record.expires_at,) < new Date()) return false;
      return true;
    },

    /**
     * Find secrets nearing expiration (within N days).
     */
    async getExpiringSecrets(withinDays = 14,) {
      const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000,).toISOString();
      const records = await store.secretLedger.find(
        (r,) => !r.revoked && r.expires_at && r.expires_at <= cutoff,
      );
      return records.map((r,) => ({
        shopInstallationId: r.shopInstallationId,
        secretType: r.secretType,
        fingerprint: r.fingerprint,
        expires_at: r.expires_at,
        days_until_expiry: Math.ceil(
          (new Date(r.expires_at,) - Date.now()) / (24 * 60 * 60 * 1000),
        ),
      }),);
    },
  };
}

module.exports = { createSecretRotationService, SECRET_TYPES, ROTATION_REASONS, };
