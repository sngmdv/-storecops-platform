'use strict';

/**
 * Shopify Admin API version — the single source of truth.
 *
 * Shopify supports a rolling window of versions (roughly the latest four
 * quarters). A version that has fallen out of that window makes *every* Admin
 * API call fail, and the failure surfaces as a generic 4xx rather than as a
 * configuration error — so a stale default is expensive to diagnose and easy
 * to miss in review.
 *
 * This module exists because that fact had drifted into three copies:
 * `config.js` and `integrations.js` both used `2026-07`, while
 * `billingService.js` fell back to `2025-01` — the one value the other two
 * files explicitly document as unsupported. The billing fallback only fired
 * when a caller passed a config object without `shopifyApiVersion`, which is
 * exactly the "partial config breaks defaults" failure this codebase has been
 * bitten by before, and it would have taken the billing path down silently.
 *
 * Derive, do not copy: import `resolveShopifyApiVersion` instead of writing a
 * fourth literal. Override with the `SHOPIFY_API_VERSION` environment variable.
 */

const DEFAULT_SHOPIFY_API_VERSION = '2026-07';

/**
 * Versions Shopify no longer serves. Kept as data so a regression is detectable
 * rather than merely documented in a comment.
 */
const UNSUPPORTED_SHOPIFY_API_VERSIONS = Object.freeze(['2025-01',],);

/**
 * Resolve the version, in precedence order: an explicit value (normally
 * `config.shopifyApiVersion`), then the environment, then the default.
 */
function resolveShopifyApiVersion(explicit,) {
  return explicit || process.env.SHOPIFY_API_VERSION || DEFAULT_SHOPIFY_API_VERSION;
}

module.exports = {
  DEFAULT_SHOPIFY_API_VERSION,
  UNSUPPORTED_SHOPIFY_API_VERSIONS,
  resolveShopifyApiVersion,
};
