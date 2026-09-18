'use strict';

process.env.NODE_ENV = 'test';

/**
 * EventTracker atomicity (DB-006 residual).
 *
 * `track()` does event-insert -> profile-update -> listener fan-out across
 * awaits. Without serialization two concurrent tracks for one store interleave;
 * without compensation a downstream exception leaves an event with no profile
 * update. The fix serializes per store with the shared keyed mutex and removes
 * the inserted event again on the exception path (best-effort — a process
 * crash between steps still needs DB transactions).
 */

const test = require('node:test',);
const assert = require('node:assert',);

const { createStore, } = require('../src/storage/store',);
const { createEventTracker, } = require('../src/layers/data/eventTracker',);
const { createCustomerProfiles, } = require('../src/layers/data/customerProfile',);
const { createConsentService, } = require('../src/layers/execution/consentService',);

function trackerFor(store,) {
  const customerProfiles = createCustomerProfiles({ store, },);
  const consentService = createConsentService({ store, },);
  return createEventTracker({ store, customerProfiles, consentService, },);
}

const evt = (store_id, customer_id,) => ({
  event_type: 'page_view',
  store_id,
  customer_id,
  session_id: 's1',
});

test('concurrent tracks for one store all persist with profiles in sync', async () => {
  const store = createStore();
  const tracker = trackerFor(store,);

  const N = 20;
  const results = await Promise.all(
    Array.from({ length: N, }, (_, i,) => tracker.track(evt('store_a', `c_${i}`,),),),
  );

  assert.ok(results.every((r,) => r.accepted,), 'every concurrent track must be accepted',);
  assert.strictEqual(await store.events.count({ store_id: 'store_a', },), N,);
  for (let i = 0; i < N; i++) {
    const profile = await store.customers.findOne({ store_id: 'store_a', identity: `c_${i}`, },);
    assert.ok(profile, `profile for c_${i} must exist — event without profile is the defect`,);
  }
},);

test('a downstream listener failure compensates instead of leaving an orphan event', async () => {
  const store = createStore();
  const tracker = trackerFor(store,);
  tracker.onEvent(async () => {
    throw new Error('downstream boom',);
  },);

  await assert.rejects(
    tracker.track(evt('store_b', 'c_boom',),),
    /downstream boom/,
  );
  assert.strictEqual(
    await store.events.count({ store_id: 'store_b', },),
    0,
    'the inserted event must be removed again on the exception path',
  );
},);

test('tracks for different stores do not block each other into a single sequence', async () => {
  const store = createStore();
  const tracker = trackerFor(store,);
  const order = [];
  tracker.onEvent(async (e,) => {
    order.push(e.store_id,);
  },);

  await Promise.all([
    tracker.track(evt('store_x', 'cx',),),
    tracker.track(evt('store_y', 'cy',),),
  ],);

  assert.deepStrictEqual(new Set(order,), new Set(['store_x', 'store_y',],),);
  assert.strictEqual(await store.events.count({},), 2,);
},);
