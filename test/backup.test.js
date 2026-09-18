'use strict';

/**
 * Tests for the backup tooling.
 *
 * These run against a small scratch database rather than the real one, so they
 * stay fast. The behaviour that matters: a snapshot must be complete and
 * restorable, verification must actually fail when something is missing, and
 * pruning must keep the newest snapshots rather than the oldest.
 */

const { describe, it, beforeEach, afterEach, } = require('node:test',);
const assert = require('node:assert/strict',);
const fs = require('node:fs',);
const os = require('node:os',);
const path = require('node:path',);
const { DatabaseSync, } = require('node:sqlite',);

const { vacuumInto, verifyBackup, listBackups, pruneBackups, } = require('../scripts/backup',);

let dir;

/** Build a small two-table database and return its path. */
function makeDb(rows = 3,) {
  const dbPath = path.join(dir, 'source.db',);
  const db = new DatabaseSync(dbPath,);
  db.exec('CREATE TABLE things (_id TEXT PRIMARY KEY, data TEXT NOT NULL)',);
  db.exec('CREATE TABLE others (_id TEXT PRIMARY KEY, data TEXT NOT NULL)',);
  const stmt = db.prepare('INSERT INTO things (_id, data) VALUES (?, ?)',);
  for (let i = 0; i < rows; i++) stmt.run(`id${i}`, JSON.stringify({ i, },),);
  db.close();
  return dbPath;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storecops-backup-test-',),);
},);

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, },);
},);

describe('backup: vacuumInto', () => {
  it('produces a complete, readable copy', () => {
    const dbPath = makeDb(5,);
    const dest = path.join(dir, 'snap.db',);

    vacuumInto(dbPath, dest,);

    assert.ok(fs.existsSync(dest,),);

    const db = new DatabaseSync(dest, { readOnly: true, },);
    try {
      const tables = db
        .prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name',)
        .all()
        .map((r,) => r.name,);
      assert.deepEqual(tables, ['others', 'things',],);
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM things',).get().n,), 5,);
    } finally {
      db.close();
    }
  },);

  it('refuses to overwrite an existing snapshot', () => {
    const dbPath = makeDb();
    const dest = path.join(dir, 'snap.db',);
    vacuumInto(dbPath, dest,);

    assert.throws(() => vacuumInto(dbPath, dest,), 'SQLite must not silently overwrite a snapshot',);
  },);
},);

describe('backup: verifyBackup', () => {
  it('passes for a faithful copy', () => {
    const dbPath = makeDb(4,);
    const dest = path.join(dir, 'snap.db',);
    vacuumInto(dbPath, dest,);

    const result = verifyBackup(dbPath, dest,);

    assert.equal(result.ok, true, `expected ok, got errors: ${result.errors.join('; ',)}`,);
    assert.equal(result.errors.length, 0,);
    assert.equal(result.counts.things, 4,);
  },);

  it('fails when the snapshot is missing a table', () => {
    const dbPath = makeDb(2,);
    const dest = path.join(dir, 'snap.db',);
    vacuumInto(dbPath, dest,);

    // Corrupt the snapshot by dropping a table the source still has.
    const db = new DatabaseSync(dest,);
    db.exec('DROP TABLE others',);
    db.close();

    const result = verifyBackup(dbPath, dest,);

    assert.equal(result.ok, false, 'verification must not pass when a table is missing',);
    assert.ok(
      result.errors.some((e,) => e.includes('missing table',),),
      `expected a missing-table error, got: ${result.errors.join('; ',)}`,
    );
  },);

  it('fails when the snapshot is not a database', () => {
    const dbPath = makeDb();
    const bogus = path.join(dir, 'bogus.db',);
    fs.writeFileSync(bogus, 'this is not a sqlite file',);

    const result = verifyBackup(dbPath, bogus,);

    assert.equal(result.ok, false,);
    assert.ok(result.errors.length > 0,);
  },);
},);

describe('backup: pruneBackups', () => {
  it('keeps the newest snapshots and removes the rest', () => {
    const outDir = path.join(dir, 'backups',);
    fs.mkdirSync(outDir, { recursive: true, },);

    // Distinct mtimes so ordering is deterministic.
    for (let i = 0; i < 5; i++) {
      const file = path.join(outDir, `storecops-2026-01-0${i + 1}.db`,);
      fs.writeFileSync(file, `snapshot ${i}`,);
      const when = new Date(2026, 0, i + 1,);
      fs.utimesSync(file, when, when,);
    }

    assert.equal(listBackups(outDir,).length, 5,);

    const removed = pruneBackups(outDir, 2,);

    assert.equal(removed.length, 3,);
    const remaining = listBackups(outDir,).map((s,) => s.name,);
    assert.deepEqual(
      remaining,
      ['storecops-2026-01-04.db', 'storecops-2026-01-05.db',],
      'pruning must keep the newest snapshots, not the oldest',
    );
  },);

  it('removes nothing when under the limit', () => {
    const outDir = path.join(dir, 'backups',);
    fs.mkdirSync(outDir, { recursive: true, },);
    fs.writeFileSync(path.join(outDir, 'storecops-2026-01-01.db',), 'x',);

    assert.deepEqual(pruneBackups(outDir, 7,), [],);
    assert.equal(listBackups(outDir,).length, 1,);
  },);
},);
