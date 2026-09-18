'use strict';

/**
 * Shopify App Bridge session token verification.
 *
 * Admin UI Extensions and embedded apps authenticate with a short-lived
 * JWT ("session token") minted by Shopify and sent as
 * `Authorization: Bearer <jwt>`. That token is signed with the app's
 * client secret using HS256, so it can be verified with `node:crypto`
 * alone — no JWT dependency needed.
 *
 * Without this, an embedded extension has no way to prove which shop it
 * is acting for, and naively trusting the token would let anyone forge
 * one for any tenant.
 *
 * Verified claims (all required by Shopify's spec):
 *   alg === 'HS256'          signature algorithm
 *   signature                HMAC-SHA256 over `header.payload`
 *   aud                      === our client_id (the app's API key)
 *   exp / nbf                expiry + not-before, with small clock skew
 *   dest                     https://<shop>.myshopify.com  -> shop domain
 *   iss                      https://<shop>.myshopify.com/admin
 */

const crypto = require('node:crypto',);

/** Tolerate small clock drift between us and Shopify. */
const CLOCK_SKEW_SEC = 5;

/** A myshopify domain, optionally with a port for local dev. */
const SHOP_HOST_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/** Decode a base64url JWT segment into JSON, or null if malformed. */
function decodeSegment(segment,) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url',).toString('utf8',),);
  } catch {
    return null;
  }
}

/** Hostname of an absolute URL, or null. */
function hostOf(value,) {
  if (!value || typeof value !== 'string') return null;
  try {
    return new URL(value,).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Normalize a shop identifier to its bare `*.myshopify.com` domain.
 * Accepts a full URL (as sent in `dest`) or a bare domain.
 */
function normalizeShop(value,) {
  if (!value || typeof value !== 'string') return null;
  const host = hostOf(value,) || value.trim().toLowerCase();
  return SHOP_HOST_RE.test(host,) ? host : null;
}

/**
 * @param {object} deps
 * @param {(platform: string) => Promise<{client_id: string, client_secret: string}|null>} deps.credentialsFor
 * @param {(msg: string) => void} [deps.warn]  sink for rejection reasons
 */
function createSessionTokenVerifier({ credentialsFor, warn = () => {}, },) {
  /**
   * Timing-safe HMAC-SHA256 check over `header.payload`.
   * Returns false for any malformed input rather than throwing.
   */
  function signatureIsValid(rawHeader, rawPayload, rawSignature, secret,) {
    const expected = crypto
      .createHmac('sha256', secret,)
      .update(`${rawHeader}.${rawPayload}`,)
      .digest();
    const actual = Buffer.from(rawSignature, 'base64url',);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual,);
  }

  /**
   * Verify a session token.
   *
   * @returns {Promise<{shop_domain: string, user_id: string|null,
   *   expires_at: number|null, claims: object}|null>}
   *   null when the token is missing, malformed, or fails any check.
   */
  async function verify(token,) {
    if (typeof token !== 'string' || !token) return null;

    const parts = token.split('.',);
    if (parts.length !== 3) return null;
    const [rawHeader, rawPayload, rawSignature,] = parts;

    const header = decodeSegment(rawHeader,);
    const payload = decodeSegment(rawPayload,);
    if (!header || !payload) {
      warn('session token: undecodable header or payload',);
      return null;
    }

    if (header.alg !== 'HS256') {
      warn(`session token: unexpected alg "${header.alg}"`,);
      return null;
    }

    const credentials = await credentialsFor('shopify',);
    if (!credentials?.client_secret) {
      // No credentials configured means we cannot verify anything. Fail
      // closed — never accept an unverifiable token.
      warn('session token: shopify client credentials not configured',);
      return null;
    }

    if (!signatureIsValid(rawHeader, rawPayload, rawSignature, credentials.client_secret,)) {
      warn('session token: signature mismatch',);
      return null;
    }

    const now = Math.floor(Date.now() / 1000,);

    // `exp` is REQUIRED by Shopify's session-token spec. This used to be
    // `typeof payload.exp === 'number' && ...`, so a token with no `exp` at
    // all skipped the expiry check and was accepted indefinitely. Absence must
    // be a rejection, not a bypass.
    if (!Number.isFinite(payload.exp,)) {
      warn('session token: missing or non-numeric exp',);
      return null;
    }
    if (payload.exp + CLOCK_SKEW_SEC < now) {
      warn('session token: expired',);
      return null;
    }

    // `nbf` is optional in JWT, so absence is fine here — but a present,
    // malformed value is not.
    if (payload.nbf !== undefined && !Number.isFinite(payload.nbf,)) {
      warn('session token: non-numeric nbf',);
      return null;
    }
    if (Number.isFinite(payload.nbf,) && payload.nbf - CLOCK_SKEW_SEC > now) {
      warn('session token: not yet valid',);
      return null;
    }

    // `aud` must be our own client id, otherwise a token minted for a
    // different app would be accepted here.
    if (!credentials.client_id || payload.aud !== credentials.client_id) {
      warn('session token: audience mismatch',);
      return null;
    }

    const shopDomain = normalizeShop(payload.dest,) || normalizeShop(payload.iss,);
    if (!shopDomain) {
      warn('session token: no usable shop domain in dest/iss',);
      return null;
    }

    return {
      shop_domain: shopDomain,
      user_id: payload.sub || null,
      expires_at: payload.exp,
      claims: payload,
    };
  }

  return { verify, };
}

module.exports = { createSessionTokenVerifier, normalizeShop, };
