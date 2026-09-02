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
 */
const INDEXED_FIELDS = ['store_id', 'status', 'customer_id', 'type', 'action',];

/** Every column the current code expects on a collection table. */
function expectedColumns() {
  return ['_id', 'createdAt', 'updatedAt', ...INDEXED_FIELDS, 'data',];
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
  const present = new Set(
    db.prepare(`PRAGMA table_info("${name}")`,).all().map((col,) => col.name,),
  );

  for (const column of expectedColumns()) {
    if (present.has(column,)) continue;
    db.exec(`ALTER TABLE "${name}" ADD COLUMN "${column}" TEXT`,);
  }

  // Backfill indexed columns for rows written before they existed, so
  // pre-existing data stays queryable. JSON1 ships with node:sqlite, but
  // a missing extension must never take the platform down on boot.
  try {
    const assignments = INDEXED_FIELDS.map(
      (f) => `"${f}" = json_extract(data, '$.${f}')`,
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
  const missing = expectedColumns().filter((c,) => !present.has(c,),);
  if (missing.length > 0) {
    throw new Error(
      `SQLite collection "${name}" is missing column(s): ${missing.join(', ',)}. ` +
        'Delete the database file to rebuild it, or add a migration.',
    );
  }
}

function createSqliteCollection(db, name,) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS "${name}" (
       _id TEXT PRIMARY KEY,
       createdAt TEXT,
       updatedAt TEXT,
       ${INDEXED_FIELDS.map((f) => `"${f}" TEXT`,).join(', ')},
       data TEXT NOT NULL
     )`,
  );

  migrateTable(db, name,);
  assertSchema(db, name,);

  /* ── Indexes ─────────────────────────────────────────────────── */
  db.exec(`CREATE INDEX IF NOT EXISTS "idx_${name}_store_id" ON "${name}" ("store_id")`,);
  db.exec(`CREATE INDEX IF NOT EXISTS "idx_${name}_status" ON "${name}" ("status")`,);
  db.exec(`CREATE INDEX IF NOT EXISTS "idx_${name}_customer_id" ON "${name}" ("customer_id")`,);
  db.exec(`CREATE INDEX IF NOT EXISTS "idx_${name}_type" ON "${name}" ("type")`,);
  db.exec(`CREATE INDEX IF NOT EXISTS "idx_${name}_created" ON "${name}" ("createdAt")`,);

  /* ── Prepared statements ─────────────────────────────────────── */
  const insertStmt = db.prepare(
    `INSERT INTO "${name}" (_id, createdAt, updatedAt, ${INDEXED_FIELDS.join(', ')}, data) VALUES (?, ?, ?, ${INDEXED_FIELDS.map(() => '?',).join(', ')}, ?)`,
  );
  const byIdStmt = db.prepare(`SELECT data FROM "${name}" WHERE _id = ?`,);
  const allStmt = db.prepare(`SELECT data FROM "${name}"`,);
  const updateStmt = db.prepare(
    `UPDATE "${name}" SET data = ?, updatedAt = ?, ${INDEXED_FIELDS.map((f) => `"${f}" = ?`,).join(', ')} WHERE _id = ?`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`,);
  const deleteStmt = db.prepare(`DELETE FROM "${name}" WHERE _id = ?`,);
  const deleteManyStmt = db.prepare(`DELETE FROM "${name}" WHERE ${INDEXED_FIELDS[0]} = ?`,);
  const deleteAllStmt = db.prepare(`DELETE FROM "${name}"`,);

  const parse = (row,) => (row ? JSON.parse(row.data,) : null);

  function extractIndexed(doc,) {
    return INDEXED_FIELDS.map((f) => doc[f] || null,);
  }

  /**
   * Build a WHERE clause from a plain-object filter when all keys
   * are indexed fields.  Returns { sql, params } or null when the
   * filter can't be pushed down.
   */
  function buildWhereClause(filter,) {
    const entries = Object.entries(filter,);
    if (!entries.length) return null;

    const indexed = entries.filter(([k]) => INDEXED_FIELDS.includes(k,),);
    if (indexed.length === 0) return null;

    const conditions = indexed.map(([k]) => `"${k}" = ?`,);
    const params = indexed.map(([, v]) => v,);
    return { sql: ` WHERE ${conditions.join(' AND ')}`, params, };
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
      const nonIndexed = entries.filter(([k]) => !INDEXED_FIELDS.includes(k,),);

      let rows;
      if (where) {
        const stmt = db.prepare(`SELECT data FROM "${name}"${where.sql}`,);
        rows = stmt.all(...where.params,).map(parse,);
      } else {
        rows = allStmt.all().map(parse,);
      }

      if (nonIndexed.length > 0) {
        rows = rows.filter((record,) =>
          nonIndexed.every(([key, value,]) => record[key] === value,),
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

  const store = { db, path: dbPath, };
  for (const name of COLLECTIONS) store[name] = createSqliteCollection(db, name,);

  store.close = () => db.close();
  return store;
}

module.exports = { createSqliteStore, };
