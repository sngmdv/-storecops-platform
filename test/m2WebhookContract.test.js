'use strict';

process.env.NODE_ENV = 'test';
// Deterministic client secret so the Shopify verifier is active — it fails
// closed (401) when the secret is empty.
process.env.SHOPIFY_CLIENT_SECRET = 'test-shopify-secret';

/**
 * M2 — "test webhooks 200".
 *
 * The audit's M2 item asks whether Shopify's webhooks actually succeed. The
 * pre-existing tests covered that partially: `test/webhook.test.js` exercises
 * the four compliance routes and `test/shopify-webhook-verify.test.js` covers
 * `/webhooks/orders/:store_id`. What nothing covered is the *contract between
 * the manifest and the code*:
 *
 *   shopify.app.toml declares webhook URIs that Shopify will POST to. If a
 *   declared URI has no route, Shopify gets a 404 on every delivery and the
 *   merchant silently loses that event.
 *
 * That is not hypothetical — it was a real defect. The manifest previously
 * declared orders/create, products/update, inventory_levels/update and
 * refunds/create against routes that do not exist in this codebase, so every
 * order, product change, inventory change and refund POSTed into a 404. The
 * fix removed them, but nothing stopped the next person from re-adding one.
 *
 * This test closes that loop in both directions: every URI declared in the
 * manifest must be a live route returning 200, and the mandatory compliance
 * topics must be declared. A control test proves the probe can actually detect
 * a dead endpoint, so the check cannot pass vacuously.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('crypto',);
const fs = require('fs',);
const path = require('path',);

const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

const SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const TOML_PATH = path.join(__dirname, '..', 'shopify.app.toml',);
const nodeFetch = globalThis.fetch;

// ── Manifest parsing ────────────────────────────────────────────────────────

/** Strip `#` comments so prose about removed webhooks is not parsed as config. */
function stripComments(raw,) {
  return raw
    .split('\n',)
    .map((line,) => {
      const hash = line.indexOf('#',);
      return hash === -1 ? line : line.slice(0, hash,);
    },)
    .join('\n',);
}

/**
 * Every `[[webhooks.subscriptions]]` block: its `uri`, its `topics`, and its
 * `compliance_topics`.
 */
function declaredSubscriptions() {
  const clean = stripComments(fs.readFileSync(TOML_PATH, 'utf8',),);
  const blocks = clean.split('[[webhooks.subscriptions]]',).slice(1,);

  assert.ok(blocks.length > 0, 'shopify.app.toml declares no [[webhooks.subscriptions]]',);

  const parseList = (block, key,) => {
    // `\b` matters: without it, the pattern for `topics` also matches inside
    // `compliance_topics = [...]`, so every compliance topic got counted twice
    // and the duplicate-URI control test failed against a correct manifest.
    const m = new RegExp(`\\b${key}\\s*=\\s*\\[([^\\]]*)\\]`,).exec(block,);
    if (!m) return [];
    return m[1]
      .split(',',)
      .map((s,) => s.trim().replace(/^"|"$/g, '',),)
      .filter(Boolean,);
  };

  return blocks.map((block,) => {
    const uriMatch = /uri\s*=\s*"([^"]*)"/.exec(block,);
    return {
      uri: uriMatch ? uriMatch[1] : null,
      topics: parseList(block, 'topics',),
      complianceTopics: parseList(block, 'compliance_topics',),
    };
  },);
}

// ── Server + signing ────────────────────────────────────────────────────────

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

/** Sign exactly as Shopify does: base64 HMAC-SHA256 over the raw body bytes. */
function sign(raw,) {
  return crypto.createHmac('sha256', SECRET,).update(raw,).digest('base64',);
}

/** POST a body to a webhook path with a valid signature. */
function postSigned(base, uri, body,) {
  const raw = JSON.stringify(body,);
  return nodeFetch(`${base}${uri}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Hmac-Sha256': sign(raw,),
      'X-Shopify-Topic': 'test/topic',
    },
    body: raw,
  },);
}

/** POST with a signature computed over different bytes. */
function postTampered(base, uri, body,) {
  const raw = JSON.stringify(body,);
  return nodeFetch(`${base}${uri}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Hmac-Sha256': sign('tampered-bytes',),
    },
    body: raw,
  },);
}

/** A plausible payload for each declared URI. */
const PAYLOADS = {
  '/webhooks/shopify/app-uninstalled': { myshopify_domain: 'm2-test.myshopify.com', },
  '/webhooks/shopify/data-request': { shop_id: 1, customer: { id: 'cust_m2', }, },
  '/webhooks/shopify/customer-redact': { shop_id: 1, customer: { id: 'cust_m2', }, },
  '/webhooks/shopify/shop-redact': { shop_id: 1, myshopify_domain: 'm2-test.myshopify.com', },
};

const payloadFor = (uri,) => PAYLOADS[uri] || { id: 'generic', email: 'm2@example.com', };

// ── Tests ───────────────────────────────────────────────────────────────────

test('M2: every webhook URI declared in shopify.app.toml is a live route returning 200', async () => {
  const subs = declaredSubscriptions();
  const { base, close, } = await bootServer();
  try {
    const failures = [];
    for (const sub of subs) {
      assert.ok(sub.uri, 'every [[webhooks.subscriptions]] block must declare a uri',);

      const res = await postSigned(base, sub.uri, payloadFor(sub.uri,),);
      if (res.status === 404) {
        failures.push(`${sub.uri} -> 404 (declared in the manifest, no such route)`,);
      } else if (res.status !== 200) {
        failures.push(`${sub.uri} -> HTTP ${res.status} (expected 200)`,);
      }
    }
    assert.deepEqual(
      failures,
      [],
      `declared webhooks that Shopify cannot deliver to:\n${failures.join('\n',)}`,
    );
  } finally {
    await close();
  }
},);

test('M2: the manifest declares the mandatory GDPR compliance topics', async () => {
  const subs = declaredSubscriptions();
  const compliance = subs.flatMap((s,) => s.complianceTopics,);

  // Shopify requires all three for a public app.
  for (const topic of ['customers/data_request', 'customers/redact', 'shop/redact',]) {
    assert.ok(
      compliance.includes(topic,),
      `manifest must declare the mandatory compliance topic ${topic}`,
    );
  }

  // And app/uninstalled must be subscribed, or we never learn about churn.
  const topics = subs.flatMap((s,) => s.topics,);
  assert.ok(
    topics.includes('app/uninstalled',),
    'manifest must subscribe to app/uninstalled',
  );
},);

test('M2: each compliance topic is routed to a distinct, working endpoint', async () => {
  const subs = declaredSubscriptions();
  const { base, close, } = await bootServer();
  try {
    const byTopic = new Map();
    for (const sub of subs) {
      for (const topic of sub.complianceTopics) byTopic.set(topic, sub.uri,);
    }

    const uris = [...byTopic.values(),];
    assert.equal(
      new Set(uris,).size,
      uris.length,
      'each compliance topic must map to its own endpoint, not a shared catch-all',
    );

    for (const [topic, uri,] of byTopic) {
      const res = await postSigned(base, uri, payloadFor(uri,),);
      assert.equal(res.status, 200, `${topic} -> ${uri} returned HTTP ${res.status}`,);
    }
  } finally {
    await close();
  }
},);

test('M2: a tampered signature is rejected with 401 on every declared endpoint', async () => {
  const subs = declaredSubscriptions();
  const { base, close, } = await bootServer();
  try {
    const failures = [];
    for (const sub of subs) {
      const res = await postTampered(base, sub.uri, payloadFor(sub.uri,),);
      if (res.status !== 401) {
        failures.push(`${sub.uri} accepted a tampered signature with HTTP ${res.status}`,);
      }
    }
    assert.deepEqual(
      failures,
      [],
      `webhook verification failures:\n${failures.join('\n',)}`,
    );
  } finally {
    await close();
  }
},);

test('M2: /webhooks/orders/:store_id returns 200 for a valid Shopify signature', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    const res = await postSigned(base, '/webhooks/orders/store_m2', {
      id: 'order_m2_1',
      email: 'buyer@example.com',
      total_price: '120.00',
      line_items: [{ sku: 'sku_1', quantity: 2, price: '60.00', },],
    },);

    assert.notEqual(res.status, 401, 'a valid signature must pass verification',);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`,);

    // The order must have become a real event, not just returned 200.
    const events = await platform.store.events.find({ store_id: 'store_m2', },);
    assert.ok(
      events.some((e,) => e.event_type === 'purchase',),
      'an accepted order webhook must record a purchase event',
    );
  } finally {
    await close();
  }
},);

test('M2: /webhooks/returns/:store_id returns 200 for a valid Shopify signature', async () => {
  const { base, close, } = await bootServer();
  try {
    const res = await postSigned(base, '/webhooks/returns/store_m2', {
      id: 'return_m2_1',
      order_id: 'order_m2_1',
      customer: { id: 'cust_m2', },
      line_items: [{ sku: 'sku_1', quantity: 1, },],
    },);

    assert.notEqual(res.status, 401, 'a valid signature must pass verification',);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`,);
  } finally {
    await close();
  }
},);

/**
 * Control. If the parity probe in the first test could not distinguish a dead
 * endpoint from a live one, it would pass no matter what the manifest said.
 * This proves the probe detects a 404.
 */
test('M2 control: the manifest probe actually detects a dead endpoint', async () => {
  const { base, close, } = await bootServer();
  try {
    const res = await postSigned(base, '/webhooks/shopify/this-route-was-never-implemented', { id: 1, },);
    assert.equal(
      res.status,
      404,
      'the probe must report 404 for an unimplemented URI — otherwise the parity test is vacuous',
    );
  } finally {
    await close();
  }
},);

test('M2 control: the manifest declares no duplicate URI for the same topic', async () => {
  const subs = declaredSubscriptions();
  const seen = new Map();
  const dupes = [];
  for (const sub of subs) {
    for (const topic of [...sub.topics, ...sub.complianceTopics,]) {
      if (seen.has(topic,)) dupes.push(`${topic}: ${seen.get(topic,)} and ${sub.uri}`,);
      else seen.set(topic, sub.uri,);
    }
  }
  assert.deepEqual(dupes, [], `a topic is declared twice:\n${dupes.join('\n',)}`,);
},);
