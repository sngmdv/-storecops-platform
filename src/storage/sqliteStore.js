'use strict';

/**
 * SQLite persistence adapter — production-grade.
 *
 * Implements the same async collection interface as the in-memory store
 * (insert / findById / find / findOne / update / updateMany / deleteMany /
 *  count / clear) so the whole platform can swap storage with a config flag.
 *
 * Built on Node's native node:sqlite — zero external dependencies.
 *
 * Optimizations vs. v1:
 *  - WHERE clause push-down for common field equality filters
 *  - JSON extraction columns for indexed fields (store_id, status, etc.)
 *  - Composite indexes for multi-tenant queries
 *  - Batch operations (insertMany, updateMany, deleteMany)
 */

const fs = require('fs',);
const path = require('path',);
const crypto = require('crypto',);
const { DatabaseSync, } = require('node:sqlite',);
const { COLLECTIONS, } = require('./store',);

/**
 * Fields that are commonly filtered on and benefit from extracted
 * columns + indexes.  Stored as top-level TEXT columns alongside
 * the JSON blob for fast WHERE clause matching.
 *
 * NOTE: every field listed here gets a column on EVERY table. Keep it to
 * fields that are genuinely cross-cutting. A field that only matters for one
 * collection belongs in EXTRA_INDEXED_FIELDS_BY_COLLECTION below.
 */
const INDEXED_FIELDS = ['store_id', 'status', 'customer_id', 'type', 'action',];

/**
 * Fields that need a column + index only in a specific collection.
 *
 * `sessions.token` is the important one. `auth.verify` runs
 * `store.sessions.findOne({ token })` on EVERY authenticated request, and
 * `token` was not an indexed field — so `buildWhereClause` returned null, the
 * query fell through to `allStmt.all().map(parse)`, and each request loaded and
 * JSON-parsed the ENTIRE sessions table before filtering in JavaScript. That
 * cost grows linearly with the number of logged-in sessions, i.e. it degrades
 * exactly as the product succeeds.
 *
 * It is scoped per-collection rather than added to INDEXED_FIELDS because no
 * other collection has a `token` column, and the common list is applied to
 * every table.
 */
const EXTRA_INDEXED_FIELDS_BY_COLLECTION = {
  sessions: ['token',],
  // Every inbound Shopify webhook looks up its signed-body digest, both to bind
  // the delivery to a tenant and to deduplicate Shopify's retries. Without a
  // column + index, `buildWhereClause({ digest })` returns null and the lookup
  // falls through to `allStmt.all().map(parse)` — a full table load plus
  // JSON.parse on a path that runs once per order. The table grows with order
  // volume, so that cost grows exactly as the merchant succeeds.
  //
  // `bucket` is the UTC day the delivery was received. Digest rows expire after
  // 24h and are swept by whole day, so that sweep has to be an equality match on
  // an indexed column too — a `find({})` sweep would be the very full scan the
  // digest index exists to avoid, and it would run on a timer.
  webhookDeliveries: ['digest', 'bucket',],
};

/** Every indexed field for one collection: the common set plus any extras. */
function indexedFieldsFor(name,) {
  return [...INDEXED_FIELDS, ...(EXTRA_INDEXED_FIELDS_BY_COLLECTION[name] || []),];
}

/**
 * Indexes created with a name that predates the loop below. `createdAt` maps to
 * the `_created` suffix, so these are created explicitly to avoid leaving the
 * old index in place and adding a duplicate under a new name.
 */
const EXPLICIT_INDEXES = [
  ['store_id', 'store_id',],
  ['status', 'status',],
  ['customer_id', 'customer_id',],
  ['type', 'type',],
  ['createdAt', 'created',],
];

/** Every column the current code expects on a collection table. */
function expectedColumns(name,) {
  return ['_id', 'createdAt', 'updatedAt', ...indexedFieldsFor(name,), 'data',];
}

/**
 * Reconcile an existing table with the columns the current schema expects.
 *
 * `CREATE TABLE IF NOT EXISTS` silently no-ops on a table created by an
 * older version, which previously left collections missing their `data`
 * column and broke every prepared statement at boot. Adding the missing
 * columns preserves existing rows.
 */
function migrateTable(db, name,) {
  const fields = indexedFieldsFor(name,);
  const present = new Set(
    db.prepare(`PRAGMA table_info("${name}")`,).all().map((col,) => col.name,),
  );

  for (const column of expectedColumns(name,)) {
    if (present.has(column,)) continue;
    db.exec(`ALTER TABLE "${name}" ADD COLUMN "${column}" TEXT`,);
  }

  // Backfill indexed columns for rows written before they existed, so
  // pre-existing data stays queryable. JSON1 ships with node:sqlite, but
  // a missing extension must never take the platform down on boot.
  try {
    const assignments = fields.map(
      (f,) => `"${f}" = json_extract(data, '$.${f}')`,
    ).join(', ',);
    db.exec(
      `UPDATE "${name}" SET ${assignments}
         WHERE data IS NOT NULL
           AND "store_id" IS NULL
           AND json_extract(data, '$.store_id') IS NOT NULL`,
    );
  } catch {
    /* JSON1 unavailable — rows stay unindexed but readable. */
  }
}

/** Fail loudly with a clear message instead of letting statements throw later. */
function assertSchema(db, name,) {
  const present = new Set(
    db.prepare(`PRAGMA table_info("${name}")`,).all().map((col,) => col.name,),
  );
  const missing = expectedColumns(name,).filter((c,) => !present.has(c,),);
  if (missing.length > 0) {
    throw new Error(
      `SQLite collection "${name}" is missing column(s): ${missing.join(', ',)}. ` +
        'Delete the database file to rebuild it, or add a migration.',
    );
  }
}

function createSqliteCollection(db, name,) {
  const fields = indexedFieldsFor(name,);

  db.exec(
    `CREATE TABLE IF NOT EXISTS "${name}" (
       _id TEXT PRIMARY KEY,
       createdAt TEXT,
       updatedAt TEXT,
       ${fields.map((f,) => `"${f}" TEXT`,).join(', ',)},
       data TEXT NOT NULL
     )`,
  );

  migrateTable(db, name,);
  assertSchema(db, name,);

  /* ── Indexes ─────────────────────────────────────────────────── */
  // Explicit first, to preserve the historical index names (`createdAt` is
  // indexed as `_created`). Then any field not covered above.
  const covered = new Set();
  for (const [field, suffix,] of EXPLICIT_INDEXES) {
    if (!fields.includes(field,)) continue;
    db.exec(`CREATE INDEX IF NOT EXISTS "idx_${name}_${suffix}" ON "${name}" ("${field}")`,);
    covered.add(field,);
  }
  // `action` was in INDEXED_FIELDS — so it got a column and a WHERE-clause
  // pushdown — but no index was ever created for it, which meant SQLite still
  // scanned the whole table and filtered. Looping over the field list closes
  // that gap and prevents the next one.
  for (const field of fields) {
    if (covered.has(field,)) continue;
    db.exec(`CREATE INDEX IF NOT EXISTS "idx_${name}_${field}" ON "${name}" ("${field}")`,);
  }

  /* ── Prepared statements ─────────────────────────────────────── */
  const insertStmt = db.prepare(
    `INSERT INTO "${name}" (_id, createdAt, updatedAt, ${fields.join(', ',)}, data) VALUES (?, ?, ?, ${fields.map(() => '?',).join(', ',)}, ?)`,
  );
  const byIdStmt = db.prepare(`SELECT data FROM "${name}" WHERE _id = ?`,);
  const allStmt = db.prepare(`SELECT data FROM "${name}"`,);
  const updateStmt = db.prepare(
    `UPDATE "${name}" SET data = ?, updatedAt = ?, ${fields.map((f,) => `"${f}" = ?`,).join(', ',)} WHERE _id = ?`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`,);
  const deleteStmt = db.prepare(`DELETE FROM "${name}" WHERE _id = ?`,);
  const deleteAllStmt = db.prepare(`DELETE FROM "${name}"`,);

  const parse = (row,) => (row ? JSON.parse(row.data,) : null);

  function extractIndexed(doc,) {
    return fields.map((f,) => doc[f] || null,);
  }

  /**
   * Build a WHERE clause from a plain-object filter when all keys
   * are indexed fields.  Returns { sql, params } or null when the
   * filter can't be pushed down.
   */
  function buildWhereClause(filter,) {
    const entries = Object.entries(filter,);
    if (!entries.length) return null;

    const indexed = entries.filter(([k,],) => fields.includes(k,),);
    if (indexed.length === 0) return null;

    const conditions = indexed.map(([k,],) => `"${k}" = ?`,);
    const params = indexed.map(([, v,],) => v,);
    return { sql: ` WHERE ${conditions.join(' AND ',)}`, params, };
  }

  return {
    name,

    async insert(doc,) {
      const record = {
        _id: doc._id || crypto.randomUUID(),
        createdAt: doc.createdAt || new Date().toISOString(),
        ...doc,
      };
      const idx = extractIndexed(record,);
      insertStmt.run(record._id, record.createdAt, record.updatedAt || null, ...idx, JSON.stringify(record,),);
      return record;
    },

    async insertMany(docs,) {
      const results = [];
      for (const doc of docs) {
        results.push(await this.insert(doc,),);
      }
      return results;
    },

    async findById(id,) {
      return parse(byIdStmt.get(id,),);
    },

    /**
     * Object filters: indexed fields use WHERE clause, non-indexed
     * fields filter in JS after load.  Function predicates always
     * load all rows and filter in JS.
     */
    async find(filter = {},) {
      if (typeof filter === 'function') {
        return allStmt.all().map(parse,).filter(filter,);
      }

      const entries = Object.entries(filter,);
      if (entries.length === 0) {
        return allStmt.all().map(parse,);
      }

      const where = buildWhereClause(filter,);
      const nonIndexed = entries.filter(([k,],) => !fields.includes(k,),);

      let rows;
      if (where) {
        const stmt = db.prepare(`SELECT data FROM "${name}"${where.sql}`,);
        rows = stmt.all(...where.params,).map(parse,);
      } else {
        rows = allStmt.all().map(parse,);
      }

      if (nonIndexed.length > 0) {
        rows = rows.filter((record,) =>
          nonIndexed.every(([key, value,],) => record[key] === value,),
        );
      }

      return rows;
    },

    async findOne(filter = {},) {
      const matches = await this.find(filter,);
      return matches[0] || null;
    },

    async update(id, patch,) {
      const existing = parse(byIdStmt.get(id,),);
      if (!existing) return null;

      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString(), };
      const idx = extractIndexed(updated,);
      updateStmt.run(JSON.stringify(updated,), updated.updatedAt, ...idx, id,);
      return updated;
    },

    async updateMany(filter, patch,) {
      const matches = await this.find(filter,);
      const results = [];
      for (const doc of matches) {
        const updated = { ...doc, ...patch, updatedAt: new Date().toISOString(), };
        const idx = extractIndexed(updated,);
        updateStmt.run(JSON.stringify(updated,), updated.updatedAt, ...idx, doc._id,);
        results.push(updated,);
      }
      return results;
    },

    async delete(id,) {
      deleteStmt.run(id,);
    },

    async deleteMany(filter,) {
      if (typeof filter === 'function') {
        const all = allStmt.all().map(parse,).filter(filter,);
        for (const doc of all) {
          deleteStmt.run(doc._id,);
        }
        return all.length;
      }

      const entries = Object.entries(filter,);
      if (entries.length === 0) {
        const n = countStmt.get().n;
        deleteAllStmt.run();
        return n;
      }

      const where = buildWhereClause(filter,);
      if (where) {
        const stmt = db.prepare(`DELETE FROM "${name}"${where.sql}`,);
        const result = stmt.run(...where.params,);
        return result.changes;
      }

      const matches = await this.find(filter,);
      for (const doc of matches) {
        deleteStmt.run(doc._id,);
      }
      return matches.length;
    },

    async count(filter,) {
      if (!filter || Object.keys(filter,).length === 0) {
        return Number(countStmt.get().n,);
      }

      const where = buildWhereClause(filter,);
      if (where) {
        const stmt = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"${where.sql}`,);
        return Number(stmt.get(...where.params,).n,);
      }

      return (await this.find(filter,)).length;
    },

    async clear() {
      db.exec(`DELETE FROM "${name}"`,);
    },
  };
}

/**
 * How long SQLite waits for a competing writer before giving up with
 * SQLITE_BUSY. Overridable with `SQLITE_BUSY_TIMEOUT_MS`.
 *
 * Without this, any lock contention fails the statement instantly — and nothing
 * in the write path retries, so the merchant sees a 500. The realistic
 * contenders are the scheduled backup (`scripts/backup.js` runs `VACUUM INTO`
 * against this same file) and any second app instance. WAL already stops
 * readers from blocking a writer, so this is about writer-vs-writer only.
 *
 * THE TRADE-OFF IS SPECIFIC TO `node:sqlite`: `DatabaseSync` is synchronous, so
 * the waiting happens ON the event loop. A generous timeout therefore converts
 * a fast, localised failure into a stall of the entire server — every request,
 * not just the one that hit the lock. 5s is SQLite's conventional default and
 * long enough to ride out a backup, but it is a ceiling, not a target. The real
 * answer to sustained write contention is a single writer, not a longer wait.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Build the full store facade over a SQLite file. The parent
 * directory is created on demand so a fresh checkout just works.
 */
function createSqliteStore(dbPath = 'data/storecops.db',) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath,),), { recursive: true, },);
  const db = new DatabaseSync(dbPath,);
  db.exec('PRAGMA journal_mode = WAL',);
  db.exec('PRAGMA synchronous = NORMAL',);
  db.exec('PRAGMA cache_size = -64000',); /* 64 MB page cache */
  db.exec('PRAGMA temp_store = MEMORY',);

  const busyTimeoutMs = Number(process.env.SQLITE_BUSY_TIMEOUT_MS,) || DEFAULT_BUSY_TIMEOUT_MS;
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`,);

  const store = { db, path: dbPath, };
  for (const name of COLLECTIONS) store[name] = createSqliteCollection(db, name,);

  /**
   * Graceful shutdown (OBS-001). Closing the handle is what lets the process
   * exit and flushes the write-ahead log; an abrupt exit leaves that work to the
   * next open. Never throws — a handle that is already closed must not block
   * shutdown.
   */
  store.close = async () => {
    try {
      db.close();
      return { ok: true, backend: 'sqlite', path: dbPath, };
    } catch (err) {
      return { ok: false, backend: 'sqlite', path: dbPath, error: err.message, };
    }
  };

  /**
   * Readiness probe (DEP-003). Runs a real query rather than reporting a cached
   * flag: a closed handle, a corrupt file, or a database that has become
   * read-only all throw on use while any "is open" boolean would still say yes.
   * Never throws — the caller wants a verdict it can act on, and the failure
   * reason is more useful in the response than in an exception.
   */
  store.ping = async () => {
    try {
      const row = db.prepare('SELECT 1 AS ok',).get();
      return { ok: row?.ok === 1, backend: 'sqlite', path: dbPath, };
    } catch (err) {
      return { ok: false, backend: 'sqlite', path: dbPath, error: err.message, };
    }
  };

  return store;
}

module.exports = {
  createSqliteStore,
  // Exported so the guard test can assert that every indexed field actually
  // has a matching index — the invariant that silently broke for `action`.
  INDEXED_FIELDS,
  EXTRA_INDEXED_FIELDS_BY_COLLECTION,
  indexedFieldsFor,
};
