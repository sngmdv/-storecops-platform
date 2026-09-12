'use strict';

/**
 * CORS for Shopify extension traffic.
 *
 * Admin UI Extensions and storefront widgets do NOT run on our origin —
 * they run inside Shopify's admin / storefront and call this API
 * cross-domain. Without CORS headers the browser blocks those calls
 * before they ever reach a route.
 *
 * Scope is deliberately narrow:
 *   - Only Shopify-owned origins are allowed by default (the admin, the
 *     extension CDN, and the merchant's own *.myshopify.com domain).
 *   - No `Access-Control-Allow-Credentials`, so the browser never sends
 *     cookies. Authentication stays a bearer token that JS must attach
 *     explicitly, which means a permissive origin list cannot be used to
 *     ride an ambient session.
 *   - Extra origins can be added via CORS_ALLOWED_ORIGINS for local
 *     development against a dev store.
 */

/** Origins that are always allowed, matched exactly. */
const STATIC_ALLOWED = new Set([
  'https://admin.shopify.com',
  'https://extensions.shopifycdn.com',
  'https://cdn.shopify.com',
],);

/** Patterns allowed by hostname. */
const HOST_ALLOWED = [
  /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i, // the merchant's own admin
  /^[a-z0-9-]+\.shopifypreview\.com$/i, // theme preview
];

/** Parse the comma-separated env override into a Set. */
function extraOrigins(env,) {
  return new Set(
    String(env.CORS_ALLOWED_ORIGINS || '',)
      .split(',',)
      .map((s,) => s.trim(),)
      .filter(Boolean,),
  );
}

/**
 * @param {object} opts
 * @param {object} opts.env               process.env-like source
 * @param {string} [opts.publicUrl]       the app's own origin
 * @param {(msg: string) => void} [opts.warn]
 */
function createCorsMiddleware({ env = process.env, publicUrl, warn = () => {}, } = {},) {
  const extra = extraOrigins(env,);
  const ownOrigin = publicUrl ? safeOrigin(publicUrl,) : null;

  /** Hostname-safe parse of an origin URL. */
  function safeOrigin(value,) {
    try {
      return new URL(value,).origin;
    } catch {
      return null;
    }
  }

  /** Is this request origin one we serve CORS headers to? */
  function isAllowed(origin,) {
    if (!origin) return false;
    if (origin === ownOrigin) return true;
    if (STATIC_ALLOWED.has(origin,)) return true;
    if (extra.has(origin,)) return true;
    // Local development against the app itself.
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin,)) return true;
    try {
      const host = new URL(origin,).hostname;
      return HOST_ALLOWED.some((re,) => re.test(host,),);
    } catch {
      return false;
    }
  }

  return function corsMiddleware(req, res, next,) {
    const origin = req.get('Origin',);

    if (origin && isAllowed(origin,)) {
      // Reflect the specific origin (rather than "*") so the response
      // stays cacheable per-origin and the allowlist is auditable.
      res.setHeader('Access-Control-Allow-Origin', origin,);
      res.setHeader('Vary', 'Origin',);
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-API-Key, X-Requested-With',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS',);
      res.setHeader('Access-Control-Max-Age', '600',);
      // Intentionally NO Access-Control-Allow-Credentials: auth is a
      // bearer token, never an ambient cookie.
    } else if (origin) {
      warn(`cors: blocked origin ${origin}`,);
    }

    // Answer preflight without touching the auth chain — a preflight
    // never carries credentials, so gating it would break every
    // extension request.
    if (req.method === 'OPTIONS') {
      return res.status(204,).end();
    }

    return next();
  };
}

module.exports = { createCorsMiddleware, };
