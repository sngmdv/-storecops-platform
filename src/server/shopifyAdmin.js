'use strict';

/**
 * Shopify Admin GraphQL client — the single door to the Admin API.
 *
 * New public Shopify apps must use the GraphQL Admin API exclusively; the
 * REST Admin API is legacy since 2024-10-01 and closed to new public apps
 * since 2025-04-01. Every Admin call in this repo (billing subscriptions,
 * catalogue/order/customer sync, webhook registration) goes through here so
 * the endpoint, versioning and error contract live in exactly one place.
 *
 * What this module owns:
 *   - shop-domain normalization (`my-store` -> `my-store.myshopify.com`)
 *   - the versioned GraphQL endpoint (version always derived via
 *     `resolveShopifyApiVersion`, never a literal — see
 *     `test/shopifyApiVersion.test.js`)
 *   - retries on 429/5xx honoring `Retry-After` (same policy as the
 *     `fetchWithRetry` used for the non-Shopify adapters)
 *   - a single error shape: transport failures, auth rejections and
 *     GraphQL `errors`/`userErrors` all surface as `ShopifyAdminError`
 *
 * What it deliberately does NOT do: paginate for you opaquely. `fetchAllEdges`
 * walks one connection and returns the nodes; mapping nodes onto platform
 * records stays with the caller, where the field knowledge lives.
 */

const { resolveShopifyApiVersion, } = require('../config/shopifyApiVersion.js',);

class ShopifyAdminError extends Error {
  constructor(message, { status = null, shopDomain = null, errors = null, } = {},) {
    super(message,);
    this.name = 'ShopifyAdminError';
    this.status = status;
    this.shopDomain = shopDomain;
    this.errors = errors;
  }
}

/** `my-store` -> `my-store.myshopify.com`; full domains pass through. */
function normalizeShopDomain(shopDomain,) {
  const domain = String(shopDomain || '',).replace(/^https?:\/\//, '',).replace(/\/$/, '',);
  return domain.endsWith('.myshopify.com',) ? domain : `${domain}.myshopify.com`;
}

/** Numeric tail of a Shopify global id (`gid://shopify/Customer/42` -> `42`). */
function shopifyIdTail(gid,) {
  const s = String(gid ?? '',);
  const tail = s.includes('/',) ? s.slice(s.lastIndexOf('/',) + 1,) : s;
  return tail || s;
}

function createShopifyAdmin({ shopDomain, accessToken, apiVersion, fetchFn = fetch, maxRetries = 3, timeoutMs = 15000, } = {},) {
  if (!shopDomain || !accessToken) throw new Error('shopDomain and accessToken are required.',);
  const host = normalizeShopDomain(shopDomain,);
  // Derived, never a literal: a hardcoded version here is how the billing path
  // once silently pinned an unsupported version. See shopifyApiVersion.js.
  const version = apiVersion || resolveShopifyApiVersion();
  const endpoint = `https://${host}/admin/api/${version}/graphql.json`;

  async function post(body,) {
    let lastRes = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body,),
        signal: AbortSignal.timeout(timeoutMs,),
      },);
      lastRes = res;

      if (res.ok) return res;
      // Auth failures and other 4xx (except 429) are final — retrying a
      // rejected credential changes nothing and burns the throttle budget.
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyAdminError('Shopify rejected the access token (401/403).', {
          status: res.status, shopDomain: host,
        },);
      }
      if ((res.status < 500 && res.status !== 429) || attempt === maxRetries) return res;

      const retryAfter = res.headers?.get('Retry-After',);
      const delay = retryAfter ? Number(retryAfter,) * 1000 : 1000 * Math.pow(2, attempt,);
      await new Promise((resolve,) => setTimeout(resolve, delay,),);
    }
    return lastRes;
  }

  /**
   * Run one GraphQL operation. Resolves with `data`; throws
   * `ShopifyAdminError` on transport failure, on a top-level `errors`
   * array, or when the caller-supplied `userErrorsPath` (e.g.
   * `['appSubscriptionCreate', 'userErrors']`) is non-empty.
   */
  async function graphql(query, variables = {}, { userErrorsPath = null, } = {},) {
    let res;
    try {
      res = await post({ query, variables, },);
    } catch (err) {
      if (err instanceof ShopifyAdminError) throw err;
      throw new ShopifyAdminError(`Shopify Admin request failed: ${err.message}`, {
        shopDomain: host,
      },);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}),);
      const detail = body?.errors ? JSON.stringify(body.errors,) : res.statusText;
      throw new ShopifyAdminError(`Shopify Admin request failed (${res.status}): ${detail}`, {
        status: res.status, shopDomain: host, errors: body?.errors || null,
      },);
    }
    const body = await res.json().catch(() => ({}),);
    if (Array.isArray(body.errors,) && body.errors.length) {
      const first = body.errors[0];
      throw new ShopifyAdminError(`Shopify Admin error: ${first.message || JSON.stringify(body.errors,)}`, {
        status: 200, shopDomain: host, errors: body.errors,
      },);
    }
    if (userErrorsPath) {
      let node = body.data;
      for (const key of userErrorsPath) node = node?.[key];
      const list = Array.isArray(node,) ? node : node?.userErrors;
      if (Array.isArray(list,) && list.length) {
        const first = list[0];
        throw new ShopifyAdminError(
          `Shopify Admin error: ${first.message || JSON.stringify(list,)}`,
          { status: 200, shopDomain: host, errors: list, },
        );
      }
    }
    return body.data ?? {};
  }

  /**
   * Walk one root connection (`products`, `orders`, `customers`) and return
   * every node, up to `maxPages` pages of `pageSize`. Same bounded-pull
   * semantics the sync loops always had (10 pages), so a pathological
   * catalogue cannot page forever.
   */
  async function fetchAllEdges(query, { variables = {}, root, pageSize = 250, maxPages = 10, } = {},) {
    if (!root) throw new Error('root connection name is required.',);
    const nodes = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
      const data = await graphql(query, { ...variables, first: pageSize, after: cursor, },);
      const conn = data?.[root];
      if (!conn || !Array.isArray(conn.edges,)) break;
      for (const edge of conn.edges) {
        if (edge?.node) nodes.push(edge.node,);
      }
      if (!conn.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
    return nodes;
  }

  return { endpoint, host, version, graphql, fetchAllEdges, };
}

module.exports = {
  createShopifyAdmin,
  normalizeShopDomain,
  shopifyIdTail,
  ShopifyAdminError,
};
