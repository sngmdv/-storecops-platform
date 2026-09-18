'use strict';

process.env.NODE_ENV = 'test';
process.env.TRACK_INGEST_CEILING_MAX = '3';

/**
 * Rate-limiter keying and the per-store ingest ceiling.
 *
 * THE DEFECT (item 44)
 * --------------------
 * `createRateLimiter` trimmed each key's timestamp array to a fixed `maxPerKey`
 * (500) before appending, then compared `timestamps.length > max`. With the default
 * `max` of 300 that is harmless. But `RATE_LIMIT_MAX` is an environment variable, and
 * **any value of 500 or above made the limiter reject nothing at all** — the array
 * could never exceed the threshold. Measured before the fix:
 *
 *     max=300,  400 attempts -> rejected 100
 *     max=500,  600 attempts -> rejected   0
 *     max=600,  700 attempts -> rejected   0
 *     max=1000, 1100 attempts -> rejected  0
 *
 * A security control that disables itself through configuration, with no warning.
 * The per-key cap is now `Math.max(maxPerKey, max + 1)` — a floor on memory, never a
 * ceiling on enforceability.
 *
 * This is also what unblocked the per-store ingest ceiling on `/proxy/track`, which
 * needs a `max` well above 500 to be a safety valve rather than a trap for honest
 * traffic.
 *
 * THE SECOND PROPERTY
 * -------------------
 * `/proxy/track` is reachable by any visitor on a connected storefront, so the IP
 * limiter bounds one *source* but not one *tenant*: a store with many visitors is
 * many IPs. `keyFn` keys that ceiling on the store the app-proxy signature resolved,
 * and the tests below pin that exhausting one store leaves another untouched.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('node:crypto',);

const { createRateLimiter, } = require('../src/server/security',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

// ── Doubles for the unit-level checks ───────────────────────────────────────

function fakeReq({ ip = '1.2.3.4', apiKey, store, } = {},) {
  return {
    ip,
    proxyStoreId: store,
    get: (name,) => (name === 'X-API-Key' ? apiKey : undefined),
  };
}

function fakeRes() {
  return {
    statusCode: null,
    headers: {},
    set(name, value,) { this.headers[name] = value; return this; },
    status(code,) { this.statusCode = code; return this; },
    json() { return this; },
  };
}

/** Run `attempts` requests through `limiter` and count the rejections. */
function hammer(limiter, req, attempts,) {
  let rejected = 0;
  for (let i = 0; i < attempts; i++) {
    const res = fakeRes();
    limiter(req, res, () => {},);
    if (res.statusCode === 429) rejected++;
  }
  return rejected;
}

// ── The limiter must be able to enforce any configured ceiling ──────────────

test('a ceiling above the old fixed per-key cap is still enforced', () => {
  // The regression: these all rejected nothing before the fix.
  for (const max of [500, 600, 1000,]) {
    const rejected = hammer(createRateLimiter({ windowMs: 60000, max, },), fakeReq(), max + 100,);
    assert.ok(
      rejected > 0,
      `max=${max} rejected nothing — the per-key cap has silently disabled the limiter again`,
    );
  }
},);

test('control: the default ceiling still rejects at exactly the configured count', () => {
  // 400 attempts with max 300 leaves 100 over the line. If this ever stops failing
  // the property above is meaningless, because nothing would be limited at all.
  const rejected = hammer(createRateLimiter({ windowMs: 60000, max: 300, },), fakeReq(), 400,);
  assert.equal(rejected, 100,);
},);

test('the headers report the configured ceiling, not the per-key cap', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 900, },);
  const res = fakeRes();
  limiter(fakeReq(), res, () => {},);
  assert.equal(res.headers['X-RateLimit-Limit'], '900',);
  assert.equal(res.headers['X-RateLimit-Remaining'], '899',);
},);

// ── Keying ─────────────────────────────────────────────────────────────────

test('keyFn keys the limiter on the store, not the caller', () => {
  const limiter = createRateLimiter({
    windowMs: 60000,
    max: 3,
    keyFn: (req,) => req.proxyStoreId || 'unresolved',
  },);

  // One storefront burns its allowance.
  assert.equal(hammer(limiter, fakeReq({ store: 'store_alpha', },), 5,), 2,);

  // The control: a different store, from the SAME IP, is untouched. Without this the
  // 429 above could just mean "the limiter is broken", not "that store is over".
  assert.equal(hammer(limiter, fakeReq({ store: 'store_beta', },), 1,), 0,);
},);

test('without keyFn the limiter still keys on API key then IP', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2, },);

  assert.equal(hammer(limiter, fakeReq({ apiKey: 'key_one', },), 4,), 2,);
  // A second API key from the same IP has its own allowance...
  assert.equal(hammer(limiter, fakeReq({ apiKey: 'key_two', },), 1,), 0,);
  // ...and an anonymous caller from another IP has its own too.
  assert.equal(hammer(limiter, fakeReq({ ip: '5.6.7.8', },), 1,), 0,);
},);

// ── The per-store ceiling on /proxy/track, end to end ──────────────────────

const CLIENT_ID = 'ingest-client-id-1234567890';
const CLIENT_SECRET = 'ingest-client-secret-abcdefghij';
const SHOP_A = 'ceiling-alpha.myshopify.com';
const SHOP_B = 'ceiling-beta.myshopify.com';
const CEILING = 3;

function proxySign(params, secret = CLIENT_SECRET,) {
  const base = Object.keys(params,)
    .sort()
    .map((k,) => `${k}=${params[k]}`,)
    .join('',);
  return crypto.createHmac('sha256', secret,).update(base,).digest('hex',);
}

function proxyQuery(shop,) {
  const params = {
    shop,
    path_prefix: '/apps/storecops',
    timestamp: '1757600000',
  };
  params.signature = proxySign(params,);
  return new URLSearchParams(params,).toString();
}

/** Boot an app with a deliberately tiny per-store ceiling and two connected shops. */
async function bootWithCeiling() {
  process.env.SHOPIFY_CLIENT_ID = CLIENT_ID;
  process.env.SHOPIFY_CLIENT_SECRET = CLIENT_SECRET;

  const platform = createPlatform();
  const app = createApp(platform,);
  const server = await new Promise((resolve,) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s,),);
  },);

  const shops = {};
  for (const [label, shop,] of [['a', SHOP_A,], ['b', SHOP_B,],]) {
    const tenant = await platform.auth.signup({
      email: `ceiling-${label}@example.com`,
      password: 'p2-fixture-passphrase-9f3a2b',
      storeName: `Ceiling ${label}`,
    },);
    await platform.store.integrations.insert({
      store_id: tenant.store_id,
      type: 'shopify',
      status: 'active',
      config: { shopDomain: shop, tokenEncrypted: 'x', },
    },);
    shops[label] = tenant.store_id;
  }

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    platform,
    shops,
    close: () => new Promise((done,) => server.close(done,),),
  };
}

function postTrack(base, shop,) {
  return fetch(`${base}/proxy/track?${proxyQuery(shop,)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', },
    body: JSON.stringify({ event_type: 'product_view', product_id: 'sku_1', session_id: 'sess_fixture_123', },),
  },);
}

test('the per-store ingest ceiling stops one store and leaves the other alone', async () => {
  const { base, close, } = await bootWithCeiling();
  try {
    // Burn store A's ceiling. The first CEILING requests are accepted.
    const codesA = [];
    for (let i = 0; i < CEILING + 2; i++) codesA.push((await postTrack(base, SHOP_A,)).status,);

    assert.ok(
      codesA.includes(429,),
      `store A was never limited — got ${codesA.join(',',)}`,
    );

    // The control that matters: store B, from the same IP, is unaffected. Without it
    // a 429 could just mean the route is broken.
    const resB = await postTrack(base, SHOP_B,);
    assert.notEqual(resB.status, 429, 'a second store must not inherit the first store\'s ceiling',);
    assert.equal(resB.status, 200,);
  } finally {
    await close();
  }
},);

test('control: an unsigned proxy request never reaches the store ceiling', async () => {
  // The ceiling keys on the store the SIGNATURE resolved, so it cannot be evaluated
  // for an unsigned request — which must be refused before it gets there.
  const { base, close, } = await bootWithCeiling();
  try {
    const res = await fetch(`${base}/proxy/track?shop=${SHOP_A}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify({ event_type: 'product_view', },),
    },);

    assert.ok(res.status === 401 || res.status === 403, `expected a refusal, got ${res.status}`,);
  } finally {
    await close();
  }
},);
