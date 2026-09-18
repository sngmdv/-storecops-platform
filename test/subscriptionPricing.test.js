'use strict';

/**
 * Subscription pricing (PPP) — the module previously named `regionalPricing`.
 *
 * Two things are locked down here:
 *
 *   1. **The rename.** `platform.subscriptionPricing` prices Storecops' own plans;
 *      `platform.dynamicPricing` recommends prices for the *merchant's* products.
 *      Opposite domains, previously adjacent in the DI container under a shared
 *      `/pricing/*` route prefix. The rename only helps if it stays renamed.
 *   2. **Zero prior coverage.** This module had no test at all before the rename, so
 *      its arithmetic and its documented fallbacks were entirely unverified.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);

const { createPlatform, } = require('../src/platform',);
const { createSubscriptionPricingService, } = require('../src/layers/intelligence/subscriptionPricing',);

function service() {
  return createSubscriptionPricingService({ store: {}, config: {}, },);
}

test('the platform exposes subscriptionPricing, distinct from dynamicPricing', async () => {
  const platform = createPlatform();

  assert.strictEqual(typeof createSubscriptionPricingService, 'function',);
  assert.ok(platform.subscriptionPricing, 'platform.subscriptionPricing must exist',);
  assert.strictEqual(
    platform.regionalPricing,
    undefined,
    'the old ambiguous name must be gone — nothing should re-add it',
  );
  assert.ok(platform.dynamicPricing, 'platform.dynamicPricing must still exist',);
  assert.notStrictEqual(
    platform.subscriptionPricing,
    platform.dynamicPricing,
    'our plan pricing and the merchant product pricing are separate services',
  );
  assert.strictEqual(typeof platform.subscriptionPricing.getRegionalPrice, 'function',);
},);

test('a discounted region pays less than the US base price', () => {
  const svc = service();
  const us = svc.getRegionalPrice('growth', 'US',);
  const india = svc.getRegionalPrice('growth', 'IN',);

  assert.strictEqual(svc.PPP_FACTORS.US.factor, 1, 'the US is the base (factor 1)',);
  assert.strictEqual(
    us.adjusted_price,
    us.base_price_usd,
    'the base region must be neither marked up nor marked down',
  );
  assert.ok(india.adjusted_price < us.adjusted_price, 'a lower-factor region must pay less',);
  assert.strictEqual(india.currency, 'inr',);
  assert.strictEqual(india.country_name, 'India',);
  assert.ok(india.savings_usd > 0,);
  assert.strictEqual(india.plan, 'growth',);
},);

test('every region prices every plan and cycle without error', () => {
  const svc = service();
  const countries = Object.keys(svc.PPP_FACTORS,);

  // This is the claim SHOPIFY_SUBMISSION.md asks the operator to confirm by hand.
  assert.ok(countries.length >= 30, `expected 30+ countries, got ${countries.length}`,);

  for (const code of countries) {
    const all = svc.getAllPrices(code,);
    for (const [key, price,] of Object.entries(all,)) {
      assert.ok(!price.error, `${code}/${key} returned an error: ${price.error}`,);
      assert.ok(Number.isFinite(price.adjusted_price,), `${code}/${key} has no numeric price`,);
      assert.ok(price.adjusted_price >= 0,);
    }
  }
},);

test('an unknown plan is refused rather than priced at zero', () => {
  const svc = service();
  const result = svc.getRegionalPrice('free_trial', 'US',);

  assert.ok(result.error, 'an unknown plan must return an error, not a price',);
  assert.strictEqual(
    result.adjusted_price,
    undefined,
    'a missing plan must never produce a payable amount',
  );
},);

test('an unknown country falls back to the US base, as documented', () => {
  const svc = service();
  const result = svc.getRegionalPrice('growth', 'ZZ',);

  // Fail-safe direction: an unrecognised code overcharges nobody's discount.
  assert.strictEqual(result.ppp_factor, 1,);
  assert.strictEqual(result.adjusted_price, result.base_price_usd,);
},);

test('detectCountry is a stub that always answers US', async () => {
  const svc = service();

  // Not a silent stub: it means the PPP discount can only ever be applied when the
  // caller passes the country explicitly (`/pricing/regional/:country`). The
  // automatic path (`/pricing/detect-country`) cannot return anything but US, so
  // the "automatic region detection" and "VPN abuse prevention" in this module's
  // header do not actually function. Pinned here so implementing real GeoIP is a
  // deliberate, visible change rather than a quiet behaviour shift.
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.5', '127.0.0.1', '', undefined,]) {
    assert.strictEqual(await svc.detectCountry(ip,), 'US',);
  }
},);

test('validateRegionalPricing trusts the billing address over the claim', async () => {
  const svc = service();
  const mismatched = await svc.validateRegionalPricing('m1', 'IN', '8.8.8.8', { country: 'DE', },);

  assert.strictEqual(mismatched.country, 'DE',);
  assert.strictEqual(mismatched.source, 'billing_address',);
  assert.ok(mismatched.warning,);
},);

test('validateRegionalPricing flags an IP that disagrees with the claim', async () => {
  const svc = service();
  // Because detectCountry always answers US, a claim of IN can never be corroborated.
  const flagged = await svc.validateRegionalPricing('m1', 'IN', '8.8.8.8', null,);

  assert.strictEqual(flagged.country, 'US',);
  assert.strictEqual(flagged.flagged, true,);
  assert.strictEqual(flagged.source, 'ip_detection',);
},);

test('validateRegionalPricing accepts a claim the IP corroborates', async () => {
  const svc = service();
  const accepted = await svc.validateRegionalPricing('m1', 'US', '8.8.8.8', null,);

  assert.strictEqual(accepted.country, 'US',);
  assert.strictEqual(accepted.source, 'claimed',);
  assert.strictEqual(accepted.flagged, undefined, 'a corroborated claim is not flagged',);
},);

test('getStats reports a tier distribution covering every country', async () => {
  const svc = service();
  const stats = await svc.getStats();
  const { tier1, tier2, tier3, } = stats.tier_distribution;

  // Every country lands in exactly one band, so the parts must equal the whole.
  assert.strictEqual(tier1 + tier2 + tier3, stats.total_countries,);
  assert.ok(stats.total_countries >= 30,);
  assert.ok(stats.supported_currencies.length > 0,);
  assert.ok(stats.avg_discount >= 0 && stats.avg_discount <= 100,);
},);

test('formatPrice places a symbol with the amount', () => {
  const svc = service();

  const usd = svc.formatPrice(199, 'usd',);
  assert.ok(usd.includes('$',), `expected a $ symbol, got ${usd}`,);
  assert.ok(usd.includes('199',), `expected the amount, got ${usd}`,);

  const inr = svc.formatPrice(199, 'inr',);
  assert.ok(inr.includes('199',), `expected the amount, got ${inr}`,);
},);
