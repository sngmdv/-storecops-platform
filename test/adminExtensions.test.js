'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

/** Boot the app on an ephemeral port. */
async function boot() {
  const platform = createPlatform();
  const app = createApp(platform,);
  const server = await new Promise((resolve,) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s,),);
  },);
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    platform,
    close: () => new Promise((done,) => server.close(done,),),
  };
}

/** Sign up a tenant and return its id, API key and auth headers. */
async function makeTenant(platform, email, storeName,) {
  const created = await platform.auth.signup({
    email,
    password: 'p2-fixture-passphrase-9f3a2b',
    storeName,
  },);
  return {
    store_id: created.store_id,
    headers: { 'X-API-Key': created.api_key, 'Content-Type': 'application/json', },
  };
}

/** Seed a customer profile directly. */
async function seedCustomer(platform, store_id, overrides = {},) {
  return platform.store.customers.insert({
    store_id,
    identity: 'cust_1',
    email: 'shopper@example.com',
    phone: '+15550001111',
    purchases: 3,
    abandoned_carts: 2,
    total_spent: 420,
    last_purchase_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000,).toISOString(),
    ...overrides,
  },);
}

test('ext: customer insights returns churn risk, LTV and win-back eligibility', async () => {
  const { base, platform, close, } = await boot();
  try {
    const tenant = await makeTenant(platform, 'insights@example.com', 'Insights Co',);
    await seedCustomer(platform, tenant.store_id,);

    const res = await fetch(`${base}/api/v1/ext/customer/${tenant.store_id}/cust_1/insights`, { headers: tenant.headers, },);
    assert.strictEqual(res.status, 200,);
    const body = await res.json();

    assert.strictEqual(body.found, true,);
    assert.strictEqual(body.customer_id, 'cust_1',);
    assert.ok(typeof body.churn_score === 'number',);
    assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL',].includes(body.risk_band,),);
    assert.strictEqual(body.lifetime_value, 420,);
    assert.strictEqual(body.purchases, 3,);
    assert.strictEqual(body.days_since_purchase, 60,);
    assert.strictEqual(body.winback_eligible, true, 'reachable + stale + at-risk',);
  } finally {
    await close();
  }
},);

test('ext: customer insights reports not-found for an unknown customer', async () => {
  const { base, platform, close, } = await boot();
  try {
    const tenant = await makeTenant(platform, 'missing@example.com', 'Missing Co',);
    const res = await fetch(`${base}/api/v1/ext/customer/${tenant.store_id}/ghost/insights`, { headers: tenant.headers, },);
    const body = await res.json();
    assert.strictEqual(res.status, 200,);
    assert.strictEqual(body.found, false,);
  } finally {
    await close();
  }
},);

test('ext: product insights projects stockout and recommends a reorder', async () => {
  const { base, platform, close, } = await boot();
  try {
    const tenant = await makeTenant(platform, 'product@example.com', 'Product Co',);
    const { store_id, } = tenant;

    await platform.inventoryLedger.setStock({
      store_id,
      product_id: 'sku_1',
      stock: 3,
      lead_time_days: 7,
      name: 'Running Shoe',
    },);

    // 30 units sold over the last 30 days => 1 unit/day.
    for (let i = 0; i < 30; i += 1) {
      await platform.store.events.insert({
        store_id,
        event_type: 'purchase',
        customer_id: 'cust_1',
        items: [{ product_id: 'sku_1', quantity: 1, },],
        timestamp: new Date(Date.now() - i * 60 * 60 * 1000,).toISOString(),
      },);
    }

    const res = await fetch(`${base}/api/v1/ext/product/${store_id}/sku_1/insights`, { headers: tenant.headers, },);
    assert.strictEqual(res.status, 200,);
    const body = await res.json();

    assert.strictEqual(body.found, true,);
    assert.strictEqual(body.units_sold, 30,);
    assert.strictEqual(body.units_per_day, 1,);
    assert.strictEqual(body.stock_on_hand, 3,);
    assert.strictEqual(body.days_until_stockout, 3,);
    assert.strictEqual(body.status, 'STOCKOUT_RISK', '3 days cover vs 7 day lead time',);
    assert.strictEqual(body.suggested_reorder_qty, 11,);
    assert.strictEqual(body.has_competitor_data, false,);
  } finally {
    await close();
  }
},);

test('ext: win-back sends to a reachable customer and reports delivery', async () => {
  const { base, platform, close, } = await boot();
  try {
    const tenant = await makeTenant(platform, 'winback@example.com', 'Winback Co',);
    await seedCustomer(platform, tenant.store_id,);

    const res = await fetch(`${base}/api/v1/ext/customer/${tenant.store_id}/cust_1/winback`, {
      method: 'POST',
      headers: tenant.headers,
      body: JSON.stringify({ channel: 'email', offer: '15% off your next order', },),
    },);
    assert.strictEqual(res.status, 200,);
    const body = await res.json();

    assert.strictEqual(body.ok, true,);
    assert.strictEqual(body.status, 'delivered',);
    assert.strictEqual(body.channel, 'email',);
    assert.ok(body.action_id,);

    // A delivery record was written for the merchant's own store.
    const deliveries = await platform.store.deliveries.find({ store_id: tenant.store_id, },);
    assert.strictEqual(deliveries.length, 1,);
  } finally {
    await close();
  }
},);

test('ext: win-back refuses a channel the customer cannot receive', async () => {
  const { base, platform, close, } = await boot();
  try {
    const tenant = await makeTenant(platform, 'noemail@example.com', 'NoEmail Co',);
    await seedCustomer(platform, tenant.store_id, { email: '', phone: '', },);

    const res = await fetch(`${base}/api/v1/ext/customer/${tenant.store_id}/cust_1/winback`, {
      method: 'POST',
      headers: tenant.headers,
      body: JSON.stringify({ channel: 'email', },),
    },);
    assert.strictEqual(res.status, 400,);
    const body = await res.json();
    assert.match(body.error, /no email/i,);
  } finally {
    await close();
  }
},);

test('ext: win-back does not spam — a second send within 24h is skipped', async () => {
  const { base, platform, close, } = await boot();
  try {
    const tenant = await makeTenant(platform, 'dedupe@example.com', 'Dedupe Co',);
    await seedCustomer(platform, tenant.store_id,);

    const send = () => fetch(`${base}/api/v1/ext/customer/${tenant.store_id}/cust_1/winback`, {
      method: 'POST',
      headers: tenant.headers,
      body: JSON.stringify({ channel: 'email', },),
    },);

    const first = await (await send()).json();
    assert.strictEqual(first.ok, true,);

    const second = await (await send()).json();
    assert.strictEqual(second.ok, false,);
    assert.strictEqual(second.skipped, true,);
    assert.match(second.reason, /already sent/i,);
  } finally {
    await close();
  }
},);

test('ext: win-back dry run previews without sending', async () => {
  const { base, platform, close, } = await boot();
  try {
    const tenant = await makeTenant(platform, 'dry@example.com', 'Dry Co',);
    await seedCustomer(platform, tenant.store_id,);

    const res = await fetch(`${base}/api/v1/ext/customer/${tenant.store_id}/cust_1/winback`, {
      method: 'POST',
      headers: tenant.headers,
      body: JSON.stringify({ channel: 'email', dry_run: true, },),
    },);
    const body = await res.json();

    assert.strictEqual(body.dry_run, true,);
    assert.ok(body.would_send,);
    const deliveries = await platform.store.deliveries.find({ store_id: tenant.store_id, },);
    assert.strictEqual(deliveries.length, 0, 'nothing actually sent',);
  } finally {
    await close();
  }
},);

test('ext: customer export returns JSON and CSV', async () => {
  const { base, platform, close, } = await boot();
  try {
    const tenant = await makeTenant(platform, 'export@example.com', 'Export Co',);
    await seedCustomer(platform, tenant.store_id,);
    await seedCustomer(platform, tenant.store_id, { identity: 'cust_2', email: 'two@example.com', total_spent: 80, },);

    const jsonRes = await fetch(`${base}/api/v1/ext/customers/${tenant.store_id}/export`, {
      method: 'POST',
      headers: tenant.headers,
      body: JSON.stringify({ format: 'json', },),
    },);
    const jsonBody = await jsonRes.json();
    assert.strictEqual(jsonBody.ok, true,);
    assert.strictEqual(jsonBody.count, 2,);
    assert.strictEqual(jsonBody.customers.length, 2,);

    const csvRes = await fetch(`${base}/api/v1/ext/customers/${tenant.store_id}/export`, {
      method: 'POST',
      headers: tenant.headers,
      body: JSON.stringify({ format: 'csv', },),
    },);
    const csvBody = await csvRes.json();
    assert.strictEqual(csvBody.format, 'csv',);
    assert.match(csvBody.content, /^customer_id,email,phone/,);
    assert.match(csvBody.content, /shopper@example\.com/,);
    // Header + 2 rows.
    assert.strictEqual(csvBody.content.trim().split('\n',).length, 3,);
  } finally {
    await close();
  }
},);

test('ext: one tenant cannot read another tenant\'s customer insights', async () => {
  const { base, platform, close, } = await boot();
  try {
    const victim = await makeTenant(platform, 'victim@example.com', 'Victim Co',);
    const attacker = await makeTenant(platform, 'attacker@example.com', 'Attacker Co',);
    await seedCustomer(platform, victim.store_id, { email: 'private@example.com', },);

    const res = await fetch(`${base}/api/v1/ext/customer/${victim.store_id}/cust_1/insights`, {
      headers: attacker.headers,
    },);
    assert.strictEqual(res.status, 403,);

    const body = await res.json();
    assert.ok(!JSON.stringify(body,).includes('private@example.com',), 'no victim data leaked',);
  } finally {
    await close();
  }
},);

test('ext: unauthenticated requests are rejected', async () => {
  const { base, platform, close, } = await boot();
  try {
    const tenant = await makeTenant(platform, 'unauth@example.com', 'Unauth Co',);
    await seedCustomer(platform, tenant.store_id,);

    // No credentials at all. In test env the gateway permits anonymous
    // traffic, so assert the RBAC/tenant gate still blocks the data.
    const res = await fetch(`${base}/api/v1/ext/customer/${tenant.store_id}/cust_1/insights`,);
    assert.ok([401, 403,].includes(res.status,), `expected rejection, got ${res.status}`,);
  } finally {
    await close();
  }
},);

// ── Shop-scoped routes: the path the Admin UI Extensions actually use ──

const crypto = require('node:crypto',);
const CLIENT_ID = 'ext-client-id-abcdef123456';
const CLIENT_SECRET = 'ext-client-secret-zyxwvu987654';
const SHOP = 'storecops-ext.myshopify.com';

/** Mint a Shopify-shaped session token for SHOP. */
function mintSessionToken() {
  const b64 = (o,) => Buffer.from(JSON.stringify(o,),).toString('base64url',);
  const now = Math.floor(Date.now() / 1000,);
  const head = b64({ alg: 'HS256', typ: 'JWT', },);
  const body = b64({
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: CLIENT_ID,
    sub: '7',
    exp: now + 60,
    nbf: now - 5,
  },);
  const sig = crypto.createHmac('sha256', CLIENT_SECRET,).update(`${head}.${body}`,).digest('base64url',);
  return `${head}.${body}.${sig}`;
}

/** Boot a platform whose tenant owns SHOP, and return session-token headers. */
async function bootEmbedded() {
  process.env.SHOPIFY_CLIENT_ID = CLIENT_ID;
  process.env.SHOPIFY_CLIENT_SECRET = CLIENT_SECRET;
  const booted = await boot();
  const tenant = await makeTenant(booted.platform, 'embedded@example.com', 'Embedded Co',);
  await booted.platform.store.integrations.insert({
    store_id: tenant.store_id,
    type: 'shopify',
    status: 'active',
    config: { shopDomain: SHOP, tokenEncrypted: 'x', },
  },);
  return {
    ...booted,
    store_id: tenant.store_id,
    headers: { Authorization: `Bearer ${mintSessionToken()}`, 'Content-Type': 'application/json', },
  };
}

test('ext/shop: session token resolves the tenant without an explicit store_id', async () => {
  const { base, headers, store_id, close, } = await bootEmbedded();
  try {
    const res = await fetch(`${base}/api/v1/ext/shop/me`, { headers, },);
    assert.strictEqual(res.status, 200,);
    const body = await res.json();
    assert.strictEqual(body.store_id, store_id,);
    assert.strictEqual(body.shop_domain, SHOP,);
    assert.strictEqual(body.authenticated_via, 'session_token',);
  } finally {
    await close();
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
  }
},);

test('ext/shop: a Shopify GID resolves to our internal customer profile', async () => {
  const { base, headers, store_id, platform, close, } = await bootEmbedded();
  try {
    // Internal identity is the bare numeric id, as written by the
    // Shopify order webhook.
    await platform.store.customers.insert({
      store_id,
      identity: '7123456789',
      email: 'gid@example.com',
      purchases: 4,
      total_spent: 900,
      last_purchase_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000,).toISOString(),
    },);

    const gid = encodeURIComponent('gid://shopify/Customer/7123456789',);
    const res = await fetch(`${base}/api/v1/ext/shop/customer/${gid}/insights`, { headers, },);
    assert.strictEqual(res.status, 200,);
    const body = await res.json();

    assert.strictEqual(body.found, true,);
    assert.strictEqual(body.customer_id, '7123456789',);
    assert.strictEqual(body.lifetime_value, 900,);
    assert.strictEqual(body.winback_eligible, true,);
  } finally {
    await close();
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
  }
},);

test('ext/shop: a forged session token cannot reach the shop routes', async () => {
  const { base, close, } = await bootEmbedded();
  try {
    const res = await fetch(`${base}/api/v1/ext/shop/me`, {
      headers: { Authorization: 'Bearer not.a.real.token', },
    },);
    assert.ok([401, 403,].includes(res.status,), `expected rejection, got ${res.status}`,);
  } finally {
    await close();
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
  }
},);

test('ext/shop: an API-key caller resolves to its own store, never another', async () => {
  const { base, platform, close, } = await boot();
  try {
    const tenant = await makeTenant(platform, 'apikey@example.com', 'ApiKey Co',);
    const res = await fetch(`${base}/api/v1/ext/shop/me`, { headers: tenant.headers, },);
    assert.strictEqual(res.status, 200,);
    const body = await res.json();
    assert.strictEqual(body.store_id, tenant.store_id,);
    assert.strictEqual(body.authenticated_via, 'api_key',);
  } finally {
    await close();
  }
},);
