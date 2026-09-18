'use strict';

process.env.NODE_ENV = 'test';

/**
 * SQLite index coverage (DB-005).
 *
 * WHAT WAS WRONG
 * --------------
 * Two separate gaps, both invisible because every test runs on the in-memory
 * adapter, where "indexes" are meaningless.
 *
 * 1. `action` was listed in `INDEXED_FIELDS`, so it got an extracted column and
 *    a WHERE-clause pushdown — but the five explicit `CREATE INDEX` statements
 *    never covered it. SQLite therefore still scanned the whole table and
 *    filtered afterwards, paying the cost of the pushdown without its benefit.
 *
 * 2. `sessions.token` was not an indexed field at all. `auth.verify` runs
 *    `store.sessions.findOne({ token })` on EVERY authenticated request;
 *    `buildWhereClause` returned null for it, so the query fell through to
 *    `allStmt.all().map(parse)` and each request loaded and JSON-parsed the
 *    entire sessions table. That is linear in the number of logged-in sessions
 *    — it degrades exactly as the product succeeds.
 *
 * THE INVARIANT THIS PINS
 * -----------------------
 * Every field that gets a column and a WHERE pushdown must also have an index.
 * The guard derives the expectation from the adapter's own field list, so
 * adding a field to `INDEXED_FIELDS` without an index fails the test.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('fs',);
const os = require('os',);
const path = require('path',);

const {
  createSqliteStore,
  indexedFieldsFor,
} = require('../src/storage/sqliteStore',);
const { COLLECTIONS, } = require('../src/storage/store',);

/** Open a throwaway SQLite store; the real data/storecops.db is never touched. */
function withTempStore(fn,) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storecops-idx-',),);
  const store = createSqliteStore(path.join(dir, 'idx.db',),);
  try {
    return fn(store,);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, },);
  }
}

/** Columns actually covered by an index on `table`. */
function indexedColumns(store, table,) {
  const covered = new Set();
  for (const index of store.db.prepare(`PRAGMA index_list("${table}")`,).all()) {
    for (const col of store.db.prepare(`PRAGMA index_info("${index.name}")`,).all()) {
      covered.add(col.name,);
    }
  }
  return covered;
}

/** The query plan SQLite would use for a single-column equality lookup. */
function planFor(store, table, column,) {
  const rows = store.db
    .prepare(`EXPLAIN QUERY PLAN SELECT data FROM "${table}" WHERE "${column}" = ?`,)
    .all('probe',);
  return rows.map((r,) => r.detail,).join(' | ',);
}

test('DB-005: every indexed field has an index — no field gets a pushdown without one', () => {
  withTempStore((store,) => {
    const missing = [];
    // A representative spread: the collection with extras, one with a large
    // expected row count, and one that had no index for `action`.
    for (const table of ['sessions', 'events', 'customers', 'actions', 'returns',]) {
      const covered = indexedColumns(store, table,);
      for (const field of indexedFieldsFor(table,)) {
        if (!covered.has(field,)) missing.push(`${table}.${field}`,);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `fields with a column and WHERE pushdown but no index:\n${missing.join('\n',)}`,
    );
  },);
},);

test('DB-005: `action` is indexed, not merely pushed down', () => {
  withTempStore((store,) => {
    // Regression for the specific gap: `action` was in INDEXED_FIELDS but the
    // explicit CREATE INDEX list omitted it.
    for (const table of ['events', 'actions',]) {
      const covered = indexedColumns(store, table,);
      assert.ok(
        covered.has('action',),
        `${table}.action must be indexed — it is pushed into the WHERE clause`,
      );
    }
  },);
},);

test('DB-005: the sessions token lookup uses an index, not a full scan', () => {
  withTempStore((store,) => {
    const plan = planFor(store, 'sessions', 'token',);
    assert.ok(
      plan.includes('idx_sessions_token',),
      `the per-request session lookup must use its index; plan was: ${plan}`,
    );
    assert.ok(
      !/\bSCAN\b/.test(plan,),
      `the session lookup must not scan the table; plan was: ${plan}`,
    );
  },);
},);

test('DB-005: store_id lookups use their index on every collection', () => {
  withTempStore((store,) => {
    const failures = [];
    for (const table of COLLECTIONS) {
      const plan = planFor(store, table, 'store_id',);
      if (!plan.includes(`idx_${table}_store_id`,)) {
        failures.push(`${table}: ${plan}`,);
      }
    }
    assert.deepEqual(failures, [], `collections without an indexed store_id lookup:\n${failures.join('\n',)}`,);
  },);
},);

/**
 * Control. If `planFor` could not tell a scan from a seek, the assertions above
 * would pass regardless. `updatedAt` has a column but deliberately no index, so
 * it is a real scan to compare against.
 */
test('DB-005 control: the plan reader distinguishes a SCAN from an index SEARCH', () => {
  withTempStore((store,) => {
    const unindexed = planFor(store, 'events', 'updatedAt',);
    assert.ok(
      /\bSCAN\b/.test(unindexed,),
      `an unindexed column must report SCAN, otherwise the index assertions are vacuous; plan was: ${unindexed}`,
    );
  },);
},);

test('DB-005 control: the index-coverage check detects a planted missing index', () => {
  withTempStore((store,) => {
    // Drop a real index and confirm the coverage check would notice.
    store.db.exec('DROP INDEX "idx_events_action"',);
    const covered = indexedColumns(store, 'events',);
    assert.ok(
      !covered.has('action',),
      'dropping the index must be observable — otherwise the coverage guard proves nothing',
    );
    assert.ok(
      indexedFieldsFor('events',).includes('action',),
      'and the adapter still declares the field, so the mismatch is detectable',
    );
  },);
},);
