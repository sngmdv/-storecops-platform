'use strict';

/**
 * SQLite backup — consistent hot copy, verified, with retention.
 *
 * WHY THIS EXISTS
 * ---------------
 * The production database was a single 139 MB file on an ephemeral Railway
 * filesystem with no copy anywhere. `STORAGE=sqlite` plus a missing volume means
 * a restart can wipe it, and there was no `VACUUM INTO`, `.backup()` or
 * `pg_dump` call anywhere in the repo.
 *
 * `VACUUM INTO` is used rather than a file copy because it is safe to run
 * against a live database: it takes a consistent snapshot including any
 * committed WAL content, and cannot capture a torn page. A plain `cp` of a WAL
 * database can produce a corrupt or stale copy.
 *
 * Usage:
 *   node scripts/backup.js                 # back up, verify, prune
 *   node scripts/backup.js --keep 14       # retain 14 snapshots
 *   node scripts/backup.js --out <dir>     # custom destination
 *   node scripts/backup.js --no-prune
 *
 * Exit codes: 0 success, 1 failure (safe to use in a deploy hook).
 */

const fs = require('node:fs',);
const path = require('node:path',);
const { DatabaseSync, } = require('node:sqlite',);

const DEFAULT_DB = process.env.SQLITE_PATH || 'data/storecops.db';
const DEFAULT_OUT = process.env.BACKUP_DIR || 'data/backups';
const DEFAULT_KEEP = Number(process.env.BACKUP_KEEP || 7,);

/** Resolve the live database path. */
function resolveDbPath(dbPath,) {
  return path.resolve(dbPath || DEFAULT_DB,);
}

/** Filesystem-safe UTC timestamp for snapshot filenames. */
function stamp(date = new Date(),) {
  return date.toISOString().replace(/[:.]/g, '-',);
}

/** Escape a value for interpolation into a SQL string literal. */
function sqlLiteral(value,) {
  return `'${String(value,).replace(/'/g, "''",)}'`;
}

/**
 * Take a consistent snapshot of `dbPath` into `destPath`.
 * The destination must not already exist — SQLite refuses to overwrite.
 */
function vacuumInto(dbPath, destPath,) {
  fs.mkdirSync(path.dirname(destPath,), { recursive: true, },);

  const db = new DatabaseSync(dbPath,);
  try {
    // VACUUM INTO cannot run inside a transaction and requires a fresh path.
    db.exec(`VACUUM INTO ${sqlLiteral(path.resolve(destPath,).replace(/\\/g, '/',),)}`,);
  } finally {
    db.close();
  }

  return destPath;
}

/** Table names in a database, excluding SQLite internals. */
function tableNames(db,) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",)
    .all()
    .map((row,) => row.name,);
}

/** Row count per table. */
function tableCounts(db,) {
  const counts = {};
  for (const name of tableNames(db,)) {
    try {
      counts[name] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n,);
    } catch {
      counts[name] = -1;
    }
  }
  return counts;
}

/** Open a database read-only when supported, falling back to a normal open. */
function openForRead(dbPath,) {
  try {
    return new DatabaseSync(dbPath, { readOnly: true, },);
  } catch {
    return new DatabaseSync(dbPath,);
  }
}

/**
 * Verify a snapshot is a structurally valid, complete copy of the source.
 * Returns { ok, errors, warnings, counts }.
 */
function verifyBackup(dbPath, backupPath,) {
  const errors = [];
  const warnings = [];
  const fail = (message,) => {
    errors.push(message,);
    return { ok: false, errors, warnings, counts: {}, };
  };

  let backup;
  try {
    backup = openForRead(backupPath,);
  } catch (error) {
    return fail(`backup is not readable: ${error.message}`,);
  }

  let source = null;
  try {
    // Opening a file that is not a SQLite database can succeed lazily, so the
    // first real read is where a bogus file surfaces. That must be *reported*,
    // not thrown — a verification step that throws is useless in a deploy hook.
    let verdict = 'unknown';
    try {
      const integrity = backup.prepare('PRAGMA integrity_check',).get();
      verdict = integrity ? Object.values(integrity,)[0] : 'unknown';
    } catch (error) {
      return fail(`backup is not a readable SQLite database: ${error.message}`,);
    }
    if (verdict !== 'ok') errors.push(`integrity_check returned "${verdict}"`,);

    let backupTables;
    let backupCounts;
    try {
      backupTables = tableNames(backup,);
      backupCounts = tableCounts(backup,);
    } catch (error) {
      return fail(`could not enumerate the backup's tables: ${error.message}`,);
    }

    try {
      source = openForRead(dbPath,);
    } catch (error) {
      warnings.push(`could not open the source for comparison: ${error.message}`,);
    }

    if (!source) {
      return { ok: errors.length === 0, errors, warnings, counts: backupCounts, };
    }

    const sourceTables = tableNames(source,);
    const missing = sourceTables.filter((t,) => !backupTables.includes(t,),);
    if (missing.length > 0) {
      errors.push(`backup is missing table(s): ${missing.join(', ',)}`,);
    }

    const sourceCounts = tableCounts(source,);
    let drift = 0;
    for (const [name, count,] of Object.entries(sourceCounts,)) {
      if (backupCounts[name] === undefined) continue;
      if (backupCounts[name] !== count) drift++;
    }
    if (drift > 0) {
      // Expected when the app keeps writing during the backup — not a defect.
      warnings.push(
        `${drift} table(s) differ from the live database. Normal if the app is ` +
          'still writing; a snapshot is point-in-time, not a live mirror.',
      );
    }

    return { ok: errors.length === 0, errors, warnings, counts: backupCounts, };
  } catch (error) {
    return fail(`unexpected verification error: ${error.message}`,);
  } finally {
    try {
      if (source) source.close();
    } catch {
      /* already closed */
    }
    try {
      backup.close();
    } catch {
      /* already closed */
    }
  }
}

/** List snapshots in `dir`, newest last. */
function listBackups(dir,) {
  if (!fs.existsSync(dir,)) return [];
  return fs
    .readdirSync(dir,)
    .filter((name,) => name.startsWith('storecops-',) && name.endsWith('.db',))
    .map((name,) => {
      const full = path.join(dir, name,);
      return { name, path: full, size: fs.statSync(full,).size, mtime: fs.statSync(full,).mtimeMs, };
    },)
    .sort((a, b,) => a.mtime - b.mtime,);
}

/** Delete all but the newest `keep` snapshots. Returns the removed paths. */
function pruneBackups(dir, keep,) {
  const snapshots = listBackups(dir,);
  if (snapshots.length <= keep) return [];
  const doomed = snapshots.slice(0, snapshots.length - keep,);
  for (const snap of doomed) fs.rmSync(snap.path, { force: true, },);
  return doomed.map((s,) => s.path,);
}

function parseArgs(argv,) {
  const args = { keep: DEFAULT_KEEP, out: DEFAULT_OUT, db: DEFAULT_DB, prune: true, };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') args.keep = Number(argv[++i],);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--db') args.db = argv[++i];
    else if (arg === '--no-prune') args.prune = false;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2,),);
  const dbPath = resolveDbPath(args.db,);
  const outDir = path.resolve(args.out,);

  if (!fs.existsSync(dbPath,)) {
    console.error(`[backup] FAIL — no database at ${dbPath}`,);
    console.error('[backup] Set SQLITE_PATH, or pass --db <path>.',);
    process.exit(1,);
  }

  const sizeMb = (fs.statSync(dbPath,).size / 1024 / 1024).toFixed(1,);
  console.log(`[backup] source ${dbPath} (${sizeMb} MB)`,);

  const destPath = path.join(outDir, `storecops-${stamp()}.db`,);

  try {
    vacuumInto(dbPath, destPath,);
  } catch (error) {
    console.error(`[backup] FAIL — VACUUM INTO failed: ${error.message}`,);
    process.exit(1,);
  }

  const result = verifyBackup(dbPath, destPath,);
  const outMb = (fs.statSync(destPath,).size / 1024 / 1024).toFixed(1,);
  const tableCount = Object.keys(result.counts,).length;

  for (const warning of result.warnings) console.warn(`[backup] WARN — ${warning}`,);

  if (!result.ok) {
    console.error(`[backup] FAIL — verification failed:`,);
    for (const error of result.errors) console.error(`  - ${error}`,);
    process.exit(1,);
  }

  console.log(`[backup] OK — ${destPath} (${outMb} MB, ${tableCount} tables verified)`,);

  if (args.prune) {
    const removed = pruneBackups(outDir, args.keep,);
    if (removed.length > 0) {
      console.log(`[backup] pruned ${removed.length} snapshot(s), keeping ${args.keep}`,);
    }
  }

  console.log('[backup] Run `npm run backup:verify` to rehearse a restore.',);
}

if (require.main === module) main();

module.exports = {
  resolveDbPath,
  vacuumInto,
  verifyBackup,
  listBackups,
  pruneBackups,
  tableNames,
  tableCounts,
  openForRead,
};
