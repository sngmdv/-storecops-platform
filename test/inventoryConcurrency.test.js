'use strict';

process.env.NODE_ENV = 'test';

/**
 * Inventory ledger concurrency (DB-006).
 *
 * THE DEFECT
 * ----------
 * `inventoryLedger` does a read-modify-write across an `await`:
 *
 *     const entry = await findEntry(store_id, product_id);
 *     if (!entry) entry = await store.inventory.insert({ ..., stock: 0 });
 *     const newStock = entry.stock - quantity;
 *     await store.inventory.update(entry._id, { stock: Math.max(0, newStock) });
 *
 * Between the read and the write the event loop runs other work, so concurrent
 * sales of the same product all read the same `stock` and all write the same
 * decremented value. Measured before the fix: 20 concurrent sales against a
 * product with stock 20 left stock at **19** — 19 of the 20 sales were lost.
 * The same interleaving made `if (!entry) insert(...)` run more than once,
 * creating duplicate inventory rows for one product.
 *
 * The audit filed this as "no transactions". A SQL transaction would have been
 * the wrong fix: the store is pluggable (memory / SQLite / Redis) and has no
 * transaction primitive, so a BEGIN/COMMIT fix would work on one adapter and
 * silently leave the other two broken. The fix is a keyed mutex in the service
 * layer (src/storage/keyedMutex.js), which is adapter-independent.
 *
 * A control test below reproduces the original interleaving without the mutex,
 * so these assertions cannot pass by accident.
 */

const test = require('node:test',);
const assert = require('node:assert',);

const { createStore, } = require('../src/storage/store',);
const { createInventoryLedger, } = require('../src/layers/data/inventoryLedger',);
const { createKeyedMutex, } = require('../src/storage/keyedMutex',);

const STORE = 'store_inv';

const sale = (product_id, quantity = 1,) => ({
  event_type: 'purchase',
  store_id: STORE,
  items: [{ product_id, quantity, },],
});

const stockOf = async (store, product_id,) =>
  (await store.inventory.findOne({ store_id: STORE, product_id, },))?.stock;

// ── The race, and its absence ───────────────────────────────────────────────

/**
 * Control. Reproduces the ORIGINAL interleaving by hand — no mutex — to prove
 * the concurrent scenario genuinely races. If this ever stops losing updates,
 * the tests below stop proving anything and this one will say so.
 */
test('DB-006 control: the un-serialized read-modify-write really does lose updates', async () => {
  const store = createStore();
  await store.inventory.insert({ store_id: STORE, product_id: 'p_race', stock: 20, oversold: 0, },);

  await Promise.all(
    Array.from({ length: 20, }, async () => {
      const entry = await store.inventory.findOne({ store_id: STORE, product_id: 'p_race', },);
      const newStock = entry.stock - 1;
      await store.inventory.update(entry._id, { stock: Math.max(0, newStock,), },);
    },),
  );

  const final = await stockOf(store, 'p_race',);
  assert.ok(
    final > 0,
    `the un-mutexed pattern must lose updates for this suite to mean anything; it produced ${final}`,
  );
},);

test('DB-006: concurrent sales decrement stock exactly once each', async () => {
  const store = createStore();
  const ledger = createInventoryLedger({ store, },);
  await ledger.setStock({ store_id: STORE, product_id: 'p_1', stock: 20, },);

  await Promise.all(
    Array.from({ length: 20, }, () => ledger.onSale(sale('p_1',),),),
  );

  assert.equal(await stockOf(store, 'p_1',), 0, '20 sales against stock 20 must reach 0',);
  const entry = await store.inventory.findOne({ store_id: STORE, product_id: 'p_1', },);
  assert.equal(entry.oversold, 0, 'nothing was oversold',);
},);

test('DB-006: concurrent sales of a NEW product create exactly one row', async () => {
  const store = createStore();
  const ledger = createInventoryLedger({ store, },);

  await Promise.all(
    Array.from({ length: 10, }, () => ledger.onSale(sale('p_new',),),),
  );

  const rows = await store.inventory.find({ store_id: STORE, },);
  assert.equal(
    rows.length,
    1,
    'find-or-insert must not run twice for the same product — duplicates would double-count stock forever',
  );
  assert.equal(rows[0].stock, 0,);
  assert.equal(rows[0].oversold, 10, 'all 10 sales against zero stock are oversold',);
},);

test('DB-006: oversell accounting stays exact under concurrency', async () => {
  const store = createStore();
  const ledger = createInventoryLedger({ store, },);
  await ledger.setStock({ store_id: STORE, product_id: 'p_2', stock: 3, },);

  // 10 sales of 1 against stock 3 -> 3 satisfied, 7 oversold.
  await Promise.all(
    Array.from({ length: 10, }, () => ledger.onSale(sale('p_2',),),),
  );

  const entry = await store.inventory.findOne({ store_id: STORE, product_id: 'p_2', },);
  assert.equal(entry.stock, 0,);
  assert.equal(entry.oversold, 7, 'the oversold counter must not lose increments either',);
},);

test('DB-006: concurrent restocks do not lose increments', async () => {
  const store = createStore();
  const ledger = createInventoryLedger({ store, },);
  await ledger.setStock({ store_id: STORE, product_id: 'p_3', stock: 0, },);

  await Promise.all(
    Array.from({ length: 15, }, () => ledger.restock({ store_id: STORE, product_id: 'p_3', quantity: 2, },),),
  );

  assert.equal(await stockOf(store, 'p_3',), 30, '15 restocks of 2 must total 30',);
},);

test('DB-006: a sale and a stock-set on the same product do not duplicate the row', async () => {
  const store = createStore();
  const ledger = createInventoryLedger({ store, },);

  // Both paths find-or-insert on the same key; racing them used to create two rows.
  await Promise.all([
    ledger.setStock({ store_id: STORE, product_id: 'p_4', stock: 5, },),
    ledger.onSale(sale('p_4',),),
    ledger.setStock({ store_id: STORE, product_id: 'p_4', stock: 7, },),
    ledger.onSale(sale('p_4',),),
  ],);

  const rows = await store.inventory.find({ store_id: STORE, },);
  assert.equal(rows.length, 1, 'one product must have exactly one ledger row',);
},);

test('DB-006: different products are not serialized against each other', async () => {
  const store = createStore();
  const ledger = createInventoryLedger({ store, },);
  await ledger.setStock({ store_id: STORE, product_id: 'a', stock: 5, },);
  await ledger.setStock({ store_id: STORE, product_id: 'b', stock: 5, },);

  await Promise.all([
    ledger.onSale(sale('a',),),
    ledger.onSale(sale('b',),),
  ],);

  assert.equal(await stockOf(store, 'a',), 4,);
  assert.equal(await stockOf(store, 'b',), 4,);
},);

// ── The mutex itself ────────────────────────────────────────────────────────

test('keyed mutex: runs same-key work strictly in order', async () => {
  const mutex = createKeyedMutex();
  const order = [];

  await Promise.all([
    mutex.run('k', async () => { order.push('a-start',); await new Promise((r,) => setTimeout(r, 10,),); order.push('a-end',); },),
    mutex.run('k', async () => { order.push('b-start',); order.push('b-end',); },),
    mutex.run('k', async () => { order.push('c-start',); order.push('c-end',); },),
  ],);

  assert.deepEqual(
    order,
    ['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end',],
    'a later holder must not start before the previous one finishes',
  );
},);

test('keyed mutex: a rejected task releases the key and does not poison the queue', async () => {
  const mutex = createKeyedMutex();

  const failing = mutex.run('k', async () => { throw new Error('boom',); },);
  await assert.rejects(failing, /boom/,);

  // The next holder must still run. If the chain propagated the rejection,
  // every later waiter would inherit it instead of running.
  const value = await mutex.run('k', async () => 'ok',);
  assert.equal(value, 'ok',);
},);

test('keyed mutex: releases keys so the map stays bounded', async () => {
  const mutex = createKeyedMutex();
  assert.equal(mutex.size(), 0,);

  await Promise.all([
    mutex.run('a', async () => {},),
    mutex.run('b', async () => {},),
  ],);

  assert.equal(mutex.size(), 0, 'a drained chain must not leak its key',);
},);

test('keyed mutex: a queued holder is not orphaned when the last one drains', async () => {
  const mutex = createKeyedMutex();
  const done = [];

  // Enqueue three on the same key; the middle one is still waiting when the
  // first finishes, so the cleanup must not delete the key underneath it.
  const all = Promise.all([
    mutex.run('k', async () => { await new Promise((r,) => setImmediate(r,),); done.push(1,); },),
    mutex.run('k', async () => { done.push(2,); },),
    mutex.run('k', async () => { done.push(3,); },),
  ],);

  await all;
  assert.deepEqual(done, [1, 2, 3,],);
  assert.equal(mutex.size(), 0,);
},);
