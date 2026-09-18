'use strict';

/**
 * Guard tests for inbound webhook tenant binding and delivery idempotency.
 *
 * THE DEFECT THESE LOCK DOWN
 * --------------------------
 * `/webhooks/orders/:store_id` and `/webhooks/returns/:store_id` verified the HMAC
 * but never checked that the delivery belonged to the store named in the path.
 * Shopify signs the body with the app-wide client secret, so a body captured from
 * one merchant verifies for every merchant — the path parameter was chosen by the
 * caller. Replaying it into another store injected a purchase and decremented that
 * store's stock.
 *
 * There is no signed tenant in an order payload (verified against Shopify's
 * delivery-structure docs — the body is "the full REST resource payload" and the
 * Order resource has no shop field), so the fix is to make a captured body usable
 * exactly once rather than to try to authenticate a tenant that was never signed.
 *
 * Every test that expects a refusal is paired with a same-tenant control, so a 409
 * has to mean "already attributed to a different store" rather than "blanket
 * rejection of everything".
 */

const { describe, it, beforeEach, } = require('node:test',);
const assert = require('node:assert/strict',);
const { createStore, } = require('../src/storage/store',);
const {
  admitDelivery,
  assertTenant,
  bucketFor,
  deliveryDigest,
  releaseDelivery,
  resetSweepThrottle,
  signedShopDomain,
  sweepExpiredDeliveries,
  DELIVERY_TTL_MS,
} = require('../src/server/webhookTenancy',);

const BODY_A = JSON.stringify({ id: 1001, total_price: '49.00', myshopify_domain: 'alpha.myshopify.com', },);
const BODY_B = JSON.stringify({ id: 1002, total_price: '12.00', myshopify_domain: 'alpha.myshopify.com', },);

/** A resolver that knows exactly one shop, the way `tenantForShop` would. */
function resolverFor(mapping,) {
  return async (domain,) => mapping[domain] || null;
}

function delivery(overrides = {},) {
  return {
    store_id: 'store_alpha',
    rawBody: BODY_A,
    topic: 'orders/create',
    payload: JSON.parse(BODY_A,),
    headerShopDomain: 'alpha.myshopify.com',
    ...overrides,
  };
}

beforeEach(() => {
  resetSweepThrottle();
},);

// ── The digest itself ───────────────────────────────────────────────────────

describe('webhookTenancy: deliveryDigest', () => {
  it('is a full-width sha256, not the 16-character truncation it replaced', () => {
    assert.match(deliveryDigest(BODY_A,), /^[0-9a-f]{64}$/,);
  },);

  it('hashes the raw bytes, not a re-serialization of the parsed body', () => {
    // The old helper fell back to `JSON.stringify(req.body)` when `rawBody` was
    // missing. A parse/stringify round trip strips insignificant whitespace, so two
    // *distinct* signed byte strings — carrying two different HMACs, i.e. two
    // different deliveries — collapse to a single digest and one is silently dropped
    // as a duplicate.
    const spaced = '{"id": 1, "total": "5.00"}';
    const compact = '{"id":1,"total":"5.00"}';

    assert.notEqual(deliveryDigest(spaced,), deliveryDigest(compact,),);

    // The collision, reproduced: the round trip maps `spaced` onto `compact` exactly,
    // so the old fallback produced ONE digest for both bodies. This is the control
    // for why the digest is taken over the raw bytes and never over a parsed body.
    assert.equal(JSON.stringify(JSON.parse(spaced,),), compact,);
    assert.equal(
      deliveryDigest(JSON.stringify(JSON.parse(spaced,),),),
      deliveryDigest(compact,),
      'the old fallback collided here',
    );
  },);

  it('is stable for the same bytes, so a retry matches its original', () => {
    assert.equal(deliveryDigest(BODY_A,), deliveryDigest(BODY_A,),);
  },);
},);

// ── Tenant claims ───────────────────────────────────────────────────────────

describe('webhookTenancy: assertTenant', () => {
  it('refuses a signed payload whose shop belongs to another store', async () => {
    const result = await assertTenant({
      store_id: 'store_beta',
      payload: JSON.parse(BODY_A,),
      resolveShop: resolverFor({ 'alpha.myshopify.com': { store_id: 'store_alpha', }, },),
    },);

    assert.equal(result.ok, false,);
    assert.equal(result.reason, 'tenant-mismatch',);
  },);

  it('control: allows the same payload for the store that actually owns the shop', async () => {
    const result = await assertTenant({
      store_id: 'store_alpha',
      payload: JSON.parse(BODY_A,),
      resolveShop: resolverFor({ 'alpha.myshopify.com': { store_id: 'store_alpha', }, },),
    },);

    assert.equal(result.ok, true,);
  },);

  it('refuses a header that names another store', async () => {
    const result = await assertTenant({
      store_id: 'store_beta',
      payload: {},
      headerShopDomain: 'alpha.myshopify.com',
      resolveShop: resolverFor({ 'alpha.myshopify.com': { store_id: 'store_alpha', }, },),
    },);

    assert.equal(result.ok, false,);
    assert.equal(result.reason, 'tenant-mismatch',);
  },);

  it('allows a shop it cannot resolve, rather than breaking compliance webhooks', async () => {
    // Refusing an unknown shop would mean a store whose integrations.config.shopDomain
    // is stored in an unexpected shape could never receive a customers/redact — a
    // data-integrity guard turning into a compliance failure.
    const result = await assertTenant({
      store_id: 'store_beta',
      payload: { shop_domain: 'never-seen.myshopify.com', },
      resolveShop: resolverFor({},),
    },);

    assert.equal(result.ok, true,);
  },);

  it('fails closed when the lookup itself throws', async () => {
    const result = await assertTenant({
      store_id: 'store_alpha',
      payload: { shop_domain: 'alpha.myshopify.com', },
      resolveShop: async () => { throw new Error('directory unavailable',); },
    },);

    assert.equal(result.ok, false,);
    assert.equal(result.status, 503,);
  },);

  it('normalises scheme and case before comparing', () => {
    assert.equal(
      signedShopDomain({ shop: 'HTTPS://Alpha.MyShopify.com/', },),
      'alpha.myshopify.com',
    );
  },);
},);

// ── Admission: the property ─────────────────────────────────────────────────

describe('webhookTenancy: admitDelivery', () => {
  it('admits a first delivery and records the digest', async () => {
    const store = createStore();
    const result = await admitDelivery({ store, ...delivery(), },);

    assert.equal(result.ok, true,);
    assert.equal(result.duplicate, false,);
    assert.equal((await store.webhookDeliveries.find({},)).length, 1,);
  },);

  it('short-circuits a retry of the same body for the same store', async () => {
    const store = createStore();
    await admitDelivery({ store, ...delivery(), },);
    const retry = await admitDelivery({ store, ...delivery(), },);

    assert.equal(retry.ok, true,);
    assert.equal(retry.duplicate, true, 'a Shopify retry must not be processed twice',);
    assert.equal((await store.webhookDeliveries.find({},)).length, 1,);
  },);

  it('refuses the same body presented as a different store, and reports it', async () => {
    const store = createStore();
    const reports = [];

    // The legitimate delivery for the store the body was signed for.
    await admitDelivery({ store, ...delivery(), },);

    // The attack: the identical captured body, aimed at another store's path.
    const replay = await admitDelivery({
      store,
      ...delivery({ store_id: 'store_beta', },),
      onCrossTenant: async (event,) => reports.push(event,),
    },);

    assert.equal(replay.ok, false,);
    assert.equal(replay.status, 409,);
    assert.equal(replay.reason, 'cross-tenant-replay',);
    assert.equal(reports.length, 1,);
    assert.equal(reports[0].attributed_to, 'store_alpha',);
    assert.equal(reports[0].presented_as, 'store_beta',);
    assert.equal((await store.webhookDeliveries.find({},)).length, 1, 'no second row',);
  },);

  it('control: a different body for the other store is admitted normally', async () => {
    // Proves the 409 above means "already attributed elsewhere", not "this store is
    // refused" — the same reasoning the M6 tenant sweep uses for its controls.
    const store = createStore();
    await admitDelivery({ store, ...delivery(), },);

    const other = await admitDelivery({ store, ...delivery({ store_id: 'store_beta', rawBody: BODY_B, payload: JSON.parse(BODY_B,), },), },);

    assert.equal(other.ok, true,);
    assert.equal(other.duplicate, false,);
    assert.equal((await store.webhookDeliveries.find({},)).length, 2,);
  },);

  it('does not reserve a digest when the tenant claim is refused', async () => {
    // If a refused delivery left a row behind, the legitimate delivery that follows
    // would be rejected as a cross-tenant replay — the guard would attack itself.
    const store = createStore();

    const refused = await admitDelivery({
      store,
      ...delivery({ store_id: 'store_beta', },),
      resolveShop: resolverFor({ 'alpha.myshopify.com': { store_id: 'store_alpha', }, },),
    },);
    assert.equal(refused.ok, false,);
    assert.equal((await store.webhookDeliveries.find({},)).length, 0, 'nothing reserved',);

    const legit = await admitDelivery({
      store,
      ...delivery(),
      resolveShop: resolverFor({ 'alpha.myshopify.com': { store_id: 'store_alpha', }, },),
    },);
    assert.equal(legit.ok, true,);
    assert.equal(legit.duplicate, false,);
  },);

  it('fails closed with 503 when the digest lookup fails', async () => {
    // Not 200: a delivery that cannot be bound to a tenant must not be processed,
    // and Shopify retries for four hours so a transient failure is recoverable.
    const store = createStore();
    const broken = {
      ...store,
      webhookDeliveries: {
        findOne: async () => { throw new Error('database is locked',); },
        insert: async () => { throw new Error('unreachable',); },
      },
    };

    const result = await admitDelivery({ store: broken, ...delivery(), },);

    assert.equal(result.ok, false,);
    assert.equal(result.status, 503,);
    assert.equal(result.reason, 'storage-unavailable',);
  },);

  it('replaces an expired record instead of blocking on it', async () => {
    const store = createStore();
    const now = Date.now();
    await store.webhookDeliveries.insert({
      store_id: 'store_alpha',
      digest: deliveryDigest(BODY_A,),
      bucket: bucketFor(now - DELIVERY_TTL_MS * 3,),
      received_at: new Date(now - DELIVERY_TTL_MS * 3,).toISOString(),
      expires_at: new Date(now - DELIVERY_TTL_MS * 2,).toISOString(),
    },);

    const result = await admitDelivery({ store, ...delivery({ now, },), },);

    assert.equal(result.ok, true,);
    assert.equal(result.duplicate, false, 'an expired record must not dedupe forever',);
    assert.equal((await store.webhookDeliveries.find({},)).length, 1, 'replaced, not duplicated',);
  },);
},);

// ── Release, so a retry after a failure is not swallowed ────────────────────

describe('webhookTenancy: releaseDelivery', () => {
  it('lets a retry through after the first attempt failed', async () => {
    const store = createStore();
    const first = await admitDelivery({ store, ...delivery(), },);
    assert.equal(first.ok, true,);

    // Processing failed, so the reservation is released and Shopify's retry can
    // actually be processed rather than answered 200-and-dropped.
    assert.equal(await releaseDelivery({ store, digest: first.digest, },), true,);

    const retry = await admitDelivery({ store, ...delivery(), },);
    assert.equal(retry.ok, true,);
    assert.equal(retry.duplicate, false,);
  },);

  it('reports false when there was nothing to release', async () => {
    const store = createStore();
    assert.equal(await releaseDelivery({ store, digest: deliveryDigest('nothing',), },), false,);
  },);
},);

// ── The sweep ───────────────────────────────────────────────────────────────

describe('webhookTenancy: sweepExpiredDeliveries', () => {
  it('drops old buckets and keeps recent ones', async () => {
    const store = createStore();
    const now = Date.now();
    const old = bucketFor(now - DELIVERY_TTL_MS * 5,);
    const recent = bucketFor(now,);

    await store.webhookDeliveries.insert({ store_id: 's', digest: 'a'.repeat(64,), bucket: old, },);
    await store.webhookDeliveries.insert({ store_id: 's', digest: 'b'.repeat(64,), bucket: recent, },);

    const result = await sweepExpiredDeliveries({ store, now, },);

    assert.equal(result.swept, 1,);
    const left = await store.webhookDeliveries.find({},);
    assert.equal(left.length, 1,);
    assert.equal(left[0].bucket, recent,);
  },);

  it('never sweeps today, so a delivery just admitted cannot be removed', async () => {
    const store = createStore();
    const now = Date.now();
    await store.webhookDeliveries.insert({
      store_id: 's',
      digest: 'c'.repeat(64,),
      bucket: bucketFor(now,),
    },);

    const result = await sweepExpiredDeliveries({ store, now, },);

    assert.equal(result.swept, 0,);
    assert.equal((await store.webhookDeliveries.find({},)).length, 1,);
  },);

  it('is throttled unless forced', async () => {
    const store = createStore();
    const now = Date.now();

    assert.equal((await sweepExpiredDeliveries({ store, now, },)).skipped, false,);
    assert.equal((await sweepExpiredDeliveries({ store, now, },)).skipped, true,);
    assert.equal((await sweepExpiredDeliveries({ store, now, force: true, },)).skipped, false,);
  },);
},);
