'use strict';

/**
 * Shopify Admin GraphQL migration (P5-32).
 *
 * New public Shopify apps must use the GraphQL Admin API exclusively — the
 * REST Admin API is legacy since 2024-10-01 and closed to new public apps
 * since 2025-04-01. With the billing decision made (Shopify Billing), every
 * Admin call in the repo goes through `src/server/shopifyAdmin.js`:
 * billing subscriptions, catalogue/order/customer sync, webhook registration.
 *
 * The storefront `/products.json` hits in competitorScraper/deepAudit are
 * public unauthenticated endpoints, NOT the Admin API — they stay.
 *
 * Each suite below pins behaviour, not implementation: the sync tests feed
 * GraphQL-shaped fixtures through the real platform pipeline (ledger, event
 * tracker, profiles) and assert the same records the old transport produced.
 * The last suite is a source scan proving no Admin REST literal survived in
 * the two migrated files — the migration cannot silently regress.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);

const {
  createShopifyAdmin,
  normalizeShopDomain,
  shopifyIdTail,
  ShopifyAdminError,
} = require('../src/server/shopifyAdmin',);
const { createStore, } = require('../src/storage/store',);
const { createBillingService, } = require('../src/layers/execution/billingService',);
const { createPlatform, } = require('../src/platform',);
const { DEFAULT_SHOPIFY_API_VERSION, } = require('../src/config/shopifyApiVersion',);
const fs = require('node:fs',);
const path = require('node:path',);

// ─── Mock transport ──────────────────────────────────────────────────────

function jsonResponse(payload, { status = 200, retryAfter = null, } = {},) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (name,) => (String(name,).toLowerCase() === 'retry-after' ? retryAfter : null), },
    json: async () => payload,
  };
}

/** Records every call; `handler(calls, url, init)` returns the response. */
function mockFetch(handler,) {
  const calls = [];
  const fn = async (url, init,) => {
    const entry = { url, init, body: JSON.parse(init.body,), };
    calls.push(entry,);
    return handler(calls, url, init, entry,);
  };
  fn.calls = calls;
  return fn;
}

const GID = 'gid://shopify/AppSubscription/789';

// ─── Client unit ─────────────────────────────────────────────────────────

test('the client posts to the versioned GraphQL endpoint with the token', async () => {
  const fetchFn = mockFetch(async () => jsonResponse({ data: { shop: { name: 'x', }, }, },),);
  const admin = createShopifyAdmin({ shopDomain: 'my-store', accessToken: 'tok', fetchFn, },);

  assert.ok(admin.endpoint.includes('/admin/api/',),);
  assert.ok(admin.endpoint.endsWith('/graphql.json',),);
  assert.ok(admin.endpoint.includes(DEFAULT_SHOPIFY_API_VERSION,), 'version must be derived, not literal',);
  assert.strictEqual(admin.host, 'my-store.myshopify.com',);

  await admin.graphql('{ shop { name } }',);
  assert.strictEqual(fetchFn.calls.length, 1,);
  assert.strictEqual(fetchFn.calls[0].init.headers['X-Shopify-Access-Token'], 'tok',);
},);

test('an auth rejection throws the same message the sync loops relied on', async () => {
  const fetchFn = mockFetch(async () => jsonResponse({}, { status: 401, },),);
  const admin = createShopifyAdmin({ shopDomain: 's', accessToken: 'bad', fetchFn, },);

  await assert.rejects(admin.graphql('{ x }',), /Shopify rejected the access token \(401\/403\)/,);
},);

test('top-level GraphQL errors and userErrors both throw', async () => {
  const topErr = mockFetch(async () => jsonResponse({ errors: [{ message: 'boom', },], },),);
  await assert.rejects(
    createShopifyAdmin({ shopDomain: 's', accessToken: 't', fetchFn: topErr, },).graphql('{ x }',),
    /boom/,
  );

  const userErr = mockFetch(async () => jsonResponse({
    data: { appSubscriptionCreate: { appSubscription: null, confirmationUrl: null, userErrors: [{ message: 'nope', },], }, },
  },),);
  await assert.rejects(
    createShopifyAdmin({ shopDomain: 's', accessToken: 't', fetchFn: userErr, },)
      .graphql('m', {}, { userErrorsPath: ['appSubscriptionCreate',], },),
    /nope/,
  );
},);

test('a throttled first attempt is retried and then succeeds', async () => {
  let n = 0;
  const fetchFn = mockFetch(async () => {
    n++;
    if (n === 1) return jsonResponse({}, { status: 429, retryAfter: '0', },);
    return jsonResponse({ data: { ok: true, }, },);
  },);
  const data = await createShopifyAdmin({ shopDomain: 's', accessToken: 't', fetchFn, },).graphql('{ x }',);
  assert.deepStrictEqual(data, { ok: true, },);
  assert.strictEqual(fetchFn.calls.length, 2,);
},);

test('fetchAllEdges walks cursors and respects the page cap', async () => {
  const fetchFn = mockFetch(async (calls,) => {
    const after = calls[calls.length - 1].body.variables.after;
    if (!after) {
      return jsonResponse({ data: { products: { edges: [{ node: { id: 'a', }, },], pageInfo: { hasNextPage: true, endCursor: 'c1', }, }, }, },);
    }
    return jsonResponse({ data: { products: { edges: [{ node: { id: 'b', }, },], pageInfo: { hasNextPage: false, endCursor: null, }, }, }, },);
  },);
  const admin = createShopifyAdmin({ shopDomain: 's', accessToken: 't', fetchFn, },);
  const nodes = await admin.fetchAllEdges('query Q($first: Int!, $after: String) { products }', { root: 'products', pageSize: 1, },);
  assert.deepStrictEqual(nodes, [{ id: 'a', }, { id: 'b', },],);
  assert.strictEqual(fetchFn.calls[1].body.variables.after, 'c1', 'the cursor must advance',);
},);

test('domain normalization and gid tails behave', () => {
  assert.strictEqual(normalizeShopDomain('my-store',), 'my-store.myshopify.com',);
  assert.strictEqual(normalizeShopDomain('https://my-store.myshopify.com/',), 'my-store.myshopify.com',);
  assert.strictEqual(shopifyIdTail('gid://shopify/Customer/42',), '42',);
  assert.strictEqual(shopifyIdTail('42',), '42',);
  assert.ok(new ShopifyAdminError('x',) instanceof Error,);
},);

// ─── Billing ─────────────────────────────────────────────────────────────

function billing(fetchFn,) {
  const store = createStore();
  const svc = createBillingService({ store, config: {}, fetchFn: undefined, },);
  // fetchFn travels on the call opts (routes pick explicit fields, so a JSON
  // body can never smuggle one in); wire it here the way tests do.
  const orig = svc.createShopifyCharge.bind(svc,);
  svc.createShopifyCharge = (shop, token, plan, opts = {},) => orig(shop, token, plan, { ...opts, fetchFn, },);
  return { store, svc, };
}

test('createShopifyCharge creates the subscription and keeps the return contract', async () => {
  const fetchFn = mockFetch(async (calls,) => {
    const { variables, } = calls[calls.length - 1].body;
    assert.ok(calls[calls.length - 1].body.query.includes('appSubscriptionCreate',),);
    assert.strictEqual(variables.name, 'Storecops Growth',);
    assert.strictEqual(variables.trialDays, 14,);
    assert.strictEqual(variables.lineItems[0].plan.appRecurringPricingDetails.interval, 'EVERY_30_DAYS',);
    assert.strictEqual(variables.lineItems[0].plan.appRecurringPricingDetails.price.amount, '49',);
    return jsonResponse({
      data: {
        appSubscriptionCreate: {
          appSubscription: { id: GID, name: 'Storecops Growth', status: 'PENDING', test: true, },
          confirmationUrl: 'https://shop/approve/1',
          userErrors: [],
        },
      },
    },);
  },);
  const { store, svc, } = billing(fetchFn,);

  const out = await svc.createShopifyCharge('my-store', 'tok', 'growth', {
    shopInstallationId: 'store_1', return_url: 'https://app/return', test: true,
  },);

  assert.strictEqual(out.charge_id, GID,);
  assert.strictEqual(out.confirmation_url, 'https://shop/approve/1',);
  assert.strictEqual(out.plan, 'growth',);
  assert.strictEqual(out.price, 49,);
  assert.strictEqual(out.currency, 'USD',);

  const row = await store.subscriptions.findOne({ shopInstallationId: 'store_1', },);
  assert.ok(row, 'the pending subscription must be persisted for reconciliation',);
  assert.strictEqual(row.status, 'pending_approval',);
  assert.strictEqual(row.shopifyChargeId, GID,);
},);

test('createShopifyCharge surfaces userErrors and persists nothing', async () => {
  const fetchFn = mockFetch(async () => jsonResponse({
    data: {
      appSubscriptionCreate: {
        appSubscription: null, confirmationUrl: null, userErrors: [{ message: 'plan missing', },],
      },
    },
  },),);
  const { store, svc, } = billing(fetchFn,);

  await assert.rejects(svc.createShopifyCharge('s', 't', 'growth', {},), /plan missing/,);
  assert.strictEqual(await store.subscriptions.count({},), 0,);
},);

test('the webhook lookup matches a gid row by numeric tail and old numeric rows exactly', async () => {
  const { store, svc, } = billing(mockFetch(async () => jsonResponse({ data: {}, },),),);
  await store.subscriptions.insert({
    shopInstallationId: 'store_gid', planId: 'growth', status: 'pending_approval', shopifyChargeId: GID,
  },);
  await store.subscriptions.insert({
    shopInstallationId: 'store_old', planId: 'growth', status: 'pending_approval', shopifyChargeId: '4242',
  },);

  // New webhooks carry the numeric id; the gid row must still resolve.
  await svc.handleShopifySubscriptionWebhook({ id: 789, status: 'accepted', },);
  assert.strictEqual((await store.subscriptions.findOne({ shopInstallationId: 'store_gid', },)).status, 'active',);

  await svc.handleShopifySubscriptionWebhook({ id: '4242', status: 'cancelled', },);
  const old = await store.subscriptions.findOne({ shopInstallationId: 'store_old', },);
  assert.strictEqual(old.status, 'cancelled',);
  assert.ok(old.cancelled_at,);
},);

// ─── Sync ────────────────────────────────────────────────────────────────

function shopifyBodies(fetchFn,) {
  return fetchFn.calls.map((c,) => c.body,);
}

test('syncShopify maps GraphQL nodes onto the same records, across pages', async () => {
  const platform = createPlatform();
  const calls = [];
  const fetchFn = mockFetch(async (all, url, init, entry,) => {
    calls.push(entry.body.query.includes('SyncProducts',) ? 'products'
      : entry.body.query.includes('SyncOrders',) ? 'orders' : 'customers',);
    const after = entry.body.variables.after;
    if (entry.body.query.includes('SyncProducts',)) {
      if (!after) {
        return jsonResponse({ data: { products: { edges: [{
          node: {
            id: 'gid://shopify/Product/1', title: 'Shirt', handle: 'shirt',
            variants: { edges: [
              { node: { id: 'gid://shopify/ProductVariant/11', title: 'Default Title', sku: 'SKU-1', price: '20.00', inventoryQuantity: 10, }, },
              { node: { id: 'gid://shopify/ProductVariant/12', title: 'Red', sku: null, price: '22.00', inventoryQuantity: 3, }, },
            ], },
          },
        },], pageInfo: { hasNextPage: true, endCursor: 'p1', }, }, }, },);
      }
      return jsonResponse({ data: { products: { edges: [], pageInfo: { hasNextPage: false, endCursor: null, }, }, }, },);
    }
    if (entry.body.query.includes('SyncOrders',)) {
      return jsonResponse({ data: { orders: { edges: [{
        node: {
          id: 'gid://shopify/Order/100', name: '#1001', email: 'buyer@x.com', createdAt: '2026-09-01T00:00:00Z',
          totalPriceSet: { shopMoney: { amount: '42.50', }, },
          customer: { id: 'gid://shopify/Customer/55', email: 'buyer@x.com', },
          lineItems: { edges: [
            { node: { title: 'Shirt', sku: 'SKU-1', quantity: 2, variant: { id: 'gid://shopify/ProductVariant/11', }, originalUnitPriceSet: { shopMoney: { amount: '20.00', }, }, }, },
            { node: { title: 'Ghost', sku: null, quantity: 1, variant: null, originalUnitPriceSet: { shopMoney: { amount: '2.50', }, }, }, },
          ], },
        },
      },], pageInfo: { hasNextPage: false, endCursor: null, }, }, }, },);
    }
    return jsonResponse({ data: { customers: { edges: [{
      node: { id: 'gid://shopify/Customer/55', email: 'buyer@x.com', phone: '+1000', createdAt: '2026-08-01T00:00:00Z', },
    },], pageInfo: { hasNextPage: false, endCursor: null, }, }, }, },);
  },);

  const out = await platform.integrations.syncShopify('store_sync', {
    shopDomain: 'my-store', accessToken: 'tok', fetchFn,
  },);

  assert.ok(
    calls.includes('products',) && calls.includes('orders',) && calls.includes('customers',),
    'all three resources must be queried',
  );
  assert.strictEqual(out.products_synced, 2,);
  assert.strictEqual(out.orders_synced, 1,);
  assert.strictEqual(out.customers_synced, 1,);
  assert.deepStrictEqual(out.errors, {}, 'a clean sync reports no errors',);

  // Ledger rows: sku kept, missing sku falls back to variant-<numeric id>.
  const sku = await platform.store.inventory.findOne({ store_id: 'store_sync', product_id: 'SKU-1', },);
  assert.ok(sku,);
  assert.strictEqual(sku.price, 20,);
  const fallback = await platform.store.inventory.findOne({ store_id: 'store_sync', product_id: 'variant-12', },);
  assert.ok(fallback, 'a variant without sku must still get a ledger row',);
  assert.strictEqual(fallback.price, 22,);

  // The imported order decremented stock through the real pipeline…
  assert.strictEqual((await platform.store.inventory.findOne({ store_id: 'store_sync', product_id: 'SKU-1', },)).stock, 8,);
  // …and the event carries the mapped total with the numeric customer id.
  const events = await platform.store.events.find({ store_id: 'store_sync', },);
  assert.strictEqual(events.length, 1,);
  assert.strictEqual(events[0].total, 42.5,);
  assert.strictEqual(events[0].customer_id, '55',);
  assert.strictEqual(events[0].items[1].product_id, 'Ghost', 'a line without sku or variant falls back to title',);

  // The customer profile exists under the numeric identity.
  const profile = await platform.store.customers.findOne({ store_id: 'store_sync', identity: '55', },);
  assert.ok(profile,);
  assert.strictEqual(profile.email, 'buyer@x.com',);

  // Versioned endpoint, three operations, products paged twice.
  const bodies = shopifyBodies(fetchFn,);
  assert.ok(bodies.length >= 4, 'products (2 pages) + orders + customers',);
  for (const [i, b,] of bodies.entries()) {
    assert.ok(fetchFn.calls[i].url.includes('/graphql.json',), 'every Admin call uses the GraphQL endpoint',);
    assert.ok(b.query.includes('SyncProducts',) || b.query.includes('SyncOrders',) || b.query.includes('SyncCustomers',),);
  }
  assert.ok(bodies.some((b,) => b.variables.after === 'p1',), 'the product cursor must advance',);
},);

test('syncShopify records per-resource errors without faking success, auth still throws', async () => {
  const platform = createPlatform();
  const fetchFn = mockFetch(async (all, url, init, entry,) => {
    if (entry.body.query.includes('SyncOrders',)) {
      return jsonResponse({ errors: [{ message: 'access denied for orders', },], },);
    }
    return jsonResponse({ data: {
      products: { edges: [], pageInfo: { hasNextPage: false, }, },
      orders: { edges: [], pageInfo: { hasNextPage: false, }, },
      customers: { edges: [], pageInfo: { hasNextPage: false, }, },
    }, },);
  },);

  const out = await platform.integrations.syncShopify('store_partial', {
    shopDomain: 's', accessToken: 't', fetchFn,
  },);
  assert.strictEqual(out.orders_synced, 0,);
  assert.ok(out.errors.orders?.includes('access denied',), 'the failure must be reported, not swallowed',);
  assert.deepStrictEqual(Object.keys(out.errors,), ['orders',],);

  const denied = mockFetch(async () => jsonResponse({}, { status: 403, },),);
  await assert.rejects(
    platform.integrations.syncShopify('store_denied', { shopDomain: 's', accessToken: 'bad', fetchFn: denied, },),
    /Shopify rejected the access token/,
  );
},);

// ─── Webhooks ────────────────────────────────────────────────────────────

test('registerShopifyWebhook returns true on success, false on failure', async () => {
  const platform = createPlatform();
  const ok = mockFetch(async (all, url, init, entry,) => {
    assert.ok(entry.body.query.includes('webhookSubscriptionCreate',),);
    assert.strictEqual(entry.body.variables.topic, 'ORDERS_CREATE',);
    return jsonResponse({ data: { webhookSubscriptionCreate: {
      webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1', }, userErrors: [],
    }, }, },);
  },);
  assert.strictEqual(await platform.integrations.registerShopifyWebhook('s', 't', 'https://app/cb', { fetchFn: ok, },), true,);

  const bad = mockFetch(async () => { throw new Error('down',); },);
  assert.strictEqual(await platform.integrations.registerShopifyWebhook('s', 't', 'https://app/cb', { fetchFn: bad, },), false,);
},);

test('registerComplianceWebhooks registers all four topics via GraphQL enums', async () => {
  const platform = createPlatform();
  const seen = [];
  const fetchFn = mockFetch(async (all, url, init, entry,) => {
    seen.push(entry.body.variables.topic,);
    return jsonResponse({ data: { webhookSubscriptionCreate: {
      webhookSubscription: { id: 'gid://x/1', }, userErrors: [],
    }, }, },);
  },);

  const results = await platform.integrations.registerComplianceWebhooks('s', 't', { fetchFn, },);
  assert.deepStrictEqual(results, {
    'app/uninstalled': 'registered',
    'customers/data_request': 'registered',
    'customers/redact': 'registered',
    'shop/redact': 'registered',
  },);
  assert.deepStrictEqual(seen, ['APP_UNINSTALLED', 'CUSTOMERS_DATA_REQUEST', 'CUSTOMERS_REDACT', 'SHOP_REDACT',],);

  const failing = mockFetch(async () => jsonResponse({ data: { webhookSubscriptionCreate: {
    webhookSubscription: null, userErrors: [{ message: 'taken', },],
  }, }, },),);
  const res2 = await platform.integrations.registerComplianceWebhooks('s', 't', { fetchFn: failing, },);
  assert.ok(Object.values(res2,).every((v,) => String(v,).startsWith('failed (',),), 'failures must be reported per topic',);
},);

// ─── Migration pins ──────────────────────────────────────────────────────

function stripComments(source,) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '',)
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1',);
}

test('no Admin REST literal survives in the migrated files', () => {
  const files = [
    ['src', 'server', 'integrations.js',],
    ['src', 'layers', 'execution', 'billingService.js',],
  ].map((parts,) => path.join(__dirname, '..', ...parts,),);
  assert.strictEqual(files.length, 2, 'the scan must cover both migrated files',);

  const banned = [
    'recurring_application_charges',
    'products.json', 'orders.json', 'customers.json', 'webhooks.json',
  ];
  const offenders = [];
  for (const file of files) {
    assert.ok(fs.existsSync(file,), `expected to scan ${file}`,);
    const code = stripComments(fs.readFileSync(file, 'utf8',),);
    if (code.includes('admin/api',)) offenders.push(`${path.basename(file,)} still references an admin/api REST path`,);
    for (const lit of banned) {
      if (code.includes(lit,)) offenders.push(`${path.basename(file,)} still references ${lit}`,);
    }
  }
  assert.deepStrictEqual(offenders, [], 'Admin REST must be gone from the migrated files:\n' + offenders.join('\n',),);
},);

test('the sync never calls the non-existent findOrCreate again (SYNC-001)', () => {
  const code = stripComments(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'integrations.js',), 'utf8',),
  );
  assert.ok(!code.includes('.findOrCreate(',), 'the customers sync must go through applyEvent',);
},);
