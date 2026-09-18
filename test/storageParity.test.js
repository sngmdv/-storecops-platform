'use strict';

process.env.NODE_ENV = 'test';

/**
 * Storage adapter parity (DB-004).
 *
 * THE DEFECT
 * ----------
 * `src/storage/store.js` owns the schema: a `COLLECTIONS` array that every
 * adapter must expose. `sqliteStore.js` imports it. `redisStore.js` used to
 * carry its own copy under a comment reading "same as store.js" — and it had
 * drifted in BOTH directions:
 *
 *   missing (6): supportTickets, marketingSpend, featureUsage, returns,
 *                returnAuditLog, passwordResets
 *   phantom (4): referrals, referralCredits, affiliateLinks, trials
 *
 * On `STORAGE=redis` a missing collection means `store.returns` is `undefined`,
 * and the failure modes are inconsistent:
 *
 *   - `returnService.js:29` does `store.returns.insert(...)` with no optional
 *     chaining  -> TypeError, the Returns & Fraud Shield is broken outright.
 *   - `auth.requestPasswordReset` -> `store.passwordResets.insert` -> TypeError,
 *     password reset is broken outright.
 *   - `supportTicketService.js:40` uses `store.supportTickets?.insert` -> the
 *     ticket is silently discarded, while line 84 reads it unguarded and throws.
 *   - `privacy.js` does `if (!collection) continue`, so a shop/redact quietly
 *     reports success while six collections were never touched.
 *
 * That last one is the dangerous one: a silent, partial GDPR purge. Nothing in
 * the suite could see any of this because every test runs on the in-memory
 * adapter, which derives its collections from `store.js`.
 *
 * The fix is the same shape as the P1 privacy fix: one source of truth, derived
 * rather than duplicated. This test is the guard.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('fs',);
const os = require('os',);
const path = require('path',);

const { createStore, COLLECTIONS, } = require('../src/storage/store',);
const redisStore = require('../src/storage/redisStore',);
const { createSqliteStore, } = require('../src/storage/sqliteStore',);
const { purgeStoreData, } = require('../src/server/privacy',);

test('DB-004: redisStore exposes exactly the schema collections, with no local copy', () => {
  assert.deepEqual(
    redisStore.COLLECTIONS,
    COLLECTIONS,
    'redisStore.js must derive COLLECTIONS from store.js — a second list will drift again',
  );

  // Belt and braces: identity, not merely equal contents. If redisStore kept a
  // copy that happened to match today, `assert.deepEqual` would pass but the
  // drift risk would remain.
  assert.equal(
    redisStore.COLLECTIONS,
    COLLECTIONS,
    'redisStore must reference the same array instance, not a matching copy',
  );
},);

test('DB-004: every adapter builds a store exposing every schema collection', async () => {
  // In-memory.
  const memory = createStore();
  const missingMemory = COLLECTIONS.filter((name,) => !memory[name],);
  assert.deepEqual(missingMemory, [], 'the in-memory store is missing collections',);

  // SQLite, against a throwaway file so the real data/storecops.db is untouched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storecops-parity-',),);
  const dbPath = path.join(dir, 'parity.db',);
  const sqlite = createSqliteStore(dbPath,);
  try {
    const missingSqlite = COLLECTIONS.filter((name,) => !sqlite[name],);
    assert.deepEqual(missingSqlite, [], 'the SQLite store is missing collections',);

    // And no phantom collections beyond the schema plus known non-collection keys.
    const extras = Object.keys(sqlite,)
      .filter((k,) => !COLLECTIONS.includes(k,),)
      .filter((k,) => !['db', 'path', 'close', 'ping', '_client', '_isRedis',].includes(k,),);
    assert.deepEqual(extras, [], 'the SQLite store exposes collections not in the schema',);
  } finally {
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true, },);
  }
},);

/**
 * Control. This is the failure mode the parity guard exists to prevent, and it
 * is worth pinning down because it is SILENT: no error is thrown, the purge
 * reports success, and the rows simply remain.
 */
test('DB-004 control: a missing collection makes a GDPR purge skip it silently', async () => {
  const store = createStore();
  await store.events.insert({ store_id: 'A', event_type: 'x', },);
  await store.returns.insert({ store_id: 'A', customer_id: 'c1', },);
  await store.supportTickets.insert({ store_id: 'A', customer_id: 'c1', },);

  // Simulate the old Redis adapter: `returns` and `supportTickets` were never
  // created, so they are `undefined` on the store.
  delete store.returns;
  delete store.supportTickets;

  const result = await purgeStoreData(store, 'A',);

  // No throw, and the report looks clean — `returns`/`supportTickets` do not
  // even appear, so an operator has no signal that anything was skipped.
  assert.ok(result.total_deleted > 0, 'the purge still deletes what it can find',);
  assert.equal(
    result.deleted.returns,
    undefined,
    'a collection the adapter never created is skipped without appearing in the report',
  );
  assert.equal(
    result.preserved.purgeable,
    undefined,
    'the report does not enumerate skipped collections — this is why parity must be a test',
  );
},);

test('DB-004 control: the parity assertion detects a planted drift', () => {
  // Proves the comparison in the first test is not vacuous: a list with one
  // collection removed must fail a deepEqual against the schema.
  const drifted = COLLECTIONS.filter((name,) => name !== 'returns',);
  assert.notDeepEqual(
    drifted,
    COLLECTIONS,
    'removing a collection must be detected — otherwise the parity guard proves nothing',
  );
  assert.equal(drifted.length, COLLECTIONS.length - 1,);
},);

/**
 * `ping()` parity — the invariant the `/ready` endpoint depends on (DEP-003).
 *
 * `healthProbe.js` fails closed when the adapter cannot be probed, so an adapter
 * missing `ping()` would take the whole instance out of rotation rather than
 * fail silently. That is the right failure direction, but it means a missing
 * `ping()` is a deploy-blocking bug — so it is asserted here instead of being
 * discovered in production.
 */
test('DEP-003: every adapter implements ping() and reports its backend', async () => {
  const memory = createStore();
  const memoryResult = await memory.ping();
  assert.equal(memoryResult.ok, true,);
  assert.equal(memoryResult.backend, 'memory',);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storecops-ping-',),);
  const dbPath = path.join(dir, 'ping.db',);
  const sqlite = createSqliteStore(dbPath,);

  try {
    const sqliteResult = await sqlite.ping();
    assert.equal(sqliteResult.ok, true,);
    assert.equal(sqliteResult.backend, 'sqlite',);
    assert.equal(sqliteResult.path, dbPath,);

    // A closed handle must report not-ready rather than throwing. This is the
    // case a cached "is open" flag would have got wrong.
    sqlite.close();
    const closed = await sqlite.ping();
    assert.equal(closed.ok, false, 'a closed database must not report ready',);
    assert.ok(closed.error, 'the failure reason must be reported, not swallowed',);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, },);
  }
},);

/**
 * `close()` parity — the invariant graceful shutdown depends on (OBS-001).
 *
 * `lifecycle.js` calls `store.close()` when the adapter exposes it and skips it
 * otherwise, so a partial adapter cannot block shutdown. That skip is
 * deliberate — which is exactly why an adapter that *should* release a resource
 * must not quietly stop doing so. `sqliteStore` closing the handle is what lets
 * the process exit and flushes the write-ahead log, and `redisStore` holds an
 * open socket that would otherwise keep the event loop alive.
 */
test('OBS-001: every adapter implements close() and reports rather than throws', async () => {
  const memory = createStore();
  const memoryResult = await memory.close();
  assert.equal(memoryResult.ok, true,);
  assert.equal(memoryResult.backend, 'memory',);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storecops-close-',),);
  const dbPath = path.join(dir, 'close.db',);
  const sqlite = createSqliteStore(dbPath,);

  try {
    const first = await sqlite.close();
    assert.equal(first.ok, true,);
    assert.equal(first.backend, 'sqlite',);
    assert.equal(first.path, dbPath,);

    // Closing twice must report failure rather than throw: shutdown must never
    // be blocked by a handle that is already closed.
    const second = await sqlite.close();
    assert.equal(second.ok, false,);
    assert.match(second.error, /not open/i,);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, },);
  }
},);

/**
 * `count(filter)` parity — the same class of defect as the COLLECTIONS drift.
 *
 * `sqliteStore.count(filter)` pushes the filter into a WHERE clause. The
 * in-memory and Redis adapters accepted the argument and **ignored it**, always
 * returning the collection total. Nothing was visibly broken because every
 * caller passes `{}` or nothing at all, but the first caller to pass a real
 * filter would have received a silently wrong number on two of three adapters —
 * a wrong answer, not an error. Found while fixing PERF-001.
 */
test('DB-004: count(filter) agrees across the in-memory and SQLite adapters', async () => {
  const rows = [
    { store_id: 'A', event_type: 'purchase', },
    { store_id: 'A', event_type: 'view', },
    { store_id: 'B', event_type: 'purchase', },
  ];

  const memory = createStore();
  for (const row of rows) await memory.events.insert({ ...row, },);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storecops-count-',),);
  const dbPath = path.join(dir, 'count.db',);
  const sqlite = createSqliteStore(dbPath,);

  try {
    for (const row of rows) await sqlite.events.insert({ ...row, },);

    for (const store of [memory, sqlite,]) {
      const label = store === memory ? 'memory' : 'sqlite';

      assert.equal(await store.events.count(), 3, `${label}: unfiltered count`,);
      assert.equal(await store.events.count({},), 3, `${label}: empty filter means "all"`,);
      assert.equal(await store.events.count({ store_id: 'A', },), 2, `${label}: filtered count`,);
      assert.equal(await store.events.count({ store_id: 'B', },), 1, `${label}: filtered count`,);

      // The control. An adapter that ignored the filter would answer 3 here, so
      // this assertion is what distinguishes "honours the filter" from "returns
      // the total". Without it the test above could pass on a broken adapter
      // whenever the filter happened to match every row.
      assert.equal(
        await store.events.count({ store_id: 'NO_SUCH_STORE', },),
        0,
        `${label}: a non-matching filter must not fall back to the collection total`,
      );

      // And a non-indexed field must still filter correctly.
      assert.equal(await store.events.count({ event_type: 'purchase', },), 2, `${label}: non-indexed filter`,);
    }
  } finally {
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true, },);
  }
},);
