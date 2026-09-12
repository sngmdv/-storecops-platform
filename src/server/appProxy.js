'use strict';

/**
 * Shopify app proxy.
 *
 * Shopify forwards `https://{shop}/apps/{subpath}/*` to
 * `{app_url}/proxy/*`, appending `shop`, `path_prefix`, `timestamp` and
 * `signature` query parameters. This is how the storefront theme
 * extension reaches us without exposing an API key in Liquid.
 *
 * The signature is NOT the same scheme as the OAuth HMAC:
 *
 *   OAuth HMAC   — sorted `key=value` pairs joined with `&`
 *   App proxy    — sorted `key=value` pairs joined with NOTHING
 *
 * Getting that wrong silently rejects every storefront request, so the
 * two are kept in separate functions.
 */

const crypto = require('node:crypto',);

/** Build the app-proxy signature base string from a query object. */
function signatureBase(query,) {
  return Object.keys(query,)
    .filter((key,) => key !== 'signature',)
    .sort()
    .map((key,) => {
      const value = query[key];
      const flat = Array.isArray(value,) ? value.join(',',) : value;
      return `${key}=${flat ?? ''}`;
    },)
    .join('',);
}

/**
 * Verify a Shopify app-proxy request.
 * @returns {boolean}
 */
function verifyProxySignature(query, secret,) {
  const provided = query?.signature;
  if (!provided || !secret) return false;

  const expected = crypto
    .createHmac('sha256', secret,)
    .update(signatureBase(query,),)
    .digest('hex',);

  const a = Buffer.from(expected, 'utf8',);
  const b = Buffer.from(String(provided,), 'utf8',);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b,);
}

/**
 * @param {object} deps
 * @param {(platform: string) => Promise<{client_secret: string}|null>} deps.credentialsFor
 * @param {(shopDomain: string) => Promise<{store_id: string}|null>} deps.resolveTenant
 * @param {(msg: string) => void} [deps.warn]
 */
function createAppProxy({ credentialsFor, resolveTenant, warn = () => {}, },) {
  /**
   * Authenticate a proxy request and resolve the tenant it acts for.
   * @returns {Promise<{store_id: string, shop: string}|null>}
   */
  async function authenticate(req,) {
    const credentials = await credentialsFor('shopify',);
    if (!credentials?.client_secret) {
      warn('app proxy: shopify credentials not configured',);
      return null;
    }
    if (!verifyProxySignature(req.query, credentials.client_secret,)) {
      warn(`app proxy: bad signature for ${req.query?.shop || 'unknown shop'}`,);
      return null;
    }

    const shop = String(req.query?.shop || '',).toLowerCase();
    if (!shop) return null;

    const tenant = await resolveTenant(shop,);
    if (!tenant) {
      warn(`app proxy: no tenant for shop ${shop}`,);
      return null;
    }
    return { store_id: tenant.store_id, shop, };
  }

  /** Guard: 401 unless the proxy signature checks out. */
  async function requireProxy(req, res, next,) {
    const context = await authenticate(req,);
    if (!context) {
      return res.status(401,).json({ error: 'Invalid app proxy signature.', },);
    }
    req.proxyShop = context.shop;
    req.proxyStoreId = context.store_id;
    return next();
  }

  return { verifyProxySignature, authenticate, requireProxy, signatureBase, };
}

module.exports = { createAppProxy, verifyProxySignature, signatureBase, };
