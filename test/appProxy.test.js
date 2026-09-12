'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('node:crypto',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);
const { verifyProxySignature, signatureBase, } = require('../src/server/appProxy',);

const CLIENT_ID = 'proxy-client-id-1234567890';
const CLIENT_SECRET = 'proxy-client-secret-abcdefghij';
const SHOP = 'storecops-proxy.myshopify.com';

/** Compute a Shopify app-proxy signature over the given query params. */
function sign(params, secret = CLIENT_SECRET,) {
  const base = Object.keys(params,)
    .sort()
    .map((k,) => `${k}=${params[k]}`,)
    .join('',);
  return crypto.createHmac('sha256', secret,).update(base,).digest('hex',);
}

/** Build a signed proxy query string. */
function signedQuery(extra = {},) {
  const params = {
    shop: SHOP,
    path_prefix: '/apps/storecops',
    timestamp: '1757600000',
    ...extra,
  };
  params.signature = sign(params,);
  return new URLSearchParams(params,).toString();
}

/** Boot an app whose tenant owns SHOP. */
async function bootProxy() {
  process.env.SHOPIFY_CLIENT_ID = CLIENT_ID;
  process.env.SHOPIFY_CLIENT_SECRET = CLIENT_SECRET;

  const platform = createPlatform();
  const app = createApp(platform,);
  const server = await new Promise((resolve,) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s,),);
  },);

  const tenant = await platform.auth.signup({
    email: 'proxy@example.com',
    password: 'password123',
    storeName: 'Proxy Co',
  },);
  await platform.store.integrations.insert({
    store_id: tenant.store_id,
    type: 'shopify',
    status: 'active',
    config: { shopDomain: SHOP, tokenEncrypted: 'x', },
  },);

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    platform,
    store_id: tenant.store_id,
    close: () => new Promise((done,) => server.close(done,),),
  };
}

function cleanupEnv() {
  delete process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_SECRET;
}

test('app proxy: signature base has no separator (unlike OAuth HMAC)', () => {
  assert.strictEqual(
    signatureBase({ b: '2', a: '1', signature: 'ignored', },),
    'a=1b=2',
  );
},);

test('app proxy: verifies a correctly signed query', () => {
  const params = { shop: SHOP, path_prefix: '/apps/storecops', timestamp: '123', };
  params.signature = sign(params,);
  assert.strictEqual(verifyProxySignature(params, CLIENT_SECRET,), true,);
},);

test('app proxy: rejects a tampered query', () => {
  const params = { shop: SHOP, path_prefix: '/apps/storecops', timestamp: '123', };
  params.signature = sign(params,);
  params.shop = 'evil.myshopify.com';
  assert.strictEqual(verifyProxySignature(params, CLIENT_SECRET,), false,);
},);

test('app proxy: rejects a signature made with the wrong secret', () => {
  const params = { shop: SHOP, timestamp: '123', };
  params.signature = sign(params, 'wrong-secret',);
  assert.strictEqual(verifyProxySignature(params, CLIENT_SECRET,), false,);
},);

test('app proxy: rejects a missing or malformed signature', () => {
  assert.strictEqual(verifyProxySignature({ shop: SHOP, }, CLIENT_SECRET,), false,);
  assert.strictEqual(verifyProxySignature(null, CLIENT_SECRET,), false,);
  assert.strictEqual(verifyProxySignature({ shop: SHOP, signature: 'short', }, CLIENT_SECRET,), false,);
},);

test('app proxy: serves the tracker snippet to a signed storefront request', async () => {
  const { base, close, } = await bootProxy();
  try {
    const res = await fetch(`${base}/proxy/tracker.js?${signedQuery()}`,);
    assert.strictEqual(res.status, 200,);
    assert.match(res.headers.get('content-type',), /javascript/,);
    const body = await res.text();
    assert.ok(body.length > 100, 'tracker script has content',);
  } finally {
    await close();
    cleanupEnv();
  }
},);

test('app proxy: an unsigned request cannot fetch the tracker', async () => {
  const { base, close, } = await bootProxy();
  try {
    const res = await fetch(`${base}/proxy/tracker.js?shop=${SHOP}`,);
    assert.strictEqual(res.status, 401,);
  } finally {
    await close();
    cleanupEnv();
  }
},);

test('app proxy: consent from the storefront banner is recorded', async () => {
  const { base, platform, store_id, close, } = await bootProxy();
  try {
    const res = await fetch(`${base}/proxy/consent?${signedQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', },
      body: JSON.stringify({ consent: 'accepted', customer_id: 'cust_9', },),
    },);
    assert.strictEqual(res.status, 200,);
    const body = await res.json();
    assert.strictEqual(body.status, 'accepted',);

    const record = await platform.consentService.getConsent(store_id, 'cust_9',);
    assert.ok(record, 'consent record persisted',);
    assert.strictEqual(record.categories.marketing, true,);
  } finally {
    await close();
    cleanupEnv();
  }
},);

test('app proxy: a decline records marketing consent as false', async () => {
  const { base, platform, store_id, close, } = await bootProxy();
  try {
    await fetch(`${base}/proxy/consent?${signedQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', },
      body: JSON.stringify({ consent: 'declined', customer_id: 'cust_10', },),
    },);

    const record = await platform.consentService.getConsent(store_id, 'cust_10',);
    assert.strictEqual(record.categories.marketing, false,);
    assert.strictEqual(record.categories.essential, true,);
  } finally {
    await close();
    cleanupEnv();
  }
},);

test('app proxy: recommendations are scoped to the signing shop', async () => {
  const { base, store_id, platform, close, } = await bootProxy();
  try {
    await platform.store.events.insert({
      store_id,
      event_type: 'purchase',
      customer_id: 'cust_1',
      items: [{ product_id: 'sku_a', quantity: 1, }, { product_id: 'sku_b', quantity: 1, },],
      timestamp: new Date().toISOString(),
    },);

    const res = await fetch(`${base}/proxy/recommendations?${signedQuery({ product_id: 'sku_a', },)}`,);
    assert.strictEqual(res.status, 200,);
    const body = await res.json();
    assert.strictEqual(body.ok, true,);
    assert.ok(Array.isArray(body.recommendations,),);
  } finally {
    await close();
    cleanupEnv();
  }
},);

test('app proxy: a signed request for an uninstalled shop is refused', async () => {
  const { base, close, } = await bootProxy();
  try {
    const params = {
      shop: 'some-other-store.myshopify.com',
      path_prefix: '/apps/storecops',
      timestamp: '1757600000',
    };
    params.signature = sign(params,);
    const res = await fetch(`${base}/proxy/tracker.js?${new URLSearchParams(params,).toString()}`,);
    assert.strictEqual(res.status, 401,);
  } finally {
    await close();
    cleanupEnv();
  }
},);
