'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

const STORE = 'store_live';

test('inventory ledger: purchases automatically decrement stock', async () => {
  const platform = createPlatform();

  await platform.inventoryLedger.setStock({ store_id: STORE, product_id: 'sku_1', stock: 10, },);
  await platform.inventoryLedger.setStock({ store_id: STORE, product_id: 'sku_2', stock: 5, },);

  await platform.eventTracker.track({
    event_type: 'purchase',
    store_id: STORE,
    customer_id: 'buyer1',
    total: 90,
    items: [
      { product_id: 'sku_1', quantity: 2, price: 30, },
      { product_id: 'sku_2', quantity: 1, price: 30, },
    ],
  },);

  const levels = await platform.inventoryLedger.levels(STORE,);
  const sku1 = levels.find((l,) => l.product_id === 'sku_1',);
  const sku2 = levels.find((l,) => l.product_id === 'sku_2',);

  assert.equal(sku1.stock, 8,);
  assert.equal(sku2.stock, 4,);
},);

test('inventory ledger: oversells clamp at zero and are flagged', async () => {
  const platform = createPlatform();

  await platform.inventoryLedger.setStock({ store_id: STORE, product_id: 'rare', stock: 1, },);

  await platform.eventTracker.track({
    event_type: 'purchase',
    store_id: STORE,
    customer_id: 'greedy',
    items: [{ product_id: 'rare', quantity: 5, },],
  },);

  const entry = await platform.inventoryLedger.get(STORE, 'rare',);
  assert.equal(entry.stock, 0,);
  assert.equal(entry.oversold, 4,);
},);

test('live orders: feed shows who bought what, newest first', async () => {
  const platform = createPlatform();

  await platform.eventTracker.track({
    event_type: 'purchase',
    store_id: STORE,
    customer_id: 'alice',
    total: 100,
    items: [{ product_id: 'sku_a', quantity: 1, price: 100, },],
    timestamp: new Date(Date.now() - 60 * 60 * 1000,).toISOString(), // 1h ago
  },);
  await platform.eventTracker.track({
    event_type: 'purchase',
    store_id: STORE,
    email: 'bob@example.com',
    total: 60,
    items: [{ product_id: 'sku_b', quantity: 2, price: 30, },],
  },);

  const feed = await platform.liveOrders.recent(STORE,);
  assert.equal(feed.count, 2,);
  assert.equal(feed.orders[0].customer, 'bob@example.com',);
  assert.equal(feed.orders[0].items[0].quantity, 2,);
  assert.equal(feed.orders[1].customer, 'alice',);
  assert.ok(feed.orders[0].time_ago,);

  // Per-customer purchase history.
  const bobs = await platform.liveOrders.customerPurchases(STORE, 'bob@example.com',);
  assert.equal(bobs.total_orders, 1,);
  assert.equal(bobs.total_spent, 60,);
},);

test('product insights: fast movers, slow movers, dead stock and urgent restocks', async () => {
  const platform = createPlatform();

  // Stock setup: "hot" holds far less than the test will sell, so it
  // runs out mid-stream — the OUT_OF_STOCK alert is exactly what the
  // owner needs to see.
  await platform.inventoryLedger.setStockBatch(STORE, [
    { product_id: 'hot', stock: 4, lead_time_days: 7, },
    { product_id: 'steady', stock: 500, lead_time_days: 7, }, // sells fast, plenty
    { product_id: 'slow', stock: 40, lead_time_days: 7, },
    { product_id: 'dead', stock: 25, lead_time_days: 7, }, // zero sales
  ],);

  // "hot" and "steady": 50 units each over recent days (≈1.67/day,
  // above the fast-mover threshold).
  for (let i = 0; i < 50; i++) {
    await platform.eventTracker.track({
      event_type: 'purchase',
      store_id: STORE,
      customer_id: `c${i}`,
      items: [
        { product_id: 'hot', quantity: 1, price: 10, },
        { product_id: 'steady', quantity: 1, price: 20, },
      ],
    },);
  }
  // "slow": a single sale.
  await platform.eventTracker.track({
    event_type: 'purchase',
    store_id: STORE,
    customer_id: 'one',
    items: [{ product_id: 'slow', quantity: 1, price: 15, },],
  },);

  const insights = await platform.productInsights.analyze(STORE, 30,);

  // hot: 50 units / 30d ≈ 1.67/day but only 4 were in stock → sold out.
  const hot = insights.restock_urgent.find((r,) => r.product_id === 'hot',);
  assert.ok(hot, 'hot product flagged for urgent restock',);
  assert.equal(hot.severity, 'OUT_OF_STOCK',);
  assert.ok(hot.suggested_qty > 0,);
  assert.match(hot.suggestion, /order .* units immediately/i,);

  // steady: same velocity but 500 in stock → fast mover, not restock.
  const steady = insights.fast_movers.find((f,) => f.product_id === 'steady',);
  assert.ok(steady, 'steady product recognized as fast mover',);
  assert.equal(steady.revenue, 1000,);

  // slow: below slow threshold, one sale.
  const slow = insights.slow_movers.find((s,) => s.product_id === 'slow',);
  assert.ok(slow, 'slow product flagged',);

  // dead: stock but zero sales.
  const dead = insights.dead_stock.find((d,) => d.product_id === 'dead',);
  assert.ok(dead, 'dead stock flagged',);
  assert.match(dead.suggestion, /clearance/i,);

  assert.equal(insights.summary.needs_restock, 1,);
},);

test('SSE: live stream pushes purchases to subscribers in real time', async () => {
  const platform = createPlatform();
  const app = createApp(platform,);

  const server = await new Promise((resolve,) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s,),);
  },);
  const { port, } = server.address();

  try {
    // Subscribe to the stream.
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/live/${STORE}`, {
      signal: controller.signal,
    },);
    assert.equal(response.status, 200,);
    assert.match(response.headers.get('content-type',), /text\/event-stream/,);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const readUntil = async (marker, timeoutMs = 3000,) => {
      const deadline = Date.now() + timeoutMs;
      while (!buffer.includes(marker,)) {
        if (Date.now() > deadline) throw new Error(`Timeout waiting for "${marker}"`,);
        const { value, done, } = await reader.read();
        if (done) throw new Error('Stream closed early',);
        buffer += decoder.decode(value, { stream: true, },);
      }
    };

    await readUntil('event: connected',);

    // Now a sale lands — the stream must carry it.
    await platform.eventTracker.track({
      event_type: 'purchase',
      store_id: STORE,
      customer_id: 'live_buyer',
      total: 42,
      items: [{ product_id: 'sku_live', quantity: 1, },],
    },);

    await readUntil('event: purchase',);
    assert.match(buffer, /live_buyer/,);
    assert.match(buffer, /sku_live/,);

    controller.abort();
  } finally {
    await new Promise((done,) => server.close(done,),);
  }
},);

test('API: live order, stock and insight endpoints respond over HTTP', async () => {
  const platform = createPlatform();
  const app = createApp(platform,);

  const server = await new Promise((resolve,) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s,),);
  },);
  const { port, } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const post = (path, body,) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', },
        body: JSON.stringify(body,),
      },);

    // Seed stock, then a purchase.
    await post(`/api/v1/inventory/${STORE}/stock`, { product_id: 'p1', stock: 10, },);
    await post('/api/v1/track', {
      event_type: 'purchase',
      store_id: STORE,
      customer_id: 'web_buyer',
      total: 200,
      items: [{ product_id: 'p1', quantity: 8, price: 25, },],
    },);

    const orders = await (await fetch(`${base}/api/v1/orders/${STORE}/live`,)).json();
    assert.equal(orders.count, 1,);
    assert.equal(orders.orders[0].customer, 'web_buyer',);

    const levels = await (await fetch(`${base}/api/v1/inventory/${STORE}/levels`,)).json();
    assert.equal(levels.find((l,) => l.product_id === 'p1',).stock, 2,);

    const insights = await (await fetch(`${base}/api/v1/insights/${STORE}/products`,)).json();
    assert.ok(insights.summary,);
    assert.ok(insights.restock_urgent.some((r,) => r.product_id === 'p1',), 'low stock after sale flagged',);
  } finally {
    await new Promise((done,) => server.close(done,),);
  }
},);
