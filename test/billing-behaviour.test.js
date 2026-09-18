'use strict';

process.env.NODE_ENV = 'test';
// PAY-001/002 regression (audit item TEST-001): billing endpoints must call the
// REAL billing/competitor services and report truthfully — never fake
// `{success:true}` and never invent invoices, usage, or competitor prices.
// Use a known master key so /api/v1 routes authenticate without tenant setup.
process.env.API_KEY = 'test-master-key';

const test = require('node:test',);
const assert = require('node:assert',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

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

const apiCall = (base, method, path, body,) => {
  const headers = { 'X-API-Key': process.env.API_KEY, };
  const init = { method, headers, };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body,);
  }
  return fetch(`${base}${path}`, init,);
};

// Minimal manual spy — replaces a method, records calls, returns a canned
// value, and restores the original. No external test framework needed.
function spyOn(obj, method, impl,) {
  const original = obj[method];
  const calls = [];
  obj[method] = (...args) => { calls.push(args,); return impl(...args,); };
  return { calls, restore: () => { obj[method] = original; }, };
}

test('PAY-001: upgrade without a Shopify connection returns an honest error (no fake success)', async () => {
  const { base, close, } = await bootServer();
  try {
    const res = await apiCall(base, 'POST', '/api/v1/billing/store_x/upgrade', {},);
    // The original defect returned { success: true } while doing nothing.
    assert.equal(res.status, 400, 'must NOT silently report success',);
    const body = await res.json();
    assert.match(body.error, /No Shopify connection found/, 'error should explain the real cause',);
  } finally {
    await close();
  }
},);

test('PAY-001: upgrade with a stored connection calls the real billingService.createShopifyCharge', async () => {
  const { base, platform, close, } = await bootServer();
  const spy = spyOn(
    platform.billingService,
    'createShopifyCharge',
    (shop, token, plan, opts,) => ({ chargeId: 'ch_1', shop, token, plan, opts, }),
  );
  try {
    await platform.store.integrations.insert({
      type: 'shopify',
      store_id: 'store_up',
      status: 'connected',
      config: { shop_domain: 'my-shop.myshopify.com', access_token: 'tok_abc', },
    },);

    const res = await apiCall(base, 'POST', '/api/v1/billing/store_up/upgrade', {},);
    assert.equal(res.status, 200, 'real charge creation should succeed',);
    const body = await res.json();
    assert.equal(body.chargeId, 'ch_1', 'response must come from the real service, not a stub',);

    assert.equal(spy.calls.length, 1, 'billingService.createShopifyCharge must be invoked',);
    const [shop, token, plan, opts,] = spy.calls[0];
    assert.equal(shop, 'my-shop.myshopify.com', 'should resolve shop_domain from the stored connection',);
    assert.equal(token, 'tok_abc', 'should resolve access_token from the stored connection',);
    assert.equal(plan, 'growth', 'should default to the growth plan',);
    assert.equal(opts.shopInstallationId, 'store_up', 'should scope the charge to the store',);
  } finally {
    spy.restore();
    await close();
  }
},);

test('PAY-001: cancel routes through billingService.handleSubscriptionEvent with action "cancelled"', async () => {
  const { base, platform, close, } = await bootServer();
  const spy = spyOn(
    platform.billingService,
    'handleSubscriptionEvent',
    (evt,) => ({ ok: true, evt, }),
  );
  try {
    const res = await apiCall(base, 'POST', '/api/v1/billing/store_c/cancel', {},);
    assert.equal(res.status, 200, 'real cancellation should succeed',);
    const body = await res.json();
    assert.equal(body.ok, true,);

    assert.equal(spy.calls.length, 1, 'billingService.handleSubscriptionEvent must be invoked',);
    assert.equal(spy.calls[0][0].shopInstallationId, 'store_c',);
    assert.equal(spy.calls[0][0].action, 'cancelled', 'cancel must dispatch a "cancelled" event',);
  } finally {
    spy.restore();
    await close();
  }
},);

test('PAY-002: invoices returns real, store-scoped subscriptions (not hardcoded data)', async () => {
  const { base, platform, close, } = await bootServer();
  const spy = spyOn(platform.billingService, 'listSubscriptions', () => [
    { _id: 'sub_1', shopInstallationId: 'store_i', planId: 'growth', status: 'active', currency: 'usd', price_monthly: 49, started_at: '2026-01-01', current_period_end: '2026-02-01', },
    { _id: 'sub_2', shopInstallationId: 'other', planId: 'scale', status: 'active', },
  ],);
  try {
    const res = await apiCall(base, 'GET', '/api/v1/billing/store_i/invoices',);
    assert.equal(res.status, 200,);
    const body = await res.json();

    assert.equal(spy.calls.length, 1, 'billingService.listSubscriptions must be invoked',);
    assert.equal(body.invoices.length, 1, 'only this store\'s subscriptions should be returned',);
    assert.equal(body.invoices[0].id, 'sub_1',);
    assert.equal(body.invoices[0].plan, 'growth',);
    assert.equal(body.invoices[0].price_monthly, 49,);
  } finally {
    spy.restore();
    await close();
  }
},);

test('PAY-002: price-history returns real competitor snapshots (not invented prices)', async () => {
  const { base, platform, close, } = await bootServer();
  const spy = spyOn(platform.competitorIngestor, 'latestSnapshots', () => [
    { competitor: 'RivalA', product: 'Widget', price: 19.99, captured_at: '2026-09-01', },
    { competitor: 'RivalB', product: 'Gadget', price: 29.99, captured_at: '2026-09-02', },
  ],);
  try {
    const res = await apiCall(base, 'GET', '/api/v1/competitors/store_p/price-history',);
    assert.equal(res.status, 200,);
    const body = await res.json();

    assert.equal(spy.calls.length, 1, 'competitorIngestor.latestSnapshots must be invoked',);
    assert.equal(spy.calls[0][0], 'store_p',);
    assert.equal(body.history.length, 2, 'real snapshot data must be returned',);
    assert.equal(body.history[0].competitor, 'RivalA',);
    assert.equal(body.history[1].price, 29.99,);
  } finally {
    spy.restore();
    await close();
  }
},);
