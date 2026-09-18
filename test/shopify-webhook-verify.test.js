'use strict';

process.env.NODE_ENV = 'test';
// INT-001 regression (audit item TEST-001): Shopify webhook signature
// verification. A deterministic client secret is required so the verifier
// is active — it fails closed when the secret is empty.
process.env.SHOPIFY_CLIENT_SECRET = 'test-shopify-secret';

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('crypto',);
const { shopifyWebhookVerifier, } = require('../src/server/security',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

const SECRET = process.env.SHOPIFY_CLIENT_SECRET;

// Sign a JS object exactly as Shopify signs the raw request body:
// base64 HMAC-SHA256 over the exact bytes transmitted.
function sign(object,) {
  const raw = JSON.stringify(object,);
  return crypto.createHmac('sha256', SECRET,).update(raw,).digest('base64',);
}

// Minimal Connect middleware harness — no server required.
function run(mw, { signature, rawBody, secret = SECRET, },) {
  const req = {
    rawBody,
    get: (h,) => (String(h,).toLowerCase() === 'x-shopify-hmac-sha256' ? signature : undefined),
  };
  const res = {
    statusCode: null,
    body: null,
    status(code,) { this.statusCode = code; return this; },
    json(obj,) { this.body = obj; return this; },
    set() {},
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  mw(req, res, next,);
  return { req, res, nextCalled, };
}

test('shopifyWebhookVerifier: valid signature calls next()', () => {
  const body = { id: 1, myshopify_domain: 'x.myshopify.com', };
  const raw = JSON.stringify(body,);
  const { res, nextCalled, } = run(shopifyWebhookVerifier(SECRET,), {
    signature: sign(body,),
    rawBody: Buffer.from(raw,),
  },);
  assert.equal(nextCalled, true, 'a valid signature must pass through to next()',);
  assert.equal(res.statusCode, null, 'no status should be set on success',);
},);

test('shopifyWebhookVerifier: tampered body is rejected with 401', () => {
  const body = { id: 1, amount: 100, };
  const { res, nextCalled, } = run(shopifyWebhookVerifier(SECRET,), {
    // signature computed over a DIFFERENT body than the one sent
    signature: sign({ id: 1, amount: 999, },),
    rawBody: Buffer.from(JSON.stringify(body,),),
  },);
  assert.equal(nextCalled, false,);
  assert.equal(res.statusCode, 401,);
  assert.equal(res.body.error, 'Invalid webhook signature.',);
},);

test('shopifyWebhookVerifier: missing signature header is rejected with 401', () => {
  const { res, nextCalled, } = run(shopifyWebhookVerifier(SECRET,), {
    signature: undefined,
    rawBody: Buffer.from('{}',),
  },);
  assert.equal(nextCalled, false,);
  assert.equal(res.statusCode, 401,);
  assert.equal(res.body.error, 'Missing Shopify webhook signature.',);
},);

test('shopifyWebhookVerifier: empty secret fails closed with 401', () => {
  // The original INT-001 defect would have let this through unchecked.
  const body = { id: 1, };
  const { res, nextCalled, } = run(shopifyWebhookVerifier('',), {
    signature: sign(body,),
    rawBody: Buffer.from(JSON.stringify(body,),),
  },);
  assert.equal(nextCalled, false,);
  assert.equal(res.statusCode, 401,);
  assert.equal(res.body.error, 'Shopify webhook verification unavailable.',);
},);

test('shopifyWebhookVerifier: wrong encoding (hex instead of base64) is rejected', () => {
  // Guards against the original INT-001 bug: hex digest + custom header name.
  const body = { id: 1, };
  const raw = JSON.stringify(body,);
  const hexSig = crypto.createHmac('sha256', SECRET,).update(raw,).digest('hex',);
  const { res, nextCalled, } = run(shopifyWebhookVerifier(SECRET,), {
    signature: hexSig,
    rawBody: Buffer.from(raw,),
  },);
  assert.equal(nextCalled, false,);
  assert.equal(res.statusCode, 401,);
},);

// ── Integration: real route wired through createApp ──────────────────────

function bootServer() {
  const platform = createPlatform();
  const app = createApp(platform,);
  return new Promise((resolve,) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port, } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        platform,
        close: () => new Promise((done,) => server.close(done,),),
      },);
    },);
  },);
}

const postOrders = (base, payload, signature,) =>
  fetch(`${base}/webhooks/orders/store_1`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Hmac-Sha256': signature,
    },
    body: JSON.stringify(payload,),
  },);

test('integration: /webhooks/orders/:store_id rejects a bad signature with 401', async () => {
  const { base, close, } = await bootServer();
  try {
    const payload = { id: 'order_1', myshopify_domain: 'x.myshopify.com', };
    const raw = JSON.stringify(payload,);
    const badSig = crypto.createHmac('sha256', SECRET,).update('tampered',).digest('base64',);
    const res = await postOrders(base, payload, badSig,);
    assert.equal(res.status, 401, 'a bad signature must be rejected at the edge',);
    const body = await res.json();
    assert.equal(body.error, 'Invalid webhook signature.',);
  } finally {
    await close();
  }
},);

test('integration: /webhooks/orders/:store_id accepts a valid signature', async () => {
  const { base, close, } = await bootServer();
  try {
    const payload = { id: 'order_1', myshopify_domain: 'x.myshopify.com', };
    const raw = JSON.stringify(payload,);
    const goodSig = crypto.createHmac('sha256', SECRET,).update(raw,).digest('base64',);
    const res = await postOrders(base, payload, goodSig,);
    // 401 means verification failed; any other status means the verifier
    // let the request reach the handler.
    assert.notEqual(res.status, 401, 'a valid signature must pass verification',);
  } finally {
    await close();
  }
},);
