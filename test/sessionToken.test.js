'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('node:crypto',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);
const { createSessionTokenVerifier, normalizeShop, } = require('../src/server/sessionToken',);

const CLIENT_ID = 'test-client-id-1234567890';
const CLIENT_SECRET = 'test-client-secret-abcdefghijklmnop';
const SHOP = 'storecops-test.myshopify.com';

/** Encode an object as a base64url JWT segment. */
function segment(obj,) {
  return Buffer.from(JSON.stringify(obj,),).toString('base64url',);
}

/** Mint a JWT with the given payload, signed with `secret`. */
function mintToken(payload, { secret = CLIENT_SECRET, header = { alg: 'HS256', typ: 'JWT', }, } = {},) {
  const head = segment(header,);
  const body = segment(payload,);
  const signature = crypto.createHmac('sha256', secret,).update(`${head}.${body}`,).digest('base64url',);
  return `${head}.${body}.${signature}`;
}

/** A payload shaped like a real Shopify session token. */
function validPayload(overrides = {},) {
  const now = Math.floor(Date.now() / 1000,);
  return {
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: CLIENT_ID,
    sub: '42',
    exp: now + 60,
    nbf: now - 5,
    iat: now - 5,
    jti: 'abc-123',
    sid: 'session-1',
    ...overrides,
  };
}

/** Build a verifier wired to the test credentials. */
function makeVerifier(warn = () => {},) {
  const credentialsFor = async () => ({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, });
  return createSessionTokenVerifier({ credentialsFor, warn, },);
}

test('session token: accepts a correctly signed App Bridge token', async () => {
  const verifier = makeVerifier();
  const result = await verifier.verify(mintToken(validPayload(),),);

  assert.ok(result, 'expected a verified result',);
  assert.strictEqual(result.shop_domain, SHOP,);
  assert.strictEqual(result.user_id, '42',);
},);

test('session token: rejects a tampered payload', async () => {
  const verifier = makeVerifier();
  const token = mintToken(validPayload(),);
  const [head, , signature,] = token.split('.',);

  // Re-encode the payload claiming a different shop, keeping the old sig.
  const forged = `${head}.${segment(validPayload({ dest: 'https://evil.myshopify.com', },),)}.${signature}`;
  assert.strictEqual(await verifier.verify(forged,), null,);
},);

test('session token: rejects a token signed with the wrong secret', async () => {
  const verifier = makeVerifier();
  const token = mintToken(validPayload(), { secret: 'not-the-real-secret', },);
  assert.strictEqual(await verifier.verify(token,), null,);
},);

test('session token: rejects an expired token', async () => {
  const verifier = makeVerifier();
  const past = Math.floor(Date.now() / 1000,) - 600;
  const token = mintToken(validPayload({ exp: past, nbf: past - 60, },),);
  assert.strictEqual(await verifier.verify(token,), null,);
},);

test('session token: rejects a token that is not yet valid', async () => {
  const verifier = makeVerifier();
  const future = Math.floor(Date.now() / 1000,) + 600;
  const token = mintToken(validPayload({ nbf: future, exp: future + 60, },),);
  assert.strictEqual(await verifier.verify(token,), null,);
},);

test('session token: rejects a token minted for a different app (aud mismatch)', async () => {
  const verifier = makeVerifier();
  const token = mintToken(validPayload({ aud: 'some-other-app-client-id', },),);
  assert.strictEqual(await verifier.verify(token,), null,);
},);

test('session token: rejects a non-HS256 algorithm (alg confusion)', async () => {
  const verifier = makeVerifier();
  const token = mintToken(validPayload(), { header: { alg: 'none', typ: 'JWT', }, },);
  assert.strictEqual(await verifier.verify(token,), null,);
},);

test('session token: rejects malformed input without throwing', async () => {
  const verifier = makeVerifier();
  for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', null, undefined, 12345, 'a.b.c',]) {
    assert.strictEqual(await verifier.verify(bad,), null, `expected ${String(bad,)} to be rejected`,);
  }
},);

test('session token: fails closed when no client credentials are configured', async () => {
  const verifier = createSessionTokenVerifier({ credentialsFor: async () => null, },);
  const token = mintToken(validPayload(),);
  assert.strictEqual(await verifier.verify(token,), null,);
},);

test('session token: rejects a valid signature with a non-myshopify dest', async () => {
  const verifier = makeVerifier();
  const token = mintToken(validPayload({ dest: 'https://attacker.example.com', iss: 'https://attacker.example.com/admin', },),);
  assert.strictEqual(await verifier.verify(token,), null,);
},);

test('normalizeShop: extracts a myshopify host from URL or bare domain', () => {
  assert.strictEqual(normalizeShop(`https://${SHOP}`,), SHOP,);
  assert.strictEqual(normalizeShop(SHOP.toUpperCase(),), SHOP,);
  assert.strictEqual(normalizeShop('https://attacker.example.com',), null,);
  assert.strictEqual(normalizeShop('',), null,);
  assert.strictEqual(normalizeShop(null,), null,);
},);

test('session token auth: an embedded request is scoped to its own tenant', async () => {
  process.env.SHOPIFY_CLIENT_ID = CLIENT_ID;
  process.env.SHOPIFY_CLIENT_SECRET = CLIENT_SECRET;

  const platform = createPlatform({ config: { ...platform_config(), }, },);
  const app = createApp(platform,);

  const server = await new Promise((resolve,) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s,),);
  },);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Two tenants; only the first owns SHOP.
    const mine = await platform.auth.signup({ email: 'mine@example.com', password: 'password123', storeName: 'Mine', },);
    const theirs = await platform.auth.signup({ email: 'theirs@example.com', password: 'password123', storeName: 'Theirs', },);

    await platform.store.integrations.insert({
      store_id: mine.store_id,
      type: 'shopify',
      status: 'active',
      config: { shopDomain: SHOP, tokenEncrypted: 'x', },
    },);

    const token = mintToken(validPayload(),);
    const authHeader = { Authorization: `Bearer ${token}`, };

    // The session token resolves to the owning tenant.
    const own = await fetch(`${base}/api/v1/churn/${mine.store_id}`, { headers: authHeader, },);
    assert.strictEqual(own.status, 200,);

    // ...and cannot be used to read a different tenant's store.
    const cross = await fetch(`${base}/api/v1/churn/${theirs.store_id}`, { headers: authHeader, },);
    assert.strictEqual(cross.status, 403,);

    // A forged token grants no access. Depending on which gate catches
    // it first this is a 401 (auth) or 403 (RBAC / store guard) — both
    // are rejections, and neither may return tenant data.
    const forged = await fetch(`${base}/api/v1/churn/${mine.store_id}`, {
      headers: { Authorization: `Bearer ${mintToken(validPayload(), { secret: 'wrong', },)}`, },
    },);
    assert.ok([401, 403,].includes(forged.status,), `expected rejection, got ${forged.status}`,);
  } finally {
    await new Promise((done,) => server.close(done,),);
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
  }
},);

/** Test config: in-memory storage, test env. */
function platform_config() {
  return { ...require('../src/config/config',), env: 'test', storage: 'memory', };
}
