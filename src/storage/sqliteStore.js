"use strict";

/**
 * SQLite persistence adapter.
 *
 * Implements the exact same async collection interface as the
 * in-memory store (insert/findById/find/findOne/update/count/clear)
 * so the whole platform can swap storage with a config flag.
 * Built on Node's native node:sqlite — zero external dependencies.
 *
 * Documents are stored as JSON blobs keyed by _id; filtering happens
 * in JS after load, which keeps the adapter schema-less and lets it
 * honour function predicates exactly like the in-memory store does.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { COLLECTIONS } = require("./store");

function createSqliteCollection(db, name) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS "${name}" (
       _id TEXT PRIMARY KEY,
       createdAt TEXT,
       updatedAt TEXT,
       data TEXT NOT NULL
     )`
  );

  const insertStmt = db.prepare(
    `INSERT INTO "${name}" (_id, createdAt, updatedAt, data) VALUES (?, ?, ?, ?)`
  );
  const byIdStmt = db.prepare(`SELECT data FROM "${name}" WHERE _id = ?`);
  const allStmt = db.prepare(`SELECT data FROM "${name}"`);
  const updateStmt = db.prepare(
    `UPDATE "${name}" SET data = ?, updatedAt = ? WHERE _id = ?`
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`);

  const parse = (row) => (row ? JSON.parse(row.data) : null);

  return {
    name,

    async insert(doc) {
      const record = {
        _id: doc._id || crypto.randomUUID(),
        createdAt: doc.createdAt || new Date().toISOString(),
        ...doc,
      };
      insertStmt.run(record._id, record.createdAt, record.updatedAt || null, JSON.stringify(record));
      return record;
    },

    async findById(id) {
      return parse(byIdStmt.get(id));
    },

    /**
     * Same semantics as the in-memory store: plain-object filters
     * match on exact field equality; function filters receive each
     * record.
     */
    async find(filter = {}) {
      const all = allStmt.all().map(parse);

      if (typeof filter === "function") {
        return all.filter(filter);
      }

      return all.filter((record) =>
        Object.entries(filter).every(([key, value]) => record[key] === value)
      );
    },

    async findOne(filter = {}) {
      const matches = await this.find(filter);
      return matches[0] || null;
    },

    async update(id, patch) {
      const existing = parse(byIdStmt.get(id));
      if (!existing) return null;

      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      updateStmt.run(JSON.stringify(updated), updated.updatedAt, id);
      return updated;
    },

    async count() {
      return Number(countStmt.get().n);
    },

    async clear() {
      db.exec(`DELETE FROM "${name}"`);
    },
  };
}

/**
 * Build the full store facade over a SQLite file. The parent
 * directory is created on demand so a fresh checkout just works.
 */
function createSqliteStore(dbPath = "data/storecops.db") {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  const store = { db, path: dbPath };
  for (const name of COLLECTIONS) store[name] = createSqliteCollection(db, name);

  store.close = () => db.close();
  return store;
}

module.exports = { createSqliteStore };
