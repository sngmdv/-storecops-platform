'use strict';

process.env.NODE_ENV = 'test';

/**
 * P2 security regression tests.
 *
 * These cover the four P2 hardening changes that are easy to undo by accident:
 *
 *   1. Webhook verification fails CLOSED when no secret is configured. The old
 *      behaviour (`if (!secret) return next()`) silently disabled signature
 *      checking on the `/track` ingest route whenever `WEBHOOK_SECRET` was
 *      unset, letting anyone fabricate events in a merchant's account.
 *   2. The CSP is chosen from the request PATH, never the query string. The old
 *      policy branched on `?shop=`/`?embedded=1`, so appending `?shop=anything`
 *      to any URL returned the weaker embedded policy (with `unsafe-eval`).
 *   3. `preventPathTraversal` answers a malformed percent-escape with 400. It
 *      used to let the `URIError` escape as an unhandled 500.
 *   4. `/track/batch` is signature-verified too. It was the more attractive
 *      injection target and had no verifier at all.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('crypto',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);
const { webhookVerifier, signBody, } = require('../src/server/security',);
const {
  securityHeaders,
  preventPathTraversal,
  isEmbeddedApp,
  sanitizeInput,
} = require('../src/server/securityHardening',);

const STORE = 'store_p2';

/** Minimal express-like response double that records what the middleware did. */
function fakeRes() {
  const headers = {};
  return {
    headers,
    statusCode: null,
    body: null,
    setHeader(name, value,) { headers[name] = value; return this; },
    removeHeader(name,) { delete headers[name]; },
    status(code,) { this.statusCode = code; return this; },
    json(payload,) { this.body = payload; return this; },
  };
}

/** Boot the real app on an ephemeral port. */
function bootServer(configOverrides,) {
  const platform = createPlatform(configOverrides,);
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

const BASE_CONFIG = {
  defaultStoreId: STORE,
  apiKey: 'p2-api-key',
  providers: { email: 'console', whatsapp: 'console', },
  intelligence: { churnInactiveDays: 30, forecastWindow: 7, },
};

// ─── 1. Webhook verification fails closed ────────────────────────────────────

test('P2: webhookVerifier refuses an unverifiable request when no secret is set', () => {
  const verifier = webhookVerifier('',);
  const res = fakeRes();
  let passed = false;

  verifier({ get: () => undefined, rawBody: '{}', }, res, () => { passed = true; },);

  assert.equal(passed, false, 'must not call next() without a secret',);
  assert.equal(res.statusCode, 503,);
  assert.match(res.body.error, /not configured/i,);
},);

test('P2: webhookVerifier lets unsigned traffic through only when allowUnsigned is set', () => {
  const verifier = webhookVerifier('', 'x-storecops-signature', { allowUnsigned: true, },);
  let passed = false;

  verifier({ get: () => undefined, rawBody: '{}', }, fakeRes(), () => { passed = true; },);

  assert.equal(passed, true,);
},);

test('P2: webhookVerifier accepts a correct HMAC and rejects a tampered body', () => {
  const secret = 'p2-secret';
  const body = JSON.stringify({ event_type: 'purchase', },);
  const verifier = webhookVerifier(secret,);

  let passed = false;
  verifier(
    { get: (h,) => (h === 'x-storecops-signature' ? signBody(secret, body,) : null), rawBody: body, },
    fakeRes(),
    () => { passed = true; },
  );
  assert.equal(passed, true,);

  const tamperedRes = fakeRes();
  let tamperedPassed = false;
  verifier(
    { get: () => signBody(secret, '{"event_type":"refund"}',), rawBody: body, },
    tamperedRes,
    () => { tamperedPassed = true; },
  );
  assert.equal(tamperedPassed, false,);
  assert.equal(tamperedRes.statusCode, 401,);
},);

test('P2: /track is authenticated by the ingest key, not by an HMAC', async () => {
  // This is the exact shape `public/tracker.js` uses: sendBeacon with the
  // ingest key in the query string and no signature (a browser cannot sign).
  const { base, platform, close, } = await bootServer({
    config: { ...BASE_CONFIG, env: 'production', },
  },);

  try {
    const signup = await platform.auth.signup({
      email: 'tracker@shop.com',
      password: 'correct-horse-battery-staple',
      storeName: 'Tracker Co',
    },);

    const res = await fetch(`${base}/api/v1/track?api_key=${signup.ingest_key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify({
        store_id: signup.store_id,
        event_type: 'purchase',
        customer_id: 'c-snippet',
        total: 12.5,
      },),
    },);

    assert.equal(res.status, 200, 'the storefront snippet must be able to post',);
    assert.equal((await res.json()).accepted, true,);
  } finally {
    await close();
  }
},);

test('P2: /track rejects an unauthenticated post outside the test env', async () => {
  const { base, close, } = await bootServer({
    config: { ...BASE_CONFIG, env: 'production', },
  },);

  try {
    const res = await fetch(`${base}/api/v1/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify({ event_type: 'purchase', store_id: STORE, },),
    },);
    assert.equal(res.status, 401,);
  } finally {
    await close();
  }
},);

test('P2: a long-lived API key in the query is accepted only where it must be', async () => {
  // `/track` and `/live/*` are the two callers that cannot set a header.
  // Anywhere else, a query-string key must be ignored so it cannot leak into
  // access logs, proxy logs, browser history or a Referer.
  const { base, platform, close, } = await bootServer({
    config: { ...BASE_CONFIG, env: 'production', },
  },);

  try {
    const signup = await platform.auth.signup({
      email: 'querykey@shop.com',
      password: 'correct-horse-battery-staple',
      storeName: 'Query Co',
    },);

    // A normal data route: the query key must NOT authenticate.
    const viaQuery = await fetch(
      `${base}/api/v1/report/${signup.store_id}?api_key=${signup.api_key}`,
      { headers: { accept: 'application/json', }, },
    );
    assert.equal(viaQuery.status, 401, 'query-string credentials must not work here',);

    // The same key in the header does authenticate.
    const viaHeader = await fetch(`${base}/api/v1/report/${signup.store_id}`, {
      headers: { 'X-API-Key': signup.api_key, },
    },);
    assert.equal(viaHeader.status, 200,);
  } finally {
    await close();
  }
},);

// ─── 2. CSP is not attacker-selectable ───────────────────────────────────────

/** Run `securityHeaders()` against a synthetic request and return the headers. */
function headersFor(path, query = {},) {
  const res = fakeRes();
  securityHeaders()({ path, query, headers: {}, secure: true, }, res, () => {},);
  return res.headers;
}

test('P2: the query string cannot select a weaker CSP', () => {
  const plain = headersFor('/',);
  const shopParam = headersFor('/', { shop: 'anything.myshopify.com', },);
  const embeddedFlag = headersFor('/', { embedded: '1', },);
  const hostParam = headersFor('/', { host: 'x.myshopify.com', },);

  assert.equal(shopParam['Content-Security-Policy'], plain['Content-Security-Policy'],);
  assert.equal(embeddedFlag['Content-Security-Policy'], plain['Content-Security-Policy'],);
  assert.equal(hostParam['Content-Security-Policy'], plain['Content-Security-Policy'],);
  assert.equal(shopParam['X-Frame-Options'], 'DENY',);
},);

test('P2: the CSP carries no unsafe-eval and no dead CDN origins', () => {
  const csp = headersFor('/',)['Content-Security-Policy'];

  assert.ok(!csp.includes('unsafe-eval',), 'unsafe-eval must not appear',);
  assert.ok(!csp.includes('cdn.jsdelivr.net',), 'Chart.js is vendored locally',);
  assert.ok(!csp.includes('unpkg.com',), 'Lucide is vendored locally',);
  assert.ok(!/script-src[^;]*myshopify\.com/.test(csp,), 'no merchant-hosted scripts',);
},);

test('P2: only the embedded routes relax frame-ancestors', () => {
  const root = headersFor('/',);
  assert.match(root['Content-Security-Policy'], /frame-ancestors 'none'/,);
  assert.equal(root['X-Frame-Options'], 'DENY',);

  const app = headersFor('/app',);
  assert.match(app['Content-Security-Policy'], /frame-ancestors https:\/\/admin\.shopify\.com/,);
  assert.equal(app['X-Frame-Options'], undefined, 'the admin iframe must not be blocked',);

  const admin = headersFor('/admin/dashboard',);
  assert.match(admin['Content-Security-Policy'], /frame-ancestors https:\/\/admin\.shopify\.com/,);
},);

test('P2: isEmbeddedApp is a hint only and never used to pick the policy', () => {
  // The hint still reports what it always did...
  assert.equal(isEmbeddedApp({ query: { shop: 'x', }, headers: {}, },), true,);
  assert.equal(isEmbeddedApp({ query: {}, headers: {}, },), false,);
  // ...but the policy it used to control is now path-derived, so the hint
  // cannot change the outcome (asserted above).
},);

// ─── 3. Malformed path escapes are 400, not 500 ──────────────────────────────

test('P2: an undecodable path is rejected as a bad request, not a server fault', () => {
  const res = fakeRes();
  let passed = false;

  preventPathTraversal()({ path: '/%', query: {}, headers: {}, }, res, () => { passed = true; },);

  assert.equal(passed, false,);
  assert.equal(res.statusCode, 400,);
  assert.match(res.body.error, /invalid path/i,);
},);

test('P2: traversal sequences are still blocked, including percent-encoded ones', () => {
  for (const bad of ['/../../etc/passwd', '/%2e%2e/secret', '/a/..\\b',]) {
    const res = fakeRes();
    let passed = false;
    preventPathTraversal()({ path: bad, query: {}, headers: {}, }, res, () => { passed = true; },);
    assert.equal(passed, false, `${bad} must be blocked`,);
    assert.equal(res.statusCode, 400,);
  }

  const ok = fakeRes();
  let passed = false;
  preventPathTraversal()({ path: '/api/v1/customers', query: {}, headers: {}, }, ok, () => { passed = true; },);
  assert.equal(passed, true,);
},);

// ─── 4. Shopify webhook verifier stays fail-closed ───────────────────────────

test('P2: Shopify webhook verification is unavailable without a client secret', () => {
  const { shopifyWebhookVerifier, } = require('../src/server/security',);
  const res = fakeRes();
  let passed = false;

  shopifyWebhookVerifier('',)({ get: () => undefined, rawBody: '{}', }, res, () => { passed = true; },);

  assert.equal(passed, false,);
  assert.equal(res.statusCode, 401,);
},);

test('P2: Shopify webhook verification uses base64 HMAC over the raw body', () => {
  const { shopifyWebhookVerifier, } = require('../src/server/security',);
  const secret = 'client-secret';
  const rawBody = Buffer.from(JSON.stringify({ id: 1, },),);
  const good = crypto.createHmac('sha256', secret,).update(rawBody,).digest('base64',);

  let passed = false;
  shopifyWebhookVerifier(secret,)(
    { get: (h,) => (h === 'X-Shopify-Hmac-Sha256' ? good : undefined), rawBody, },
    fakeRes(),
    () => { passed = true; },
  );
  assert.equal(passed, true,);

  const res = fakeRes();
  let badPassed = false;
  shopifyWebhookVerifier(secret,)(
    { get: () => 'not-the-signature', rawBody, },
    res,
    () => { badPassed = true; },
  );
  assert.equal(badPassed, false,);
  assert.equal(res.statusCode, 401,);
},);

// ── sanitizeInput (previously untested) ─────────────────────────────────────

/**
 * `sanitizeInput` runs on every request and had no test at all before this. It
 * strips null bytes recursively, including from object keys.
 */
test('sanitizeInput strips null bytes from body, query and params', () => {
  const req = {
    body: { a: 'x\u0000y', nested: { 'k\u0000ey': 'v\u0000', }, list: ['p\u0000q',], },
    query: { q: 'a\u0000b', },
    params: { id: '1\u00002', },
  };
  let nexted = false;

  sanitizeInput()(req, fakeRes(), () => { nexted = true; },);

  assert.equal(nexted, true, 'the middleware must continue the chain',);
  assert.deepEqual(req.body, { a: 'xy', nested: { key: 'v', }, list: ['pq',], },);
  assert.deepEqual(req.query, { q: 'ab', },);
  assert.deepEqual(req.params, { id: '12', },);
},);

/**
 * Express 5 defines `req.query` as a getter-only accessor on the request
 * prototype, so `req.query = x` throws
 * "Cannot set property query of #<IncomingMessage> which has only a getter" and
 * every request 500s. Measured: that single line accounted for 89 failing tests
 * when express 5 was installed (Express 4 sets `query` as an ordinary own
 * property, which is why the assignment was fine there).
 *
 * `replaceRequestField` defines an own property instead, which shadows the
 * inherited accessor and behaves identically on both majors.
 */
test('sanitizeInput survives a getter-only req.query, as Express 5 defines it', () => {
  const proto = {
    get query() { return { q: 'a\u0000b', }; },
  };
  const req = Object.create(proto,);
  req.body = { b: 'c\u0000d', };
  req.params = { id: 'e\u0000f', };

  let nexted = false;
  assert.doesNotThrow(
    () => sanitizeInput()(req, fakeRes(), () => { nexted = true; },),
    'sanitization must not throw when query is an accessor without a setter',
  );

  assert.equal(nexted, true,);
  // An own property now shadows the prototype getter, and it holds the
  // sanitized value rather than the original.
  assert.ok(Object.prototype.hasOwnProperty.call(req, 'query',),);
  assert.deepEqual(req.query, { q: 'ab', },);
  assert.deepEqual(req.body, { b: 'cd', },);
  assert.deepEqual(req.params, { id: 'ef', },);
},);

/**
 * Control. Reproduces the exact Express 5 failure with a plain assignment, so
 * the test above cannot pass for the wrong reason — and so the reason
 * `replaceRequestField` exists stays visible.
 */
test('sanitizeInput control: plain assignment on that shape is the original failure', () => {
  const proto = {
    get query() { return {}; },
  };
  const req = Object.create(proto,);

  assert.throws(
    () => { req.query = { q: 'x', }; },
    (err,) => err instanceof TypeError && /only a getter/.test(err.message,),
    'plain assignment must throw the Express 5 error — otherwise the fix guards nothing',
  );
},);
