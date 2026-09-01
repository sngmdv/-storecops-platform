'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

/** Boot the app on an ephemeral port and return base URL + closer. */
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

const JSON_HEADERS = { 'Content-Type': 'application/json', };

async function signupTenant(base, email = 'connect@shop.com',) {
  const res = await fetch(`${base}/api/v1/auth/signup`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: 'password123', storeName: 'Connect Shop', },),
  },);
  assert.equal(res.status, 201,);
  return res.json();
}

test('Integrations: snippet + webhook URL are issued per tenant', async () => {
  const { base, close, } = await bootServer();
  try {
    const tenant = await signupTenant(base,);
    const res = await fetch(`${base}/api/v1/integrations/${tenant.store_id}/snippet`, {
      headers: { 'X-API-Key': tenant.api_key, },
    },);
    assert.equal(res.status, 200,);
    const info = await res.json();

    assert.ok(info.snippet.includes(tenant.ingest_key,), 'snippet embeds the tenant\'s write-only ingest key',);
    assert.ok(info.snippet.includes('sendBeacon',), 'snippet uses sendBeacon transport',);
    assert.ok(info.webhook_url.endsWith(`/webhooks/orders/${tenant.store_id}`,),);
    assert.ok(info.csv_format.products.includes('product_id',),);
  } finally {
    await close();
  }
},);

test('Integrations: CSV import feeds inventory + events, webhook flows end-to-end', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    const tenant = await signupTenant(base, 'csv@shop.com',);
    const keyed = { ...JSON_HEADERS, 'X-API-Key': tenant.api_key, };

    // 1. Products CSV → inventory ledger.
    const prodRes = await fetch(`${base}/api/v1/integrations/${tenant.store_id}/csv`, {
      method: 'POST',
      headers: keyed,
      body: JSON.stringify({
        type: 'products',
        csv: 'product_id,name,stock,lead_time_days,price\nSKU-1,"Widget, deluxe",12,5,19.99\nSKU-2,Gadget,3,7,49',
      },),
    },);
    assert.equal(prodRes.status, 200,);
    const prodBody = await prodRes.json();
    assert.equal(prodBody.imported, 2,);

    const rows = await platform.store.inventory.find({ store_id: tenant.store_id, },);
    assert.equal(rows.length, 2,);
    const widget = rows.find((r,) => r.product_id === 'SKU-1',);
    assert.equal(widget.stock, 12,);

    // 2. Orders CSV → purchase events.
    const orderRes = await fetch(`${base}/api/v1/integrations/${tenant.store_id}/csv`, {
      method: 'POST',
      headers: keyed,
      body: JSON.stringify({
        type: 'orders',
        csv: 'customer_id,email,total,product_id,quantity,timestamp\nc1,buyer@x.com,19.99,SKU-1,1,2026-08-14T10:00:00Z',
      },),
    },);
    assert.equal(orderRes.status, 200,);
    const orderBody = await orderRes.json();
    assert.equal(orderBody.imported, 1,);
    assert.equal(orderBody.rejected, 0,);

    // 3. Shopify-style order webhook → purchase tracked + connection flowing.
    const hookRes = await fetch(`${base}/webhooks/orders/${tenant.store_id}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        order_id: 5001,
        email: 'hook@buyer.com',
        total_price: '49.00',
        line_items: [{ sku: 'SKU-2', quantity: 1, price: '49.00', },],
      },),
    },);
    assert.equal(hookRes.status, 200,);
    const hookBody = await hookRes.json();
    assert.equal(hookBody.accepted, true,);
    assert.equal(hookBody.total, 49,);

    // Stock decremented downstream for the webhook order.
    const gadget = (await platform.store.inventory.find({ store_id: tenant.store_id, },))
      .find((r,) => r.product_id === 'SKU-2',);
    assert.equal(gadget.stock, 2,);

    // 4. Connection status reflects activity.
    const statusRes = await fetch(`${base}/api/v1/integrations/${tenant.store_id}`, {
      headers: { 'X-API-Key': tenant.api_key, },
    },);
    const status = await statusRes.json();
    assert.equal(status.connected, true,);
    assert.equal(status.status, 'flowing',);
    assert.ok(status.events_received >= 2,);
    assert.ok(status.last_event_at,);
  } finally {
    await close();
  }
},);

test('Integrations: write-only ingest key is locked to /track', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    const tenant = await signupTenant(base, 'ingest@shop.com',);

    // Flip off the test-environment auth bypass to exercise the real gateway.
    platform.config.env = 'production';

    // Ingest key can post events…
    const track = await fetch(`${base}/api/v1/track?api_key=${tenant.ingest_key}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        store_id: tenant.store_id,
        event_type: 'purchase',
        customer_id: 'c-snippet',
        email: 'snippet@buyer.com',
        total: 12.5,
      },),
    },);
    assert.equal(track.status, 200,);
    assert.equal((await track.json()).accepted, true,);

    // …but cannot read anything.
    const read = await fetch(`${base}/api/v1/report/${tenant.store_id}`, {
      headers: { 'X-API-Key': tenant.ingest_key, },
    },);
    assert.equal(read.status, 403,);

    // No credentials → 401.
    const anon = await fetch(`${base}/api/v1/report/${tenant.store_id}`,);
    assert.equal(anon.status, 401,);

    // Tenant key still works normally.
    const ok = await fetch(`${base}/api/v1/report/${tenant.store_id}`, {
      headers: { 'X-API-Key': tenant.api_key, },
    },);
    assert.equal(ok.status, 200,);

    platform.config.env = 'test';
  } finally {
    platform.config.env = 'test';
    await close();
  }
},);
