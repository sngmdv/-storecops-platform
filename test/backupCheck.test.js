'use strict';

/**
 * Backup freshness alarm.
 *
 * `scripts/backup.js` takes the snapshot; this asserts one was actually taken
 * recently. Uses a temp dir with controlled mtimes so the three states —
 * missing, stale, fresh — are each pinned, plus the filename filter (only
 * `storecops-*.db` counts).
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs',);
const os = require('node:os',);
const path = require('node:path',);

const { checkBackups, } = require('../scripts/backup-check',);

function touch(dir, name, ageHours,) {
  const full = path.join(dir, name,);
  fs.writeFileSync(full, 'x',);
  const t = new Date(Date.now() - ageHours * 3600000,);
  fs.utimesSync(full, t, t,);
  return full;
}

test('no snapshots is a failure, not a pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-',),);
  try {
    const r = checkBackups(dir, 48,);
    assert.strictEqual(r.ok, false,);
    assert.strictEqual(r.status, 'missing',);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, },);
  }
},);

test('a snapshot older than the limit fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-',),);
  try {
    touch(dir, 'storecops-old.db', 72,);
    const r = checkBackups(dir, 48,);
    assert.strictEqual(r.ok, false,);
    assert.strictEqual(r.status, 'stale',);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, },);
  }
},);

test('a fresh snapshot passes and non-snapshot files are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-',),);
  try {
    touch(dir, 'notes.txt', 0.01,);
    touch(dir, 'storecops-stale.db', 72,);
    touch(dir, 'storecops-new.db', 1,);
    const r = checkBackups(dir, 48,);
    assert.strictEqual(r.ok, true,);
    assert.strictEqual(r.status, 'fresh',);
    assert.ok(r.line.includes('storecops-new.db',),);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, },);
  }
},);
