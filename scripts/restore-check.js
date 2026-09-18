'use strict';

/**
 * Restore rehearsal — prove a backup can actually be restored and used.
 *
 * WHY THIS EXISTS
 * ---------------
 * A backup that has never been restored is a hypothesis, not a safety net. The
 * platform previously had no backups at all, and the audit called out the
 * absence of a restore rehearsal specifically: an untested dump can be corrupt,
 * incomplete, or unreadable by the current code, and you only find out during an
 * incident.
 *
 * This script restores the newest snapshot into a scratch directory and opens it
 * through the *real* storage adapter (`createSqliteStore`). That is the important
 * part: it does not merely check the file is valid SQLite, it proves the current
 * schema migrations and prepared statements can operate on it.
 *
 * Usage:
 *   node scripts/restore-check.js                    # rehearse the newest snapshot
 *   node scripts/restore-check.js --file <path>      # rehearse a specific snapshot
 *   node scripts/restore-check.js --restore-to <p>   # leave a real restored copy at <p>
 *
 * Exit codes: 0 PASS, 1 FAIL.
 */

const fs = require('node:fs',);
const os = require('node:os',);
const path = require('node:path',);

const { listBackups, verifyBackup, tableCounts, openForRead, } = require('./backup',);
const { COLLECTIONS, } = require('../src/storage/store',);
const { createSqliteStore, } = require('../src/storage/sqliteStore',);

const DEFAULT_OUT = process.env.BACKUP_DIR || 'data/backups';

function parseArgs(argv,) {
  const args = { out: DEFAULT_OUT, file: null, restoreTo: null, };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') args.file = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--restore-to') args.restoreTo = argv[++i];
  }
  return args;
}

/** Copy a snapshot to a scratch path and return it. */
function stageCopy(snapshotPath, destPath,) {
  fs.mkdirSync(path.dirname(destPath,), { recursive: true, },);
  fs.copyFileSync(snapshotPath, destPath,);
  return destPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2,),);

  let snapshotPath = args.file;
  if (!snapshotPath) {
    const snapshots = listBackups(path.resolve(args.out,),);
    if (snapshots.length === 0) {
      console.error(`[restore] FAIL — no snapshots in ${path.resolve(args.out,)}`,);
      console.error('[restore] Run `npm run backup` first.',);
      process.exit(1,);
    }
    snapshotPath = snapshots[snapshots.length - 1].path;
  }

  snapshotPath = path.resolve(snapshotPath,);
  if (!fs.existsSync(snapshotPath,)) {
    console.error(`[restore] FAIL — snapshot not found: ${snapshotPath}`,);
    process.exit(1,);
  }

  const sizeMb = (fs.statSync(snapshotPath,).size / 1024 / 1024).toFixed(1,);
  console.log(`[restore] snapshot ${snapshotPath} (${sizeMb} MB)`,);

  const failures = [];

  // ── Step 1: structural verification against the live DB is not possible here
  // (the live DB may not exist on the machine doing the rehearsal), so verify
  // the snapshot against itself and rely on step 2 for schema compatibility.
  const structural = verifyBackup(snapshotPath, snapshotPath,);
  for (const warning of structural.warnings) console.warn(`[restore] WARN — ${warning}`,);

  let expectedCounts = {};
  try {
    const db = openForRead(snapshotPath,);
    try {
      const integrity = db.prepare('PRAGMA integrity_check',).get();
      const verdict = integrity ? Object.values(integrity,)[0] : 'unknown';
      if (verdict !== 'ok') failures.push(`integrity_check returned "${verdict}"`,);
      else console.log('[restore] OK — integrity_check passed',);
      expectedCounts = tableCounts(db,);
    } finally {
      db.close();
    }
  } catch (error) {
    failures.push(`snapshot is not readable: ${error.message}`,);
  }

  // ── Step 2: the real rehearsal — restore and open through the app's adapter.
  const scratch = args.restoreTo
    ? path.resolve(args.restoreTo,)
    : path.join(os.tmpdir(), `storecops-restore-${process.pid}-${Date.now()}.db`,);

  let restored = null;
  try {
    stageCopy(snapshotPath, scratch,);
    // A restored database must be openable by the *current* code, including its
    // migrations and prepared statements. This is what a rehearsal is for.
    restored = createSqliteStore(scratch,);
    console.log(`[restore] OK — restored copy opened by the current schema at ${scratch}`,);
  } catch (error) {
    failures.push(`restored copy could not be opened by the storage adapter: ${error.message}`,);
  }

  if (restored) {
    let totalRows = 0;
    const empty = [];
    for (const name of COLLECTIONS) {
      if (!restored[name]) {
        failures.push(`collection "${name}" is missing from the restored database`,);
        continue;
      }
      try {
        const count = await restored[name].count();
        totalRows += count;
        if (count === 0) empty.push(name,);
      } catch (error) {
        failures.push(`could not count "${name}": ${error.message}`,);
      }
    }

    // A snapshot with no rows anywhere is a backup of an empty database — worth
    // flagging loudly, because restoring it would silently lose everything.
    if (totalRows === 0) {
      failures.push('restored database contains 0 rows across every collection — this snapshot is empty',);
    } else {
      console.log(`[restore] OK — ${totalRows} rows readable across ${COLLECTIONS.length} collections`,);
    }

    if (empty.length > 0) {
      console.log(`[restore] note — ${empty.length} collection(s) empty (normal for unused features)`,);
    }

    restored.close();
  }

  // ── Clean up the scratch copy unless the caller asked to keep it.
  if (!args.restoreTo && fs.existsSync(scratch,)) {
    fs.rmSync(scratch, { force: true, },);
    // WAL sidecar files, if any.
    for (const suffix of ['-wal', '-shm',]) {
      const sidecar = scratch + suffix;
      if (fs.existsSync(sidecar,)) fs.rmSync(sidecar, { force: true, },);
    }
  }

  if (failures.length > 0) {
    console.error('\n[restore] FAIL — the backup is not restorable:',);
    for (const failure of failures) console.error(`  - ${failure}`,);
    process.exit(1,);
  }

  console.log('\n[restore] PASS — the snapshot restores and is readable by the current code.',);
  if (args.restoreTo) console.log(`[restore] restored copy left at ${scratch}`,);
}

main().catch((error,) => {
  console.error(`[restore] FAIL — ${error.stack || error.message}`,);
  process.exit(1,);
},);
