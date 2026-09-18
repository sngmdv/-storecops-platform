'use strict';

process.env.NODE_ENV = 'test';

/**
 * PERF-001 — N+1 queries in revenueIntelligence.
 *
 * THE DEFECT
 * ----------
 * `generateSmartReminders` iterated every subscription and, inside the loop,
 * called `store.integrations.findOne({ store_id })`. It then called
 * `calculateROI(storeId)` with only the id, so `calculateROI` immediately
 * re-read the *same* integration row and re-read the subscription the caller
 * already held in hand. `calculateROI` additionally read `deliveries` twice with
 * an identical filter — once for cart-recovery value, once for automation value.
 *
 * Measured per store with a due renewal, before the fix: **9 reads**.
 *   1. integrations.findOne        (caller's loop)
 *   2. integrations.findOne        (inside calculateROI — same document)
 *   3. subscriptions.findOne
 *   4. deliveries.find             (cart recovery)
 *   5. events.find
 *   6. competitorSnapshots.find
 *   7. seoAudits.find
 *   8. actions.find
 *   9. deliveries.find             (automation — same filter as #4)
 *
 * After: **5 reads per store** plus a single `integrations.find({})` for the
 * whole run.
 *
 * WHY THE SHAPE MATTERS MORE THAN THE CONSTANT
 * --------------------------------------------
 * `find`/`findOne` are O(n) scans of their collection (a WHERE query in SQLite,
 * a full `records.values()` walk in memory). A `findOne` inside a loop over a
 * different collection is therefore O(n*m) for a result one pass could provide.
 * So the assertions that matter are the *shape* ones — the read count must not
 * grow with the number of subscriptions — not the total.
 *
 * CONTROL TESTS
 * -------------
 * Test 3 calls `calculateROI` WITHOUT the prefetch argument and asserts it still
 * reads `integrations` once per call, proving the prefetch is what removes the
 * read rather than the read having been deleted outright. Test 7 seeds two
 * integration rows for one store and asserts first-match-wins, because
 * `indexByStoreId` must reproduce `findOne`'s semantics exactly or the
 * optimisation would silently change which store name is used.
 *
 * Also note (see `getConversionIntelligence`): the per-store `events.find` was
 * left in place deliberately. The window is "this calendar month" and the store
 * facade only supports equality filters, so the date predicate cannot be pushed
 * down. Its cost is bounded by the number of *active subscriptions*, not by the
 * number of events; one global pass would instead hold the entire events
 * collection in memory, which is worse on a 139MB database.
 */

const test = require('node:test',);
const assert = require('node:assert',);

const { createStore, COLLECTIONS, } = require('../src/storage/store',);
const { createRevenueIntelligence, } = require('../src/layers/intelligence/revenueIntelligence',);

const DAY_MS = 86400000;

/**
 * `Math.ceil((period_end - now) / DAY_MS)` must land inside the
 * `days_before: 30` window, which matches `daysUntilRenewal` in (28, 30].
 * 29.5 days of headroom keeps the ceil at 30 even with a few ms of drift.
 */
const RENEWAL_DUE_IN_DAYS = 29.5;

const READ_METHODS = new Set(['find', 'findOne', 'count',],);

/**
 * Wrap every collection so reads are counted. Reads go through the real
 * implementation — this observes the code under test, it does not replace it.
 */
function instrument(base,) {
  const calls = [];
  const store = {};

  for (const name of COLLECTIONS) {
    store[name] = new Proxy(base[name], {
      get(target, prop,) {
        const value = target[prop];
        if (typeof value === 'function' && READ_METHODS.has(prop,)) {
          return (...args) => {
            calls.push({ collection: name, method: prop, },);
            return value.apply(target, args,);
          };
        }
        return typeof value === 'function' ? value.bind(target,) : value;
      },
    },);
  }

  return {
    store,
    calls,
    reads(collection, method,) {
      return calls.filter((c,) => c.collection === collection && (!method || c.method === method),).length;
    },
    reset() {
      calls.length = 0;
    },
  };
}

function makeCalc(base,) {
  const harness = instrument(base,);
  const calc = createRevenueIntelligence({ store: harness.store, config: {}, },);
  return { calc, harness, };
}

/** Seed one store that has a renewal due inside the `days_before: 30` window. */
async function seedDueStore(store, index,) {
  const store_id = `store_${index}`;

  await store.integrations.insert({ store_id, store_name: `Shop ${index}`, },);
  await store.subscriptions.insert({
    shopInstallationId: store_id,
    status: 'active',
    planId: 'growth',
    price_monthly: 49,
    started_at: new Date(Date.now() - 90 * DAY_MS,).toISOString(),
    current_period_end: new Date(Date.now() + RENEWAL_DUE_IN_DAYS * DAY_MS,).toISOString(),
  },);
  await store.deliveries.insert({ store_id, action_type: 'cart_recovery', channel: 'email', },);
  await store.deliveries.insert({ store_id, action_type: 'followup', channel: 'email', },);
  await store.events.insert({ store_id, event_type: 'purchase', total: 120, },);
  await store.competitorSnapshots.insert({ store_id, price_changed: true, },);
  await store.seoAudits.insert({ store_id, overall_score: 60, },);
  await store.seoAudits.insert({ store_id, overall_score: 74, },);
  await store.actions.insert({ store_id, action_type: 'churn_prevention', },);

  return store_id;
}

// ── The shape: reads must not scale with the number of subscriptions ─────────

test('PERF-001: generateSmartReminders reads integrations once for the whole run', async () => {
  const store = createStore();
  for (let i = 0; i < 5; i++) await seedDueStore(store, i,);

  const { calc, harness, } = makeCalc(store,);
  const result = await calc.generateSmartReminders();

  assert.equal(result.reminders.length, 5, 'all five due stores should produce a reminder',);
  assert.equal(
    harness.reads('integrations',),
    1,
    'integrations must be read once for the run, not once per subscription',
  );
  assert.equal(
    harness.reads('integrations', 'findOne',),
    0,
    'no per-subscription integrations.findOne may remain',
  );
},);

test('PERF-001: per-store reads are constant and do not grow with subscription count', async () => {
  const totals = {};
  for (const n of [2, 8,]) {
    const store = createStore();
    for (let i = 0; i < n; i++) await seedDueStore(store, i,);

    const { calc, harness, } = makeCalc(store,);
    await calc.generateSmartReminders();

    // One `integrations.find({})` for the run, plus the two subscription scans
    // (active + cancelled). Everything else must be per matching store.
    assert.equal(harness.reads('integrations',), 1, `N=${n}: integrations read once`,);
    assert.equal(harness.reads('subscriptions',), 2, `N=${n}: active + cancelled only`,);
    assert.equal(
      harness.reads('subscriptions', 'findOne',),
      0,
      `N=${n}: the subscription is passed in, never re-read`,
    );
    // One deliveries read per store, not two — cart recovery and automation
    // share the single read.
    assert.equal(harness.reads('deliveries',), n, `N=${n}: deliveries read once per store`,);

    totals[n] = harness.reads('deliveries',) + harness.reads('events',) +
      harness.reads('competitorSnapshots',) + harness.reads('seoAudits',) + harness.reads('actions',);
  }

  // 5 genuinely-distinct reads per store. The old code did 9, so this fails
  // loudly if the duplicate or the loop-level findOne comes back.
  assert.equal(totals[2], 10, 'N=2: 5 per-store reads each',);
  assert.equal(totals[8], 40, 'N=8: 5 per-store reads each',);
  assert.equal((totals[8] - totals[2]) / 6, 5, 'growth must be 5 reads per store, not 9',);
},);

// ── Controls: the reads still exist, they are just not per-iteration ─────────

test('PERF-001 control: the original loop shape cost two integrations reads per store', async () => {
  const store = createStore();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await seedDueStore(store, i,),);

  const { calc, harness, } = makeCalc(store,);

  // Reproduce the PRE-FIX loop exactly: a `findOne` in the caller, then
  // `calculateROI(storeId)` with nothing prefetched. If these numbers ever stop
  // exceeding the fixed path's, this file is no longer proving the fix.
  harness.reset();
  for (const id of ids) {
    await harness.store.integrations.findOne({ store_id: id, },);
    await calc.calculateROI(id,);
  }

  assert.equal(harness.reads('integrations', 'findOne',), 6, 'the same row was read twice per store',);
  assert.equal(harness.reads('subscriptions', 'findOne',), 3, 'the subscription was re-read per store',);
  // One per `calculateROI` call, because the internal deliveries read is already
  // shared between its two consumers — see the next control for that half.
  assert.equal(harness.reads('deliveries',), 3,);
},);

/**
 * The other half of the defect: `calculateROI` used to read `deliveries` twice
 * with an identical filter, once for cart-recovery value and once for automation
 * value. `calculateROI` now reads it once and passes it to both, so the duplicate
 * can only be observed by invoking the two consumers directly.
 */
test('PERF-001 control: unshared, the two delivery consumers each read deliveries', async () => {
  const store = createStore();
  const store_id = await seedDueStore(store, 0,);

  const { calc, harness, } = makeCalc(store,);

  harness.reset();
  await calc._calcCartRecoveryValue(store_id,);
  await calc._calcAutomationValue(store_id,);
  assert.equal(
    harness.reads('deliveries',),
    2,
    'called without a shared array, each consumer performs its own read — the old cost',
  );

  harness.reset();
  await calc.calculateROI(store_id,);
  assert.equal(
    harness.reads('deliveries',),
    1,
    'calculateROI must read deliveries once and share it',
  );
},);

test('PERF-001 control: calculateROI without prefetch still reads each source once', async () => {
  const store = createStore();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await seedDueStore(store, i,),);

  const { calc, harness, } = makeCalc(store,);

  for (const id of ids) {
    harness.reset();
    const roi = await calc.calculateROI(id,);

    assert.ok(roi.total_value_delivered >= 0, 'ROI must compute',);
    // The read was not deleted — calling without prefetch still performs it.
    // This is what makes the "read once per run" assertion meaningful.
    assert.equal(harness.reads('integrations', 'findOne',), 1, 'one integration read per un-prefetched call',);
    assert.equal(harness.reads('subscriptions', 'findOne',), 1, 'one subscription read per un-prefetched call',);
    // Deliveries is shared internally, so a single ROI calculation reads it once.
    assert.equal(harness.reads('deliveries',), 1, 'deliveries must not be read twice per ROI',);
  }
},);

test('PERF-001: getConversionIntelligence reuses the integrations it already loaded', async () => {
  const store = createStore();
  for (let i = 0; i < 4; i++) await seedDueStore(store, i,);

  const { calc, harness, } = makeCalc(store,);
  await calc.getConversionIntelligence();

  assert.equal(harness.reads('integrations',), 1, 'integrations loaded once',);
  assert.equal(
    harness.reads('integrations', 'findOne',),
    0,
    'the per-subscription integrations.findOne was replaced by an in-memory lookup',
  );
},);

// ── Correctness: the optimisation must not change the answer ────────────────

test('PERF-001: prefetched calculateROI returns the same numbers as the un-prefetched path', async () => {
  const store = createStore();
  const store_id = await seedDueStore(store, 7,);

  const { calc, } = makeCalc(store,);

  const direct = await calc.calculateROI(store_id,);

  const integration = await store.integrations.findOne({ store_id, },);
  const subscription = await store.subscriptions.findOne({ shopInstallationId: store_id, status: 'active', },);
  const deliveries = await store.deliveries.find({ store_id, },);
  const prefetched = await calc.calculateROI(store_id, { integration, subscription, deliveries, },);

  // `calculated_at` is a timestamp and legitimately differs between calls.
  const strip = ({ calculated_at: _omitted, ...rest },) => rest;
  assert.deepEqual(strip(prefetched,), strip(direct,),);

  // An explicit `null` must be honoured as "there is none", not treated as
  // "not supplied" — otherwise a missing store would be re-queried.
  const missing = await calc.calculateROI('store_absent', { integration: null, },);
  assert.equal(missing.error, 'Store not found',);
},);

test('PERF-001: indexByStoreId preserves findOne first-match-wins semantics', async () => {
  const store = createStore();
  const store_id = await seedDueStore(store, 3,);

  // A second integration row for the same store, inserted later. `findOne`
  // returns the first match, so the reminder must use "Shop 3", not "Shop 3 dup".
  await store.integrations.insert({ store_id, store_name: 'Shop 3 dup', },);

  const first = await store.integrations.findOne({ store_id, },);
  assert.equal(first.store_name, 'Shop 3', 'precondition: findOne returns the first row',);

  const { calc, } = makeCalc(store,);
  const result = await calc.generateSmartReminders();
  const reminder = result.reminders.find((r,) => r.store_id === store_id,);

  assert.ok(reminder, 'the due store should produce a reminder',);
  assert.equal(reminder.store_name, 'Shop 3', 'the map lookup must match findOne, not the last row',);
},);

test('PERF-001: a store with no matching window still costs no ROI reads', async () => {
  const store = createStore();
  const store_id = 'store_idle';

  await store.integrations.insert({ store_id, store_name: 'Idle', },);
  await store.subscriptions.insert({
    shopInstallationId: store_id,
    status: 'active',
    planId: 'growth',
    price_monthly: 49,
    started_at: new Date(Date.now() - 90 * DAY_MS,).toISOString(),
    // 20 days out matches none of the disjoint sequence windows.
    current_period_end: new Date(Date.now() + 20 * DAY_MS,).toISOString(),
  },);

  const { calc, harness, } = makeCalc(store,);
  const result = await calc.generateSmartReminders();

  assert.equal(result.reminders.length, 0, 'nothing is due, so nothing is generated',);
  // The ROI computation stays lazy: hoisting it above the step loop would have
  // made this store pay for five reads it does not need.
  assert.equal(harness.reads('deliveries',), 0, 'no ROI work for a store with no matching step',);
  assert.equal(harness.reads('actions',), 0, 'no ROI work for a store with no matching step',);
},);
