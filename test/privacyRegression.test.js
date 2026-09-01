'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);
const { deleteCustomerData, exportCustomerData, } = require('../src/server/security',);

const STORE = 'store_privacy';

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

test('privacy regression: deleteCustomerData anonymizes profile and scrubs all identifiers', async () => {
  const platform = createPlatform();

  // Seed a customer with events, deliveries, and actions.
  await platform.store.customers.insert({
    store_id: STORE,
    identity: 'cust_privacy_1',
    email: 'privacy@test.com',
    viewed_products: ['p1', 'p2',],
    channels_responded: ['email',],
  },);
  await platform.store.events.insert({
    store_id: STORE,
    event_type: 'product_view',
    customer_id: 'cust_privacy_1',
    email: 'privacy@test.com',
    product_id: 'p1',
    timestamp: new Date().toISOString(),
  },);
  await platform.store.deliveries.insert({
    store_id: STORE,
    customer_id: 'cust_privacy_1',
    channel: 'email',
    status: 'delivered',
    created_at: new Date().toISOString(),
  },);
  await platform.store.actions.insert({
    store_id: STORE,
    customer_id: 'cust_privacy_1',
    rule_id: 'cart_recovery',
    channel: 'email',
    status: 'queued',
  },);

  // Run the deletion.
  const result = await deleteCustomerData(platform, STORE, 'cust_privacy_1',);

  assert.equal(result.anonymized, true, 'profile should be anonymized',);
  assert.ok(result.events_scrubbed >= 1, 'events should be scrubbed',);
  assert.ok(result.deliveries_scrubbed >= 1, 'deliveries should be scrubbed',);
  assert.ok(result.actions_scrubbed >= 1, 'actions should be scrubbed',);

  // Verify the profile is anonymized.
  const anonProfile = await platform.store.customers.findOne({
    identity: 'anon:' + (await platform.store.customers.findOne({ store_id: STORE, email: null, },))?._id,
  },);
  // The original identity should no longer exist.
  const original = await platform.store.customers.findOne({
    identity: 'cust_privacy_1',
  },);
  assert.equal(original, null, 'original identity must be gone',);

  // Verify events are scrubbed.
  const events = await platform.store.events.find({
    store_id: STORE,
    customer_id: 'cust_privacy_1',
  },);
  assert.equal(events.length, 0, 'no events should retain the original customer_id',);
},);

test('privacy regression: exportCustomerData returns all held data', async () => {
  const platform = createPlatform();

  // Seed a customer with data across collections.
  await platform.store.customers.insert({
    store_id: STORE,
    identity: 'cust_export_1',
    email: 'export@test.com',
  },);
  await platform.store.events.insert({
    store_id: STORE,
    event_type: 'cart_abandoned',
    customer_id: 'cust_export_1',
    timestamp: new Date().toISOString(),
  },);
  await platform.store.deliveries.insert({
    store_id: STORE,
    customer_id: 'cust_export_1',
    channel: 'email',
    status: 'delivered',
    created_at: new Date().toISOString(),
  },);

  const exported = await exportCustomerData(platform, STORE, 'cust_export_1',);

  assert.equal(exported.store_id, STORE,);
  assert.equal(exported.customer_id, 'cust_export_1',);
  assert.ok(exported.profile, 'profile should be exported',);
  assert.ok(exported.events.length >= 1, 'events should be exported',);
  assert.ok(exported.deliveries.length >= 1, 'deliveries should be exported',);
  assert.ok(exported.total_records >= 3, 'total records should include all collections',);
  assert.ok(exported.exported_at, 'export timestamp should be present',);
},);

test('privacy regression: customer-redact webhook triggers data deletion', async () => {
  const { base, platform, close, } = await bootServer();

  try {
    // Seed an integration so the webhook handler iterates over stores.
    await platform.store.integrations.insert({
      type: 'shopify',
      store_id: 'store_api',
      status: 'connected',
    },);

    // Seed a customer.
    await platform.store.customers.insert({
      store_id: 'store_api',
      identity: 'webhook_cust',
      email: 'webhook@test.com',
    },);
    await platform.store.events.insert({
      store_id: 'store_api',
      event_type: 'product_view',
      customer_id: 'webhook_cust',
      timestamp: new Date().toISOString(),
    },);

    // Fire the customer-redact webhook.
    const res = await fetch(`${base}/webhooks/shopify/customer-redact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify({ customer: { id: 'webhook_cust', }, },),
    },);
    assert.equal(res.status, 200,);

    // Verify the customer was anonymized.
    const original = await platform.store.customers.findOne({
      identity: 'webhook_cust',
    },);
    assert.equal(original, null, 'original customer identity must be removed after redact',);
  } finally {
    await close();
  }
},);

test('privacy regression: deleteCustomerData is idempotent', async () => {
  const platform = createPlatform();

  // Seed a customer.
  await platform.store.customers.insert({
    store_id: STORE,
    identity: 'cust_idem',
    email: 'idem@test.com',
  },);

  // First deletion.
  const first = await deleteCustomerData(platform, STORE, 'cust_idem',);
  assert.equal(first.anonymized, true,);

  // Second deletion — should not error, just report nothing to anonymize.
  const second = await deleteCustomerData(platform, STORE, 'cust_idem',);
  assert.equal(second.anonymized, false, 'second deletion should find nothing to anonymize',);
},);
