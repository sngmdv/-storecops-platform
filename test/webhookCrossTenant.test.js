'use strict';

process.env.NODE_ENV = 'test';
// The Shopify verifier fails closed (401) without a secret, so one is set here for
// the same reason `m2WebhookContract.test.js` sets one.
process.env.SHOPIFY_CLIENT_SECRET = 'test-shopify-secret';

/**
 * Cross-tenant webhook injection — end to end, through the real routes.
 *
 * THE DEFECT (M6 residual, item 18)
 * ---------------------------------
 * `/webhooks/orders/:store_id` and `/webhooks/returns/:store_id` verified the HMAC
 * and then trusted the `:store_id` in the path. Shopify signs the body with the
 * app's client secret, which is per-APP rather than per-shop, so a body captured
 * from one merchant verifies for every merchant — and the path parameter was chosen
 * by the caller.
 *
 * Reproduced against the pre-fix route registration, by serving HEAD's
 * `createApp.js` and replaying one signed order body straight into another store:
 *
 *     PRE-FIX: replayed into store_beta -> 200 {"accepted":true, ...}
 *     PRE-FIX: beta events: 1, alpha events: 0
 *
 * The same request now returns 409 and writes nothing. That measurement is what
 * these tests pin down; the module-level reasoning lives in
 * `src/server/webhookTenancy.js`.
 *
 * WHY THE OBVIOUS MITIGATION DOES NOT WORK
 * ----------------------------------------
 * The ledger proposed checking the payload's `myshopify_domain` against the path.
 * Shopify's own docs (`/docs/apps/build/webhooks/delivery-structure`) describe the
 * body as "the full REST resource payload for the topic", and the Order resource has
 * no shop field — so that check cannot fire on an order webhook at all. The only
 * shop identifier Shopify sends is the `X-Shopify-Shop-Domain` HEADER, which the HMAC
 * does not cover and which the replayer can therefore set to anything.
 *
 * The first test below sets that header to the *victim's own* domain, so the header
 * check passes and only the single-use digest can be what refuses it. That isolates
 * the control under test instead of letting a weaker check take the credit.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('crypto',);

const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

const SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const nodeFetch = globalThis.fetch;

/** An order payload as Shopify sends it — note the absence of any shop field. */
const ORDER_BODY = {
  id: 5001,
  total_price: '25.00',
  line_items: [{ sku: 'SKU-1', quantity: 1, price: '25.00', },],
};

function bootServer({ stores = ['store_alpha', 'store_beta',], } = {},) {
  const platform = createPlatform();
  const app = createApp(platform,);
  return (async () => {
    for (const store_id of stores) {
      await platform.store.integrations.insert({
        store_id,
        type: 'shopify',
        status: 'connected',
        config: { shopDomain: `${store_id.replace('store_', '',)}.myshopify.com`, },
      },);
    }
    const server = app.listen(0, '127.0.0.1',);
    await new Promise((ready,) => server.once('listening', ready,),);
    return {
      base: `http://127.0.0.1:${server.address().port}`,
      platform,
      close: () => new Promise((done,) => server.close(done,),),
    };
  })();
}

/** Sign exactly as Shopify does: base64 HMAC-SHA256 over the raw body bytes. */
function sign(raw,) {
  return crypto.createHmac('sha256', SECRET,).update(raw,).digest('base64',);
}

/**
 * POST a signed body. The raw string is passed in rather than rebuilt, so the SAME
 * captured bytes can be sent twice — which is what a replay is.
 */
function postRaw(base, uri, raw, headers = {},) {
  return nodeFetch(`${base}${uri}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Hmac-Sha256': sign(raw,),
      'X-Shopify-Topic': 'orders/create',
      ...headers,
    },
    body: raw,
  },);
}

function eventsFor(platform, store_id,) {
  return platform.store.events.find({ store_id, },);
}

// ── The order payload really has no tenant in it ────────────────────────────

test('an order payload carries no shop field, so the body cannot bind a tenant', () => {
  const keys = Object.keys(ORDER_BODY,);
  for (const field of ['myshopify_domain', 'shop_domain', 'shop', 'domain',]) {
    assert.ok(
      !keys.includes(field,),
      `the fixture must stay realistic — ${field} does not appear in an order payload`,
    );
  }
},);

// ── The property ────────────────────────────────────────────────────────────

test('a captured order body cannot be replayed into another store', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    const raw = JSON.stringify(ORDER_BODY,);

    // The legitimate delivery, for the store the body actually belongs to.
    const first = await postRaw(base, '/webhooks/orders/store_alpha', raw, {
      'X-Shopify-Shop-Domain': 'alpha.myshopify.com',
    },);
    assert.equal(first.status, 200,);
    assert.equal((await eventsFor(platform, 'store_alpha',)).length, 1,);

    // The attack: the identical captured bytes, aimed at another store's path.
    // The header names the VICTIM's own domain, so the header consistency check
    // passes — only the single-use digest can refuse this.
    const replay = await postRaw(base, '/webhooks/orders/store_beta', raw, {
      'X-Shopify-Shop-Domain': 'beta.myshopify.com',
    },);

    assert.equal(replay.status, 409, 'a replayed delivery must be refused',);
    const body = await replay.json();
    assert.equal(body.ok, false,);
    assert.equal(body.error, 'This delivery has already been attributed to a different store.',);

    // The assertion that actually matters: the victim store gained nothing.
    assert.equal((await eventsFor(platform, 'store_beta',)).length, 0,);
    assert.equal((await eventsFor(platform, 'store_alpha',)).length, 1, 'and the owner is unchanged',);
  } finally {
    await close();
  }
},);

test('control: a genuinely different order for that same store is accepted', async () => {
  // Without this, the 409 above could mean "store_beta is refused", which would be
  // a broken endpoint rather than a working guard.
  const { base, platform, close, } = await bootServer();
  try {
    const alphaRaw = JSON.stringify(ORDER_BODY,);
    await postRaw(base, '/webhooks/orders/store_alpha', alphaRaw, {
      'X-Shopify-Shop-Domain': 'alpha.myshopify.com',
    },);

    const otherRaw = JSON.stringify({ ...ORDER_BODY, id: 5002, },);
    const response = await postRaw(base, '/webhooks/orders/store_beta', otherRaw, {
      'X-Shopify-Shop-Domain': 'beta.myshopify.com',
    },);

    assert.equal(response.status, 200,);
    assert.equal((await eventsFor(platform, 'store_beta',)).length, 1,);
  } finally {
    await close();
  }
},);

// ── Idempotency: Shopify retries 8 times over 4 hours ───────────────────────

test('a Shopify retry of the same delivery is not processed twice', async () => {
  // `eventTracker.track` inserts unconditionally, so before this a retried
  // orders/create double-counted the purchase AND decremented stock twice. That is
  // an everyday correctness bug, not an attack.
  const { base, platform, close, } = await bootServer();
  try {
    const raw = JSON.stringify(ORDER_BODY,);
    const headers = { 'X-Shopify-Shop-Domain': 'alpha.myshopify.com', };

    const first = await postRaw(base, '/webhooks/orders/store_alpha', raw, headers,);
    assert.equal(first.status, 200,);
    const firstBody = await first.json();
    assert.equal(firstBody.accepted, true,);

    const retry = await postRaw(base, '/webhooks/orders/store_alpha', raw, headers,);
    assert.equal(retry.status, 200, 'a retry must not be an error — Shopify would keep retrying',);
    assert.equal((await retry.json()).duplicate, true,);

    assert.equal(
      (await eventsFor(platform, 'store_alpha',)).length,
      1,
      'the retry must not create a second purchase event',
    );
  } finally {
    await close();
  }
},);

// ── The checks that still have to hold ─────────────────────────────────────

test('a body whose signature does not verify is still refused at the edge', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    const response = await nodeFetch(`${base}/webhooks/orders/store_alpha`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Shopify-Hmac-Sha256': sign('different-bytes',),
      },
      body: JSON.stringify(ORDER_BODY,),
    },);

    assert.equal(response.status, 401,);
    assert.equal((await eventsFor(platform, 'store_alpha',)).length, 0,);
  } finally {
    await close();
  }
},);

test('a delivery whose header names another store is refused', async () => {
  // The header is not HMAC-covered, so this is a consistency check rather than a
  // security control — but a delivery that contradicts itself must not be ingested.
  const { base, platform, close, } = await bootServer();
  try {
    const raw = JSON.stringify(ORDER_BODY,);
    const response = await postRaw(base, '/webhooks/orders/store_beta', raw, {
      'X-Shopify-Shop-Domain': 'alpha.myshopify.com',
    },);

    assert.equal(response.status, 403,);
    assert.equal((await eventsFor(platform, 'store_beta',)).length, 0,);
  } finally {
    await close();
  }
},);

test('a refused delivery leaves no digest behind for the legitimate one to trip over', async () => {
  // If refusal reserved the digest, the guard would attack itself: the real delivery
  // that follows would be read as a cross-tenant replay and dropped.
  const { base, platform, close, } = await bootServer();
  try {
    const raw = JSON.stringify(ORDER_BODY,);

    const refused = await postRaw(base, '/webhooks/orders/store_beta', raw, {
      'X-Shopify-Shop-Domain': 'alpha.myshopify.com',
    },);
    assert.equal(refused.status, 403,);

    const legit = await postRaw(base, '/webhooks/orders/store_alpha', raw, {
      'X-Shopify-Shop-Domain': 'alpha.myshopify.com',
    },);
    assert.equal(legit.status, 200,);
    assert.equal((await legit.json()).accepted, true,);
    assert.equal((await eventsFor(platform, 'store_alpha',)).length, 1,);
  } finally {
    await close();
  }
},);
