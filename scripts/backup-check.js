'use strict';

/**
 * Backup freshness check — answers "is anything actually running the backup".
 *
 * `scripts/backup.js` takes a verified snapshot, but nothing schedules it, so
 * a deployment can go months with zero snapshots and nobody notices until the
 * first redeploy wipes the ephemeral filesystem. This script is the alarm:
 *
 *   node scripts/backup-check.js                  # BACKUP_DIR or data/backups
 *   node scripts/backup-check.js --dir <dir> --max-age-hours 48
 *
 * Exit 0 when the newest `storecops-*.db` snapshot is younger than the limit,
 * exit 1 otherwise (safe to use as a Railway cron command or an alert hook).
 * It never touches the live database — it only stats the snapshot directory —
 * so it is safe to run from anywhere, including CI.
 */

const fs = require('node:fs',);
const path = require('node:path',);

const DEFAULT_DIR = process.env.BACKUP_DIR || 'data/backups';
const DEFAULT_MAX_AGE_HOURS = Number(process.env.BACKUP_MAX_AGE_HOURS || 48,);

/** Newest snapshot in `dir`, or null when there is none. */
function newestBackup(dir,) {
  let names;
  try {
    names = fs.readdirSync(dir,);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    if (!name.startsWith('storecops-',) || !name.endsWith('.db',)) continue;
    const full = path.join(dir, name,);
    let stat;
    try {
      stat = fs.statSync(full,);
    } catch {
      continue;
    }
    if (!best || stat.mtimeMs > best.mtimeMs) best = { name, path: full, mtimeMs: stat.mtimeMs, size: stat.size, };
  }
  return best;
}

/** Pure evaluation: fresh / missing / stale, with a human line. */
function checkBackups(dir, maxAgeHours, nowMs = Date.now(),) {
  const newest = newestBackup(dir,);
  if (!newest) {
    return {
      ok: false,
      status: 'missing',
      line: `[backup-check] FAIL — no snapshots in ${dir}; schedule \`node scripts/backup.js\` (see SHOPIFY_SUBMISSION.md §3)`,
    };
  }
  const ageHours = (nowMs - newest.mtimeMs) / 3600000;
  if (ageHours > maxAgeHours) {
    return {
      ok: false,
      status: 'stale',
      line: `[backup-check] FAIL — newest snapshot ${newest.name} is ${ageHours.toFixed(1)}h old (limit ${maxAgeHours}h)`,
    };
  }
  return {
    ok: true,
    status: 'fresh',
    line: `[backup-check] OK — newest snapshot ${newest.name} is ${ageHours.toFixed(1)}h old`,
  };
}

function parseArgs(argv,) {
  const out = { dir: DEFAULT_DIR, maxAgeHours: DEFAULT_MAX_AGE_HOURS, };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      out.dir = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--max-age-hours' && argv[i + 1]) {
      out.maxAgeHours = Number(argv[i + 1],);
      i += 1;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2,),);
  const result = checkBackups(path.resolve(args.dir,), args.maxAgeHours,);
  console.log(result.line,);
  process.exit(result.ok ? 0 : 1,);
}

if (require.main === module) main();

module.exports = { newestBackup, checkBackups, parseArgs, };
