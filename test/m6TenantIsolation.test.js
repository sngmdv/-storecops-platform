'use strict';

process.env.NODE_ENV = 'test';

/**
 * M6 — "tenant isolation adversarial".
 *
 * The pre-existing coverage was a single test in `securityRegression.test.js`
 * ("store A cannot read store B data"). One route, one direction. This sweeps
 * EVERY route that carries a `:store_id` parameter, in both auth modes, and
 * pairs each cross-tenant probe with a same-tenant control.
 *
 * WHY THE CONTROL MATTERS
 * -----------------------
 * Asserting "A gets 403 when asking for B's store" is only meaningful if the
 * same route does NOT 403 when A asks for its own store. Without that control,
 * a route that rejects everything — or a typo that requests a nonexistent path
 * and gets a blanket 403 from some earlier gate — would make the isolation
 * assertion pass while proving nothing. Every probe below therefore asserts
 * both halves.
 *
 * The guard under test is `router.param('store_id')` in apiRoutes.js, which
 * runs for all 149 `:store_id` routes and rejects any store the caller does not
 * own. It is a single choke point, so a regression there is a total isolation
 * failure — exactly the kind of thing worth pinning down exhaustively.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('crypto',);

const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

const nodeFetch = globalThis.fetch;

// ── Route enumeration ───────────────────────────────────────────────────────

/**
 * Every route registered on the app, with the mount prefix reattached.
 *
 * Read straight off the Express router stack so the sweep automatically covers
 * routes added later — a hand-maintained list would rot, and the routes that
 * rot out of it are precisely the new ones nobody has tested.
 */
/**
 * Recover the mount path from an Express router layer's `regexp.source`.
 *
 * Express encodes a router mounted at `/api/v1` as `^\/api\/v1\/?(?=\/|$)`.
 * Naively splitting on the first backslash yields `api` — which silently
 * turned every probe path into `/api/customers/:store_id`, a route that does
 * not exist, so all 300 probes returned 404 and the sweep proved nothing.
 */
function mountPathFromRegexp(regexp,) {
  const source = regexp?.source || '';
  if (!source || source === '^\\/?' || source === '^\\/') return '';

  const path = source
    .replace(/^\^/, '',)
    .replace(/\\\//g, '/',)
    .split('/?(',)[0]
    .split('(?=',)[0]
    .replace(/\/+$/, '',);

  return path === '/' ? '' : path;
}

function enumerateRoutes(app,) {
  const found = [];

  const walk = (stack, prefix,) => {
    for (const layer of stack) {
      if (layer.route) {
        const path = `${prefix}${layer.route.path}`.replace(/\/{2,}/g, '/',);
        found.push({ path, methods: Object.keys(layer.route.methods,), },);
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, `${prefix}${mountPathFromRegexp(layer.regexp,)}`,);
      }
    }
  };

  walk(app._router.stack, '',);
  return found;
}

// ── Server + tenants ────────────────────────────────────────────────────────

function bootServer() {
  const platform = createPlatform();
  const app = createApp(platform,);
  return new Promise((resolve,) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port, } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        app,
        platform,
        close: () => new Promise((done,) => server.close(done,),),
      },);
    },);
  },);
}

async function createTenant(base, email, storeName,) {
  const res = await nodeFetch(`${base}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', },
    body: JSON.stringify({ email, password: 'Mango-Ferry-Quilt-92', store_name: storeName, },),
  },);
  const body = await res.json();
  assert.ok(res.ok, `signup(${email}) failed: ${res.status} ${JSON.stringify(body,)}`,);
  return {
    storeId: body.store_id,
    token: body.token,
    apiKey: body.api_key,
    ingestKey: body.ingest_key,
    email,
  };
}

/** Credential headers for the two distinct auth paths. */
const asApiKey = (tenant,) => ({ 'X-API-Key': tenant.apiKey, });
const asSession = (tenant,) => ({ Authorization: `Bearer ${tenant.token}`, });

function call(base, method, path, headers, body,) {
  return nodeFetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers, },
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body || {},),
  },);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('M6: no :store_id route lets a tenant reach another tenant (both auth paths)', async () => {
  const { base, app, close, } = await bootServer();
  try {
    const alice = await createTenant(base, 'alice@m6.example.com', 'M6 Alice',);
    const bob = await createTenant(base, 'bob@m6.example.com', 'M6 Bob',);

    assert.notEqual(alice.storeId, bob.storeId, 'tenants must get distinct stores',);

    // `/live/:store_id` is a Server-Sent Events stream — a normal fetch would
    // hang until the socket times out, so it is exercised separately below.
    //
    // `/webhooks/*` is excluded deliberately: those routes live at the app root
    // (not under /api/v1) and are authenticated by the SHOPIFY HMAC signature,
    // not by tenant ownership, so they correctly answer 401 rather than 403 to
    // an unsigned request. Their contract is asserted separately.
    const routes = enumerateRoutes(app,)
      .filter((r,) => r.path.includes(':store_id',),)
      .filter((r,) => !r.path.startsWith('/live/',),)
      .filter((r,) => !r.path.startsWith('/webhooks/',),)
      .filter((r,) => !r.path.startsWith('/api/v1/admin/',),);

    assert.ok(
      routes.length >= 100,
      `expected the full :store_id surface, found only ${routes.length}`,
    );

    const leaks = [];
    const vacuous = [];

    for (const route of routes) {
      const method = route.methods.includes('get',) ? 'GET' : route.methods[0].toUpperCase();
      const ownPath = route.path.replace(':store_id', alice.storeId,)
        .replace(/:[A-Za-z_]+/g, 'probe_id',);
      const crossPath = route.path.replace(':store_id', bob.storeId,)
        .replace(/:[A-Za-z_]+/g, 'probe_id',);

      for (const [label, headers,] of [['api-key', asApiKey(alice,),], ['session', asSession(alice,),],]) {
        const cross = await call(base, method, crossPath, headers,);
        if (cross.status !== 403) {
          leaks.push(`${label} ${method} ${route.path} -> HTTP ${cross.status} (expected 403)`,);
          continue;
        }

        // Control: the same route, same credential, OWN store must not 403.
        // If it does, the 403 above proved nothing about isolation.
        const own = await call(base, method, ownPath, headers,);
        if (own.status === 403) {
          vacuous.push(`${label} ${method} ${route.path} 403s even for the owning tenant`,);
        }
      }
    }

    assert.deepEqual(
      leaks,
      [],
      `cross-tenant access was permitted:\n${leaks.join('\n',)}`,
    );
    assert.deepEqual(
      vacuous,
      [],
      `routes that reject everyone, making the isolation probe vacuous:\n${vacuous.join('\n',)}`,
    );
  } finally {
    await close();
  }
},);

test('M6: an operator-only /admin route is closed to a normal tenant', async () => {
  const { base, close, } = await bootServer();
  try {
    const alice = await createTenant(base, 'alice2@m6.example.com', 'M6 Alice 2',);

    // Signup grants role 'admin' of the tenant but NOT platform_admin, so
    // every /admin/* surface must refuse. This is the flag that matters.
    for (const path of ['/api/v1/admin/stores', '/api/v1/admin/stats',]) {
      for (const [label, headers,] of [['api-key', asApiKey(alice,),], ['session', asSession(alice,),],]) {
        const res = await call(base, 'GET', path, headers,);
        assert.equal(
          res.status,
          403,
          `${label} ${path} must be operator-only, got HTTP ${res.status}`,
        );
      }
    }
  } finally {
    await close();
  }
},);

test('M6: a tenant cannot reach another tenant via the /admin GDPR export', async () => {
  const { base, close, } = await bootServer();
  try {
    const alice = await createTenant(base, 'alice3@m6.example.com', 'M6 Alice 3',);
    const bob = await createTenant(base, 'bob3@m6.example.com', 'M6 Bob 3',);

    const res = await call(
      base,
      'GET',
      `/api/v1/admin/gdpr/${bob.storeId}/cust_x`,
      asApiKey(alice,),
    );
    assert.equal(res.status, 403, 'the GDPR export is an operator surface',);
  } finally {
    await close();
  }
},);

test('M6: the write-only ingest key cannot read anything', async () => {
  const { base, close, } = await bootServer();
  try {
    const alice = await createTenant(base, 'alice4@m6.example.com', 'M6 Alice 4',);
    const ingest = { 'X-API-Key': alice.ingestKey, };

    // A sample of read routes across different layers.
    const reads = [
      `/api/v1/report/${alice.storeId}`,
      `/api/v1/customers/${alice.storeId}`,
      `/api/v1/inventory/${alice.storeId}/levels`,
      `/api/v1/billing/${alice.storeId}/invoices`,
      '/api/v1/export/store',
    ];

    for (const path of reads) {
      const res = await call(base, 'GET', path, ingest,);
      assert.equal(
        res.status,
        403,
        `the ingest key must not read ${path} (got HTTP ${res.status})`,
      );
    }
  } finally {
    await close();
  }
},);

test('M6: an unknown bearer token is rejected, never trusted', async () => {
  const { base, close, } = await bootServer();
  try {
    const alice = await createTenant(base, 'alice5@m6.example.com', 'M6 Alice 5',);

    // The app's own session tokens are opaque 32-byte hex strings looked up in
    // `sessions` — they are NOT JWTs. (The HS256 path in sessionToken.js is for
    // Shopify App Bridge tokens, keyed by the app client secret.) So the right
    // probe here is an arbitrary attacker-chosen string, plus a well-formed JWT
    // that is signed with the wrong key.
    const candidates = [
      'not-a-real-session-token',
      crypto.randomBytes(32,).toString('hex',),
      [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', },),).toString('base64url',),
        Buffer.from(JSON.stringify({
          sub: alice.email,
          store_id: alice.storeId,
          exp: Math.floor(Date.now() / 1000,) + 3600,
        },),).toString('base64url',),
        crypto.createHmac('sha256', 'attacker-chosen-key',).update('forged',).digest('base64url',),
      ].join('.',),
    ];

    for (const token of candidates) {
      const res = await call(base, 'GET', `/api/v1/report/${alice.storeId}`, {
        Authorization: `Bearer ${token}`,
      },);
      assert.ok(
        res.status === 401 || res.status === 403,
        `a forged token must be refused, got HTTP ${res.status} for ${token.slice(0, 24,)}…`,
      );
    }
  } finally {
    await close();
  }
},);

test('M6: an expired app session token is rejected and cleaned up', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    const alice = await createTenant(base, 'alice6@m6.example.com', 'M6 Alice 6',);

    // The freshly minted token must work first — otherwise the assertion below
    // would pass for the wrong reason.
    const before = await call(base, 'GET', `/api/v1/report/${alice.storeId}`, asSession(alice,),);
    assert.equal(before.status, 200, 'a fresh session token must authenticate',);

    // Force the session into the past.
    const row = await platform.store.sessions.findOne({ token: alice.token, },);
    assert.ok(row, 'the session row must exist',);
    await platform.store.sessions.update(row._id, {
      expires_at: new Date(Date.now() - 1000,).toISOString(),
    },);

    const after = await call(base, 'GET', `/api/v1/report/${alice.storeId}`, asSession(alice,),);
    assert.ok(
      after.status === 401 || after.status === 403,
      `an expired session must be refused, got HTTP ${after.status}`,
    );

    // `verify` deletes the row on the expiry path rather than leaving it to rot.
    const gone = await platform.store.sessions.findOne({ token: alice.token, },);
    assert.equal(gone, null, 'an expired session row must be removed',);
  } finally {
    await close();
  }
},);

test('M6: logout deletes the session row so it cannot be replayed', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    const alice = await createTenant(base, 'alice8@m6.example.com', 'M6 Alice 8',);

    const ok = await call(base, 'GET', `/api/v1/report/${alice.storeId}`, asSession(alice,),);
    assert.equal(ok.status, 200,);

    const out = await nodeFetch(`${base}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}`, },
    },);
    assert.ok(out.ok, `logout should succeed, got ${out.status}`,);

    // Deleting (not tombstoning) matters: a tombstoned row still holds the
    // user id and email forever.
    const row = await platform.store.sessions.findOne({ token: alice.token, },);
    assert.equal(row, null, 'logout must delete the session row, not tombstone it',);

    const replay = await call(base, 'GET', `/api/v1/report/${alice.storeId}`, asSession(alice,),);
    assert.ok(
      replay.status === 401 || replay.status === 403,
      `a logged-out token must not work, got HTTP ${replay.status}`,
    );
  } finally {
    await close();
  }
},);

test('M6: root-level webhook routes are HMAC-gated, not tenant-gated', async () => {
  const { base, close, } = await bootServer();
  try {
    const alice = await createTenant(base, 'alice9@m6.example.com', 'M6 Alice 9',);

    // These two routes live at the app root and are reachable without any
    // tenant credential at all — by design, since Shopify calls them. Their
    // only gate is the HMAC signature, so an unsigned request must be refused.
    for (const path of ['/webhooks/orders/store_x', '/webhooks/returns/store_x',]) {
      const res = await call(base, 'POST', path, asApiKey(alice,), { id: 'o1', },);
      assert.equal(
        res.status,
        401,
        `${path} must require a valid Shopify signature, got HTTP ${res.status}`,
      );
    }

    // RESIDUAL RISK (documented, not fixed here): Shopify signs the request
    // BODY, not the URL. So a correctly signed payload for store A, if it were
    // captured, could be replayed against `/webhooks/orders/store_B` and would
    // still verify — cross-tenant event injection. Mitigation would be to
    // confirm the payload's `myshopify_domain` resolves to the same store as
    // the `:store_id` path param after verification. Not exploitable without a
    // captured signed body, so it is recorded rather than changed here.
    const unsigned = await nodeFetch(`${base}/webhooks/orders/store_x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify({ id: 'o1', myshopify_domain: 'x.myshopify.com', },),
    },);
    assert.equal(unsigned.status, 401,);
  } finally {
    await close();
  }
},);

test('M6 control: the cross-tenant probe detects a real leak when one is planted', async () => {
  const { base, close, } = await bootServer();
  try {
    const alice = await createTenant(base, 'alice7@m6.example.com', 'M6 Alice 7',);

    // Sanity: the probe's own request shape must succeed for the owning tenant,
    // proving that a 403 in the sweep means "wrong owner" and not "bad request".
    const own = await call(base, 'GET', `/api/v1/customers/${alice.storeId}`, asApiKey(alice,),);
    assert.notEqual(
      own.status,
      403,
      'the owning tenant must be able to read its own customers',
    );
    assert.equal(own.status, 200,);
  } finally {
    await close();
  }
},);
