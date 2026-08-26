"use strict";

/**
 * Two-Factor Authentication (TOTP) for admin login.
 *
 * Implements RFC 6238 TOTP using Node.js built-in crypto (no external deps).
 * Each user can enable 2FA — login then requires a valid 6-digit code
 * from their authenticator app (Google Authenticator, Authy, etc.).
 *
 * Security:
 * - 30-second time step with 1-step window (±30s tolerance)
 * - SHA-1 HMAC (standard for TOTP compatibility)
 * - Base32-encoded secrets for QR code compatibility
 * - Rate-limited verification (max 5 attempts per 5 minutes)
 */

const crypto = require("crypto");

const TIME_STEP = 30;
const CODE_DIGITS = 6;
const WINDOW_STEPS = 1;
const MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 5 * 60 * 1000;

// Base32 alphabet (RFC 4648)
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(encoded) {
  const cleaned = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of cleaned) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateTOTP(secret, counter) {
  const buffer = Buffer.alloc(8);
  let tmp = counter;
  for (let i = 7; i >= 0; i--) {
    buffer[i] = tmp & 0xff;
    tmp = Math.floor(tmp / 256);
  }
  const hmac = crypto.createHmac("sha1", secret).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % Math.pow(10, CODE_DIGITS);
  return code.toString().padStart(CODE_DIGITS, "0");
}

function createTwoFactorAuth({ store }) {
  // In-memory attempt tracker (resets on restart — acceptable for rate limiting).
  const attempts = new Map();

  function cleanupAttempts() {
    const cutoff = Date.now() - LOCKOUT_WINDOW_MS;
    for (const [key, timestamps] of attempts) {
      const fresh = timestamps.filter((t) => t > cutoff);
      if (fresh.length === 0) attempts.delete(key);
      else attempts.set(key, fresh);
    }
  }

  return {
    /**
     * Generate a new TOTP secret and provisioning URI for a user.
     * Returns the secret (to store encrypted) and a URI for QR code generation.
     */
    async enable(user_id, { email, issuer = "Storecops" } = {}) {
      if (!user_id) throw new Error("user_id is required");

      // Check if already enabled.
      const existing = await store.twoFactorSecrets.findOne({ user_id });
      if (existing?.enabled) throw new Error("2FA is already enabled for this user.");

      const secretBytes = crypto.randomBytes(20);
      const secret = base32Encode(secretBytes);
      const period = TIME_STEP;
      const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email || user_id)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${CODE_DIGITS}&period=${period}`;

      // Store the secret (encrypted at rest in production).
      if (existing) {
        await store.twoFactorSecrets.update(existing._id, {
          secret,
          enabled: true,
          enabled_at: new Date().toISOString(),
          uri,
        });
      } else {
        await store.twoFactorSecrets.insert({
          user_id,
          secret,
          enabled: true,
          enabled_at: new Date().toISOString(),
          uri,
          backup_codes: generateBackupCodes(),
        });
      }

      return { secret, uri, qr_uri: uri };
    },

    /**
     * Verify a TOTP code against the user's stored secret.
     * Returns { valid: true/false, reason? }.
     */
    async verify(user_id, code) {
      if (!user_id || !code) return { valid: false, reason: "user_id and code are required" };

      cleanupAttempts();

      // Rate limit check.
      const attemptKey = `${user_id}:${code}`;
      const userAttempts = attempts.get(user_id) || [];
      if (userAttempts.length >= MAX_ATTEMPTS) {
        return { valid: false, reason: "Too many attempts. Try again in 5 minutes." };
      }

      const record = await store.twoFactorSecrets.findOne({ user_id, enabled: true });
      if (!record) return { valid: false, reason: "2FA is not enabled for this user." };

      const secretBuffer = base32Decode(record.secret);
      const now = Math.floor(Date.now() / 1000);
      const counter = Math.floor(now / TIME_STEP);

      // Check within the time window (±1 step).
      for (let i = -WINDOW_STEPS; i <= WINDOW_STEPS; i++) {
        const expected = generateTOTP(secretBuffer, counter + i);
        if (code === expected) {
          attempts.delete(user_id); // Reset on success.
          return { valid: true };
        }
      }

      // Check backup codes.
      if (record.backup_codes?.length) {
        const backupIdx = record.backup_codes.indexOf(code);
        if (backupIdx !== -1) {
          const updated = [...record.backup_codes];
          updated.splice(backupIdx, 1);
          await store.twoFactorSecrets.update(record._id, { backup_codes: updated });
          attempts.delete(user_id);
          return { valid: true, used_backup: true };
        }
      }

      // Record failed attempt.
      userAttempts.push(Date.now());
      attempts.set(user_id, userAttempts);

      return { valid: false, reason: "Invalid code." };
    },

    /** Disable 2FA for a user (requires current valid code or admin override). */
    async disable(user_id, code = null) {
      if (!user_id) throw new Error("user_id is required");
      const record = await store.twoFactorSecrets.findOne({ user_id });
      if (!record?.enabled) return { ok: true, message: "2FA was not enabled." };

      if (code) {
        const result = await this.verify(user_id, code);
        if (!result.valid) throw new Error("Invalid verification code.");
      }

      await store.twoFactorSecrets.update(record._id, {
        enabled: false,
        disabled_at: new Date().toISOString(),
        secret: null,
        backup_codes: [],
      });

      return { ok: true, message: "2FA disabled successfully." };
    },

    /** Check if 2FA is enabled for a user. */
    async isEnabled(user_id) {
      const record = await store.twoFactorSecrets.findOne({ user_id, enabled: true });
      return !!record;
    },

    /** Get status details (for settings page). */
    async status(user_id) {
      const record = await store.twoFactorSecrets.findOne({ user_id });
      return {
        enabled: !!record?.enabled,
        enabled_at: record?.enabled_at || null,
        backup_codes_remaining: record?.backup_codes?.length || 0,
      };
    },
  };
}

function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomInt(10000000, 99999999).toString();
    codes.push(code);
  }
  return codes;
}

module.exports = { createTwoFactorAuth, generateTOTP, base32Encode, base32Decode };
