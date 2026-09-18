'use strict';

process.env.NODE_ENV = 'test';
// The verifier fails closed without credentials, so they must exist before the
// platform is built. Set here rather than relied upon from the ambient env.
process.env.SHOPIFY_CLIENT_ID = 'test-client-id';
process.env.SHOPIFY_CLIENT_SECRET = 'test-client-secret';

/**
 * SHOP-001 — the embedded Shopify auth endpoint must prove the shop.
 *
 * THE DEFECT (found and fixed 2026-09-18, not in the original audit)
 * ------------------------------------------------------------------
 * `POST /api/v1/auth/shopify` read `shop` from the request body, matched it
 * against an unscoped `findOne({ type: 'shopify' })`, and minted a **full
 * session** for whichever tenant owned that domain — while also reading
 * `sessionToken` from the body and never using it, despite its docblock
 * claiming "Verifies the Shopify session and returns a Storecops session".
 *
 * It was reachable without any credential, and the SPA's embedded mode is
 * switched on by URL parameters (`?embedded=1&shop=…`), so the attacker needed
 * only the merchant's public `.myshopify.com` domain. Reproduced before the
 * fix: a credential-free POST returned a 7-day session whose token then read
 * `/api/v1/auth/me` (200, `role: admin`) and `/api/v1/report/<victim store>`.
 *
 * WHAT THIS PINS
 * --------------
 *   1. No token, or a bad token, never yields a session — whatever `shop` the
 *      body claims.
 *   2. A *genuine* token resolves the tenant from its verified `dest`/`iss`,
 *      and a body `shop` cannot steer it elsewhere.
 *   3. The supported flow still works, so the fix is not a blanket denial.
 *   4. The client actually sends a token; without that the server has nothing
 *      to verify and the endpoint would simply be broken instead of unsafe.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs',);
const path = require('node:path',);
const crypto = require('node:crypto',);

const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const VICTIM_SHOP = 'victim-store.myshopify.com';
const VICTIM_EMAIL = 'owner@victim.example';

/** Mint an App Bridge session token, with any claim overridable. */
function mint({ shop = VICTIM_SHOP, secret = CLIENT_SECRET, aud = CLIENT_ID, expDelta = 300, } = {},) {
  const enc = (o,) => Buffer.from(JSON.stringify(o,),).toString('base64url',);
  const now = Math.floor(Date.now() / 1000,);
  const header = enc({ alg: 'HS256', typ: 'JWT', },);
  const payload = enc({
    aud,
    exp: now + expDelta,
    nbf: now - 5,
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    sub: '1',
  },);
  const sig = crypto.createHmac('sha256', secret,).update(`${header}.${payload}`,).digest('base64url',);
  return `${header}.${payload}.${sig}`;
}

/** Boot the app with a victim tenant that owns a live Shopify integration. */
async function boot() {
  const platform = createPlatform();
  const app = createApp(platform,);
  const server = await new Promise((resolve,) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s,),);
  },);

  const signup = await platform.auth.signup({
    email: VICTIM_EMAIL,
    password: 'a-very-long-password-12',
    store_name: 'Victim Store',
  },);
  await platform.store.integrations.insert({
    type: 'shopify',
    store_id: signup.store_id,
    status: 'active',
    config: { shopDomain: VICTIM_SHOP, shopEmail: VICTIM_EMAIL, },
  },);

  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, headers = {},) => {
    const res = await fetch(`${base}/api/v1/auth/shopify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers, },
      body: JSON.stringify(body,),
    },);
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, json, };
  };

  return { platform, server, base, post, victimStoreId: signup.store_id, };
}

// ── The regression itself ───────────────────────────────────────────────────

test('SHOP-001: an unauthenticated caller cannot mint a session by naming a shop', async () => {
  const { server, post, victimStoreId, } = await boot();
  try {
    // Exactly the original attack: no credential of any kind.
    const attack = await post({ shop: VICTIM_SHOP, },);

    assert.strictEqual(attack.status, 401, 'the request must be refused',);
    assert.ok(!attack.json?.session, 'no session may be issued',);
    assert.ok(!attack.json?.store_id, 'no tenant may be disclosed',);
    // The victim's store id must not appear anywhere in the response.
    assert.ok(
      !JSON.stringify(attack.json,).includes(victimStoreId,),
      'the response must not leak the victim tenant id',
    );
  } finally {
    server.close();
  }
},);

test('SHOP-001: claiming embedded mode does not change the outcome', async () => {
  const { server, post, } = await boot();
  try {
    const attack = await post({ shop: VICTIM_SHOP, embedded: 1, host: 'admin.shopify.com', },);
    assert.strictEqual(attack.status, 401,);
    assert.ok(!attack.json?.session,);
  } finally {
    server.close();
  }
},);

test('SHOP-001: a forged, expired or mis-audienced token is refused', async () => {
  const { server, post, } = await boot();
  try {
    const cases = [
      ['forged signature', { sessionToken: mint({ secret: 'attacker-secret', },), },],
      ['expired', { sessionToken: mint({ expDelta: -600, },), },],
      ['wrong audience', { sessionToken: mint({ aud: 'someone-elses-app', },), },],
      ['malformed', { sessionToken: 'not-a-jwt', },],
      ['empty string', { sessionToken: '', },],
    ];
    for (const [label, body,] of cases) {
      const res = await post(body,);
      assert.strictEqual(res.status, 401, `${label} must be refused`,);
      assert.ok(!res.json?.session, `${label} must not yield a session`,);
    }
  } finally {
    server.close();
  }
},);

// ── The supported flow still works ──────────────────────────────────────────

test('SHOP-001: a genuine token resolves the tenant from the token, not the body', async () => {
  const { server, post, victimStoreId, } = await boot();
  try {
    const res = await post({ sessionToken: mint({},), },);
    assert.strictEqual(res.status, 200,);
    assert.ok(res.json?.session?.token, 'a real session is issued',);
    assert.strictEqual(res.json.store_id, victimStoreId,);
    assert.strictEqual(res.json.shop, VICTIM_SHOP,);
  } finally {
    server.close();
  }
},);

test('SHOP-001: a body `shop` claim cannot steer a valid token to another tenant', async () => {
  const { server, post, victimStoreId, } = await boot();
  try {
    // A token for a shop nobody owns, with the victim's domain in the body.
    const res = await post({
      sessionToken: mint({ shop: 'attacker-shop.myshopify.com', },),
      shop: VICTIM_SHOP,
    },);

    assert.strictEqual(res.status, 200,);
    assert.ok(!res.json?.session, 'the body claim must not grant a session',);
    assert.strictEqual(res.json.shop, 'attacker-shop.myshopify.com', 'the token wins',);
    assert.notStrictEqual(res.json.store_id, victimStoreId,);
    assert.ok(res.json.temp_session, 'an unclaimed shop gets a pending session',);
    // A pending session grants nothing: it must not carry a resolvable user.
    assert.strictEqual(res.json.temp_session.pending, true,);
  } finally {
    server.close();
  }
},);

test('SHOP-001: a pending session grants no access', async () => {
  const { server, base, post, } = await boot();
  try {
    const res = await post({ sessionToken: mint({ shop: 'nobody.myshopify.com', },), },);
    const pending = res.json.temp_session.token;

    const me = await fetch(`${base}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${pending}`, },
    },);
    assert.strictEqual(me.status, 401, 'a pending session must not authenticate',);
  } finally {
    server.close();
  }
},);

test('SHOP-001: the bearer form works too, so extension-style callers are supported', async () => {
  const { server, post, victimStoreId, } = await boot();
  try {
    const res = await post({}, { Authorization: `Bearer ${mint({},)}`, },);
    assert.strictEqual(res.status, 200,);
    assert.strictEqual(res.json.store_id, victimStoreId,);
  } finally {
    server.close();
  }
},);

// ── The client half of the contract ─────────────────────────────────────────

const APP_SRC = path.join(__dirname, '..', 'public', 'js', 'app.js',);

test('SHOP-001: the SPA presents a session token rather than asserting a shop', () => {
  const src = fs.readFileSync(APP_SRC, 'utf8',);

  const call = src.match(/api\.post\(\s*"\/auth\/shopify"[\s\S]{0,240}?\)/,);
  assert.ok(call, 'the SPA must still call /auth/shopify',);
  assert.match(call[0], /sessionToken/, 'the call must present a session token',);
  assert.doesNotMatch(
    call[0],
    /\bshop\s*:/,
    'the call must not send the shop domain as if it were proof',
  );

  // And the token must come from App Bridge, not from a URL parameter.
  assert.match(src, /async function shopifyIdToken/, 'the App Bridge helper must exist',);
  assert.match(src, /s\.auth\.idToken\(\)|s\.idToken\(\)/, 'it must read the App Bridge id token',);
},);

test('control — the shop-domain assertion guard detects the original call shape', () => {
  const bad = 'api.post("/auth/shopify", { shop: shopifyShop, host: shopifyHost })';
  const call = bad.match(/api\.post\(\s*"\/auth\/shopify"[\s\S]{0,240}?\)/,);
  assert.ok(call,);
  assert.doesNotMatch(call[0], /sessionToken/, 'the original shape had no token',);
  assert.match(call[0], /\bshop\s*:/, 'and did assert the shop',);
},);
