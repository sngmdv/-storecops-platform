'use strict';

process.env.NODE_ENV = 'test';

/**
 * TRK-001 — the storefront tracker must actually transmit.
 *
 * The defect: `public/tracker.js` read `?store=` and `?key=` off its own script
 * URL and returned if either was missing, but BOTH loaders shipped with the
 * theme app extension supply only a `data-store` attribute and no query
 * parameters. So the tracker exited on line 67 of every storefront page load and
 * sent zero events, silently — no error, no log, no failed request. Nothing in
 * the platform could observe it except `tracking_active`, which is derived from
 * events arriving and therefore could never become true.
 *
 * The fix adds `POST /proxy/track` (tenant taken from the SIGNED proxy query,
 * never the body) and teaches the bootstrap to read `data-store`.
 *
 * Three groups of tests:
 *   A. the proxy ingest route — including cross-tenant isolation
 *   B. the tracker bootstrap — the two install shapes, exercised for real
 *   C. a DERIVED guard tying the loaders to what the tracker actually reads
 */

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('node:crypto',);
const fs = require('node:fs',);
const path = require('node:path',);
const vm = require('node:vm',);

const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

const CLIENT_ID = 'proxy-client-id-1234567890';
const CLIENT_SECRET = 'proxy-client-secret-abcdefghij';
const SHOP = 'storecops-proxy.myshopify.com';
const OTHER_SHOP = 'other-merchant.myshopify.com';

const TRACKER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'tracker.js',),
  'utf8',
);
const EXTENSION_DIR = path.join(__dirname, '..', 'shopify-app', 'extensions',);

// ── Server harness ──────────────────────────────────────────────────────────

function sign(params, secret = CLIENT_SECRET,) {
  const base = Object.keys(params,).sort().map((k,) => `${k}=${params[k]}`,).join('',);
  return crypto.createHmac('sha256', secret,).update(base,).digest('hex',);
}

function signedQuery(shop = SHOP, extra = {},) {
  const params = {
    shop,
    path_prefix: '/apps/storecops',
    timestamp: '1757600000',
    ...extra,
  };
  params.signature = sign(params,);
  return new URLSearchParams(params,).toString();
}

async function bootServer() {
  process.env.SHOPIFY_CLIENT_ID = CLIENT_ID;
  process.env.SHOPIFY_CLIENT_SECRET = CLIENT_SECRET;

  const platform = createPlatform();
  const app = createApp(platform,);
  const server = await new Promise((resolve,) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s,),);
  },);

  const makeTenant = async (email, storeName, shopDomain,) => {
    const tenant = await platform.auth.signup({
      email,
      password: 'p2-fixture-passphrase-9f3a2b',
      storeName,
    },);
    await platform.store.integrations.insert({
      store_id: tenant.store_id,
      type: 'shopify',
      status: 'active',
      config: { shopDomain, tokenEncrypted: 'x', },
    },);
    return tenant;
  };

  const primary = await makeTenant('proxy-ingest@example.com', 'Proxy Ingest Co', SHOP,);
  const other = await makeTenant('proxy-other@example.com', 'Other Merchant Co', OTHER_SHOP,);

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    platform,
    primary,
    other,
    close: () => new Promise((done,) => server.close(done,),),
  };
}

function cleanupEnv() {
  delete process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_SECRET;
}

const eventBody = (extra = {},) => ({
  event_type: 'product_view',
  timestamp: new Date().toISOString(),
  session_id: 'sess_proxy_1',
  visitor_id: 'vis_proxy_1',
  product_id: 'prod_1',
  product_price: 42.5,
  ...extra,
});

const countEvents = async (platform, storeId,) => {
  const rows = await platform.store.events.find({ store_id: storeId, },);
  return rows.length;
};

// ── A. The proxy ingest route ───────────────────────────────────────────────

test('TRK-001: a signed proxy request ingests an event for the proxy tenant', async () => {
  const { base, platform, primary, close, } = await bootServer();
  try {
    const before = await countEvents(platform, primary.store_id,);

    const res = await fetch(`${base}/proxy/track?${signedQuery()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify(eventBody(),),
    },);
    const body = await res.json();

    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body,)}`,);
    assert.strictEqual(body.accepted, true,);
    assert.strictEqual(
      await countEvents(platform, primary.store_id,),
      before + 1,
      'the event must be persisted against the proxy tenant',
    );
  } finally {
    await close();
    cleanupEnv();
  }
},);

test('TRK-001: an unsigned or tampered proxy ingest is rejected', async () => {
  const { base, platform, primary, close, } = await bootServer();
  try {
    const before = await countEvents(platform, primary.store_id,);

    const unsigned = await fetch(`${base}/proxy/track?shop=${SHOP}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify(eventBody(),),
    },);
    assert.strictEqual(unsigned.status, 401,);

    // Signed for SHOP, then the shop is swapped — the classic tamper.
    const params = { shop: SHOP, path_prefix: '/apps/storecops', timestamp: '1757600000', };
    params.signature = sign(params,);
    params.shop = OTHER_SHOP;
    const tampered = await fetch(
      `${base}/proxy/track?${new URLSearchParams(params,).toString()}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', },
        body: JSON.stringify(eventBody(),),
      },
    );
    assert.strictEqual(tampered.status, 401,);

    assert.strictEqual(
      await countEvents(platform, primary.store_id,),
      before,
      'a rejected request must not write anything',
    );
  } finally {
    await close();
    cleanupEnv();
  }
},);

test('TRK-001: the body cannot choose the tenant — a forged store_id is ignored', async () => {
  // The whole reason the proxy path is safe to expose to a storefront visitor:
  // anyone on the storefront can reach it (Shopify signs for them), but the
  // store comes from the signature, not the payload.
  const { base, platform, primary, other, close, } = await bootServer();
  try {
    const otherBefore = await countEvents(platform, other.store_id,);
    const primaryBefore = await countEvents(platform, primary.store_id,);

    // Anti-vacuity: the victim tenant is real and readable, so "no events" is a
    // fact about isolation rather than about the store not existing.
    assert.strictEqual(typeof otherBefore, 'number',);

    const res = await fetch(`${base}/proxy/track?${signedQuery()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify(
        eventBody({ store_id: other.store_id, email: 'victim@example.com', },),
      ),
    },);
    assert.strictEqual(res.status, 200,);

    assert.strictEqual(
      await countEvents(platform, other.store_id,),
      otherBefore,
      'the forged store_id must NOT receive the event',
    );
    assert.strictEqual(
      await countEvents(platform, primary.store_id,),
      primaryBefore + 1,
      'the event belongs to the store the signature names',
    );
  } finally {
    await close();
    cleanupEnv();
  }
},);

test('TRK-001: an invalid event is still rejected through the proxy', async () => {
  const { base, platform, primary, close, } = await bootServer();
  try {
    const before = await countEvents(platform, primary.store_id,);

    const res = await fetch(`${base}/proxy/track?${signedQuery()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify({ event_type: 'not_a_real_event', session_id: 's1', },),
    },);

    assert.strictEqual(res.status, 400,);
    assert.strictEqual(await countEvents(platform, primary.store_id,), before,);
  } finally {
    await close();
    cleanupEnv();
  }
},);

test('TRK-001: consent gating applies through the proxy, per category', async () => {
  // Two facts make the obvious version of this test wrong, and both are worth
  // stating because they are easy to misremember:
  //   - `purchase` maps to the ESSENTIAL category, which `hasConsent()` returns
  //     true for unconditionally. It can never be gated.
  //   - A missing consent record defaults to ALLOW ("implied consent"), so an
  //     absent record proves nothing either.
  // A real gate test needs a non-essential category and an explicit record.
  const { base, platform, primary, close, } = await bootServer();
  try {
    const identity = 'cust_marketing_declined';
    await platform.consentService.setConsent(
      primary.store_id,
      identity,
      { analytics: true, marketing: false, recovery: false, essential: true, },
      { source: 'test', },
    );

    const post = async (eventType,) => {
      const res = await fetch(`${base}/proxy/track?${signedQuery()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', },
        body: JSON.stringify(eventBody({ event_type: eventType, customer_id: identity, },),),
      },);
      return { status: res.status, body: await res.json(), };
    };

    const marketing = await post('email_opened',);
    assert.strictEqual(marketing.body.accepted, false, 'marketing must be blocked',);
    assert.strictEqual(marketing.body.consent_blocked, true,);

    // Analytics is still granted for the same identity — so this is a category
    // gate, not a blanket block on the identity.
    const analytics = await post('product_view',);
    assert.strictEqual(analytics.status, 200,);
    assert.strictEqual(analytics.body.accepted, true, 'analytics consent was granted',);
  } finally {
    await close();
    cleanupEnv();
  }
},);

// ── B. The tracker bootstrap, exercised for real ────────────────────────────

/**
 * Run `public/tracker.js` in a stubbed storefront and capture what it sends.
 *
 * The IIFE transmits `session_start` during init, so simply loading it proves
 * whether the bootstrap got far enough to send anything at all — which is
 * exactly what regressed.
 */
function runTracker({ src, dataset = {}, shopifyPrivacy, } = {},) {
  const beacons = [];
  const warnings = [];

  const scriptEl = { src, dataset, setAttribute() {}, };

  const makeEl = () => ({
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, contains: () => false, },
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    closest: () => null,
  });

  const documentStub = {
    currentScript: scriptEl,
    querySelector: (sel,) => (String(sel,).includes('tracker.js',) ? scriptEl : null),
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => makeEl(),
    addEventListener() {},
    removeEventListener() {},
    body: makeEl(),
    head: makeEl(),
    documentElement: { scrollHeight: 1000, },
    referrer: '',
  };

  const storage = () => {
    const m = new Map();
    return {
      getItem: (k,) => (m.has(k,) ? m.get(k,) : null),
      setItem: (k, v,) => m.set(k, String(v,),),
      removeItem: (k,) => m.delete(k,),
    };
  };

  const win = {
    location: { href: src, pathname: '/', search: '', hostname: 'shop.example', },
    scrollY: 0,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    crypto: { randomUUID: () => 'uuid-0000', },
    Shopify: shopifyPrivacy ? { customerPrivacy: shopifyPrivacy, } : undefined,
  };

  const sandbox = {
    window: win,
    document: documentStub,
    navigator: {
      userAgent: 'node-test',
      sendBeacon: (url, blob,) => {
        beacons.push({ url, body: JSON.parse(blob.parts.join('',),), },);
        return true;
      },
    },
    Blob: class {
      constructor(parts, opts,) {
        this.parts = parts;
        this.type = opts?.type;
      }
    },
    localStorage: storage(),
    sessionStorage: storage(),
    console: { log() {}, warn: (m,) => warnings.push(String(m,),), error() {}, },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    URL,
    URLSearchParams,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    Map,
    Set,
  };
  vm.createContext(sandbox,);
  vm.runInContext(TRACKER_SRC, sandbox, { filename: 'tracker.js', },);
  return { beacons, warnings, sandbox, };
}

const PROXY_SRC = `https://${SHOP}/apps/storecops/tracker.js`;
const MANUAL_SRC = 'https://storecops-production.up.railway.app/tracker.js?store=store_abc&key=ing_abc';

test('TRK-001: the theme-extension shape transmits without any key', () => {
  const { beacons, warnings, } = runTracker({
    src: PROXY_SRC,
    dataset: { store: SHOP, storecopsTracker: '1', },
  },);

  assert.strictEqual(
    beacons.length,
    1,
    `the tracker must send session_start under the extension; warnings: ${warnings.join(' | ',)}`,
  );
  assert.strictEqual(
    beacons[0].url,
    `https://${SHOP}/apps/storecops/track`,
    'it must post through the signed proxy path',
  );
},);

test('TRK-001: the proxy shape sends no store_id, so a missing override fails closed', () => {
  const { beacons, } = runTracker({
    src: PROXY_SRC,
    dataset: { store: SHOP, },
  },);

  assert.strictEqual(beacons.length, 1,);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(beacons[0].body, 'store_id',),
    false,
    'the tenant must come from the signature, not the payload',
  );
  assert.strictEqual(beacons[0].body.event_type, 'session_start',);
},);

test('TRK-001: the manual-paste shape still works, with the key in the query', () => {
  const { beacons, } = runTracker({ src: MANUAL_SRC, },);

  assert.strictEqual(beacons.length, 1,);
  assert.strictEqual(
    beacons[0].url,
    'https://storecops-production.up.railway.app/api/v1/track?api_key=ing_abc',
  );
  assert.strictEqual(beacons[0].body.store_id, 'store_abc',);
},);

test('TRK-001: an unconfigured install is silent AND says why', () => {
  // The old code returned with no trace at all, which is how this stayed hidden.
  const { beacons, warnings, } = runTracker({ src: 'https://example.com/tracker.js', },);

  assert.strictEqual(beacons.length, 0, 'nothing can be sent without config',);
  assert.strictEqual(warnings.length, 1, 'the bail must be observable',);
  assert.match(warnings[0], /not configured/,);
},);

test('TRK-001 control: the harness captures nothing when consent blocks everything', () => {
  // Proves `beacons` is a real observation rather than a constant.
  const { beacons, } = runTracker({
    src: PROXY_SRC,
    dataset: { store: SHOP, },
    shopifyPrivacy: { analyticsProcessingAllowed: false, marketingAllowed: false, },
  },);
  assert.strictEqual(beacons.length, 0, 'if this is non-zero the harness is not reading consent',);
},);

// ── C. Derived guard: the loaders and the loaded must agree ─────────────────

/** Every extension block that loads the tracker. */
function trackerLoaders() {
  const files = [];
  const walk = (dir,) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, },)) {
      const full = path.join(dir, entry.name,);
      if (entry.isDirectory()) walk(full,);
      else if (entry.name.endsWith('.liquid',) && fs.readFileSync(full, 'utf8',).includes('tracker.js',)) {
        files.push(full,);
      }
    }
  };
  walk(EXTENSION_DIR,);
  return files;
}

/**
 * Strip comments before pattern-matching.
 *
 * Not cosmetic: a commented-out `script.setAttribute('data-store', ...)` would
 * otherwise SATISFY the guard below, so deleting the line would look like a
 * pass. (`//` is excluded after a colon so `https://` survives.)
 */
function stripComments(src,) {
  return src
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '',)
    .replace(/\/\*[\s\S]*?\*\//g, '',)
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1',);
}

const LOADERS = trackerLoaders();

test('TRK-001: the loaders were actually found', () => {
  assert.ok(LOADERS.length >= 2, `expected the extension loaders, found ${LOADERS.length}`,);
},);

test('TRK-001: every loader supplies the config key the tracker reads', () => {
  // This is the drift that caused the outage: two files written against two
  // different install mechanisms, and nothing compared them.
  assert.ok(
    /dataset\.store/.test(stripComments(TRACKER_SRC,),),
    'the tracker must read `data-store`; if this moves, update the loaders',
  );

  const missing = LOADERS
    .filter((f,) => !/setAttribute\(\s*['"]data-store['"]/.test(stripComments(fs.readFileSync(f, 'utf8',),),),)
    .map((f,) => path.relative(path.join(__dirname, '..',), f,),);

  assert.deepStrictEqual(missing, [], `loader(s) do not set data-store:\n  ${missing.join('\n  ',)}`,);
},);

test('TRK-001: no loader relies on a query string the tracker no longer needs', () => {
  // A loader that appended `?store=&key=` would put the ingest key in public
  // storefront HTML — the exact thing the proxy design exists to avoid.
  const offenders = LOADERS
    .filter((f,) => /tracker\.js\?[^'"]*(store|key)=/.test(stripComments(fs.readFileSync(f, 'utf8',),),),)
    .map((f,) => path.relative(path.join(__dirname, '..',), f,),);

  assert.deepStrictEqual(offenders, [], `loader(s) put credentials in the script URL:\n  ${offenders.join('\n  ',)}`,);
},);

test('TRK-001 control: the loader guard detects a loader that omits data-store', () => {
  const guard = (src,) => !/setAttribute\(\s*['"]data-store['"]/.test(stripComments(src,),);
  assert.strictEqual(guard('script.setAttribute(\'data-store\', shop);',), false,);
  assert.strictEqual(guard('script.src = \'/apps/storecops/tracker.js\';',), true,);
  // …and a commented-out call must not satisfy it.
  assert.strictEqual(guard('// script.setAttribute(\'data-store\', shop);',), true,);
},);
