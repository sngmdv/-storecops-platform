'use strict';

/**
 * Guard tests for the growth-loop scheduler.
 *
 * The defect these lock down: the hourly sweep skipped every store with real
 * integration credentials via `if (hasRealCredentials) continue`. That is
 * exactly the set of connected, paying merchants, so `runGrowthCycle` — rule
 * evaluation, recovery-message queuing, the delivery drain, attribution —
 * never ran for them automatically. The only remaining caller was the manual
 * button in the dashboard.
 *
 * The guard was added in `d52cca35` ("demo gate DB-001") to stop demo data
 * being fabricated into connected stores. The intent was right; it was
 * attached to the wrong decision.
 */

const test = require('node:test',);
const assert = require('node:assert',);

const {
  parseDemoStores,
  hasRealCredentials,
  createGrowthCycleRunner,
} = require('../src/server/growthScheduler',);

const silentLog = { log() {}, error() {}, };

// Pinned explicitly rather than read from the environment: these tests must
// not change behaviour because DEMO_STORE_IDS happens to be set on the machine
// or in CI. `parseDemoStores` itself is covered separately below.
const DEMO = parseDemoStores('store_demo,demo_store',);

/**
 * A faithful stand-in for the platform surface the scheduler touches.
 *
 * Deliberately mirrors the real facade: `platform.store` exposes collections
 * as properties (`users`, `integrations`, `events`) with no `.get()` or
 * `.findOne()` at the top level. A stub that offered those would hide the
 * DB-001 class of bug rather than reproduce it.
 */
function makePlatform({ stores, credentials = {}, events = {}, failCycle = [], withConnectors = false, } = {},) {
  const seeded = [];
  const cycled = [];

  const store = {
    users: {
      find: async () => stores.map((store_id,) => ({ store_id, }),),
    },
    integrations: {
      findOne: async ({ store_id, },) => credentials[store_id] ?? null,
    },
    events: {
      find: async ({ store_id, },) => (events[store_id] ?? []).map(() => ({ id: 'evt', }),),
    },
  };
  // The connectors collection is optional — an older store may not have one.
  if (withConnectors) {
    store.connectors = { findOne: async () => null, };
  }

  const platform = {
    store,
    demoSeed: {
      seed: async (store_id,) => {
        seeded.push(store_id,);
        return { store_id, seeded: true, events: 12, };
      },
    },
    runGrowthCycle: async (store_id,) => {
      if (failCycle.includes(store_id,)) throw new Error(`cycle failed for ${store_id}`,);
      cycled.push(store_id,);
      return {
        scan: { queued_actions: [], },
        execution: { delivered: 0, },
        attribution: { conversions: 0, },
      };
    },
  };

  return { platform, seeded, cycled, };
}

const SHOPIFY_CREDS = { shopify: { access_token: 'shpat_test', }, };

test('a store with real credentials still gets its growth cycle', async () => {
  // The regression. Before the fix this store was skipped outright.
  const { platform, seeded, cycled, } = makePlatform({
    stores: ['store_real',],
    credentials: { store_real: SHOPIFY_CREDS, },
    events: { store_real: [{}, {},], },
  },);

  const runner = createGrowthCycleRunner({ platform, demoStores: DEMO, log: silentLog, },);
  const summary = await runner.runOnce();

  assert.deepStrictEqual(cycled, ['store_real',], 'the cycle must run for a connected merchant',);
  assert.deepStrictEqual(seeded, [], 'but no demo data may be fabricated into it',);
  assert.deepStrictEqual(summary.ran, ['store_real',],);
  assert.strictEqual(summary.considered, 1,);
},);

test('control: the old gate really would have excluded that store', async () => {
  // Proves the fixture exercises the bug rather than passing vacuously. If
  // `hasRealCredentials` returned false here, the regression test above would
  // pass even with the defect reintroduced.
  const { platform, } = makePlatform({
    stores: ['store_real',],
    credentials: { store_real: SHOPIFY_CREDS, },
    events: { store_real: [{},], },
  },);

  assert.strictEqual(await hasRealCredentials(platform, 'store_real',), true,);
},);

test('every store with data is cycled regardless of credentials', async () => {
  const { platform, cycled, } = makePlatform({
    stores: ['store_demo', 'store_real', 'store_empty',],
    credentials: { store_real: SHOPIFY_CREDS, },
    events: { store_demo: [{},], store_real: [{},], },
  },);

  const runner = createGrowthCycleRunner({ platform, demoStores: DEMO, log: silentLog, },);
  const summary = await runner.runOnce();

  assert.deepStrictEqual(cycled.sort(), ['store_demo', 'store_real',],);
  assert.deepStrictEqual(summary.skipped_no_data, ['store_empty',],);
},);

test('an unconnected demo store is seeded and then cycled', async () => {
  const { platform, seeded, cycled, } = makePlatform({ stores: ['store_demo',], },);

  const runner = createGrowthCycleRunner({ platform, demoStores: DEMO, log: silentLog, },);
  await runner.runOnce();

  assert.deepStrictEqual(seeded, ['store_demo',],);
  // Seeded stores are exempt from the no-events check — they were just given
  // events by the seed above, so re-querying would be a wasted read.
  assert.deepStrictEqual(cycled, ['store_demo',],);
},);

test('a demo store that is actually connected is never seeded', async () => {
  // The DB-001 protection, preserved. Fabricating orders into a live
  // merchant's dashboard is unrecoverable trust damage.
  const { platform, seeded, cycled, } = makePlatform({
    stores: ['store_demo',],
    credentials: { store_demo: SHOPIFY_CREDS, },
    events: { store_demo: [{},], },
  },);

  const runner = createGrowthCycleRunner({ platform, demoStores: DEMO, log: silentLog, },);
  await runner.runOnce();

  assert.deepStrictEqual(seeded, [], 'a connected store must not be seeded, even when listed',);
  assert.deepStrictEqual(cycled, ['store_demo',], 'but it must still be cycled',);
},);

test('a store with no data is skipped, not fabricated', async () => {
  const { platform, seeded, cycled, } = makePlatform({ stores: ['store_new',], },);

  const runner = createGrowthCycleRunner({ platform, demoStores: DEMO, log: silentLog, },);
  const summary = await runner.runOnce();

  assert.deepStrictEqual(seeded, [],);
  assert.deepStrictEqual(cycled, [],);
  assert.deepStrictEqual(summary.skipped_no_data, ['store_new',],);
},);

test('DEMO_MODE cannot seed an unlisted store', async () => {
  // `server.js` defined `isDemoEnabled()` and never called it, so the
  // documented "or when DEMO_MODE=true" behaviour did not exist. It is not
  // restored: one environment variable that causes fabricated orders to appear
  // in a real merchant's dashboard is the DB-001 failure mode again.
  const previous = process.env.DEMO_MODE;
  process.env.DEMO_MODE = 'true';
  try {
    const { platform, seeded, } = makePlatform({
      stores: ['store_real',],
      credentials: { store_real: SHOPIFY_CREDS, },
      events: { store_real: [{},], },
    },);
    const runner = createGrowthCycleRunner({ platform, demoStores: DEMO, log: silentLog, },);
    await runner.runOnce();

    assert.deepStrictEqual(seeded, [],);
  } finally {
    if (previous === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previous;
  }
},);

test('one failing store does not starve the rest of the sweep', async () => {
  // A single try/catch around the whole loop meant one bad store aborted the
  // run, silently starving every merchant ordered after it.
  const { platform, cycled, } = makePlatform({
    stores: ['store_a', 'store_b', 'store_c',],
    events: { store_a: [{},], store_b: [{},], store_c: [{},], },
    failCycle: ['store_b',],
  },);

  const runner = createGrowthCycleRunner({ platform, demoStores: DEMO, log: silentLog, },);
  const summary = await runner.runOnce();

  assert.deepStrictEqual(cycled, ['store_a', 'store_c',],);
  assert.strictEqual(summary.errors.length, 1,);
  assert.strictEqual(summary.errors[0].store_id, 'store_b',);
},);

test('a failing users query is reported, not thrown', async () => {
  const platform = {
    store: { users: { find: async () => { throw new Error('db down',); }, }, },
    demoSeed: { seed: async () => {}, },
    runGrowthCycle: async () => {},
  };

  const runner = createGrowthCycleRunner({ platform, demoStores: DEMO, log: silentLog, },);
  const summary = await runner.runOnce();

  assert.strictEqual(summary.considered, 0,);
  assert.strictEqual(summary.errors.length, 1,);
  assert.strictEqual(summary.errors[0].store_id, null,);
},);

test('hasRealCredentials works with and without a connectors collection', async () => {
  const withCreds = { store_id: 'store_x', shopify: { access_token: 'shpat_x', }, };

  const a = makePlatform({ stores: ['store_x',], credentials: { store_x: withCreds, }, withConnectors: true, },);
  assert.strictEqual(await hasRealCredentials(a.platform, 'store_x',), true,);

  const b = makePlatform({ stores: ['store_x',], credentials: { store_x: withCreds, }, withConnectors: false, },);
  assert.strictEqual(await hasRealCredentials(b.platform, 'store_x',), true,);

  const c = makePlatform({ stores: ['store_x',], withConnectors: false, },);
  assert.strictEqual(await hasRealCredentials(c.platform, 'store_x',), false,);
},);

test('hasRealCredentials recognises each platform and tolerates a throw', async () => {
  for (const creds of [
    { shopify: { access_token: 'x', }, },
    { woocommerce: { consumer_key: 'x', }, },
    { bigcommerce: { access_token: 'x', }, },
  ]) {
    const { platform, } = makePlatform({ stores: ['store_x',], credentials: { store_x: creds, }, },);
    assert.strictEqual(await hasRealCredentials(platform, 'store_x',), true,);
  }

  // A record with no recognisable token is not a real connection.
  const { platform, } = makePlatform({ stores: ['store_x',], credentials: { store_x: { shopify: {}, }, }, },);
  assert.strictEqual(await hasRealCredentials(platform, 'store_x',), false,);

  // Fail-open is acceptable here: seeding is gated on the explicit allowlist
  // first, so an error can only ever reach ids an operator listed.
  const throwing = {
    store: { integrations: { findOne: async () => { throw new Error('nope',); }, }, },
  };
  assert.strictEqual(await hasRealCredentials(throwing, 'store_x',), false,);
},);

test('parseDemoStores reads the allowlist and trims whitespace', async () => {
  assert.deepStrictEqual([...parseDemoStores('a, b ,c',),].sort(), ['a', 'b', 'c',],);
  assert.deepStrictEqual([...parseDemoStores('solo',),], ['solo',],);

  // With the variable unset it falls back to the two built-in demo ids.
  const previous = process.env.DEMO_STORE_IDS;
  delete process.env.DEMO_STORE_IDS;
  try {
    assert.deepStrictEqual([...parseDemoStores(),].sort(), ['demo_store', 'store_demo',],);
  } finally {
    if (previous !== undefined) process.env.DEMO_STORE_IDS = previous;
  }
},);
