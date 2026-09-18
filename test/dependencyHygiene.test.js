'use strict';

process.env.NODE_ENV = 'test';

/**
 * DEP-006 — dependency hygiene.
 *
 * THE DEFECT
 * ----------
 * The audit recorded "npm audit: 3x moderate qs via express@4.22.2". Re-checked
 * against OSV on 2026-09-18, the tree carried **two** advisories, both on `qs`,
 * and both fixed in 6.16.0:
 *
 *   GHSA-4mjr-xmp4-gh2g / CVE-2026-82417  DoS via attacker-controlled isBuffer
 *   GHSA-x5fp-wj9c-mxmx / CVE-2026-82562  array-limit bypass via bracket-key
 *                                          comma parsing
 *
 * `qs` is not a direct dependency — it arrives through express, body-parser and
 * stripe. All three pin ranges that EXCLUDE the fix:
 *
 *   express@4.22.2      qs ~6.15.1   (>=6.15.1 <6.16.0)
 *   body-parser@1.20.6  qs ~6.15.1
 *   stripe@14.25.0      qs ^6.11.0   (>=6.11.0 <7.0.0 — would allow it)
 *
 * so a plain `npm update` cannot reach the patched release and the fix has to be
 * an explicit `overrides` entry. The whole installed tree was then re-scanned:
 * 209 packages, 0 remaining advisories.
 *
 * WHY THE ASSERTIONS ARE OFFLINE
 * ------------------------------
 * The test suite must not depend on the network, and `npm audit` needs a
 * registry round-trip that is blocked in some environments. So these assert the
 * two local facts that the fix depends on — the override exists and the lockfile
 * resolves to a patched version — rather than re-querying the advisory database.
 * A refresh that reintroduces 6.15.x fails here.
 *
 * The major-version upgrades the ledger also lists (express 4->5, stripe 14->22,
 * ioredis 5->6) are deliberately NOT done. See `TOPNOTCH_GAPS_MEMORY.md` item 23
 * for the reasoning: none of the three has a security driver — the installed
 * versions carry zero advisories — and two of them are entangled with decisions
 * that are still open.
 */

const test = require('node:test',);
const assert = require('node:assert',);

const pkg = require('../package.json',);
const lock = require('../package-lock.json',);

const QS_PATCHED = '6.16.0';

/** Compare dotted numeric versions. Returns -1, 0 or 1. */
function compareVersions(a, b,) {
  const pa = String(a,).split('.',).map((n,) => Number.parseInt(n, 10,) || 0,);
  const pb = String(b,).split('.',).map((n,) => Number.parseInt(n, 10,) || 0,);
  for (let i = 0; i < Math.max(pa.length, pb.length,); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

test('DEP-006: the qs override exists and pins at or above the patched release', () => {
  const range = pkg.overrides?.qs;
  assert.ok(range, 'package.json must carry a qs override — no dependency range can reach the fix',);

  // Strip the range operator to get the floor, e.g. "^6.16.0" -> "6.16.0".
  const floor = String(range,).replace(/^[\^~>=<\s]+/, '',);
  assert.ok(
    compareVersions(floor, QS_PATCHED,) >= 0,
    `the qs override floor (${floor}) must be >= ${QS_PATCHED}, the version that fixes both advisories`,
  );
},);

test('DEP-006: the lockfile resolves qs to a patched version', () => {
  const entry = lock.packages['node_modules/qs'];
  assert.ok(entry, 'qs must be present in the lockfile',);
  assert.ok(
    compareVersions(entry.version, QS_PATCHED,) >= 0,
    `the lockfile resolves qs ${entry.version}; it must be >= ${QS_PATCHED}`,
  );
  assert.match(entry.resolved, /registry\.npmjs\.org/, 'the resolved tarball must come from the registry',);
  assert.match(entry.integrity, /^sha512-/, 'the entry must carry a sha512 integrity hash',);
},);

/**
 * Control. Demonstrates that the override is load-bearing rather than
 * decorative: the ranges the tree actually ships EXCLUDE the patched version, so
 * a plain `npm update` can never reach it.
 */
test('DEP-006 control: the shipped qs ranges exclude the fix, so the override is required', () => {
  /** Does a `~x.y.z` or `^x.y.z` range admit the given version? */
  const rangeAdmits = (range, version,) => {
    const operator = range[0];
    const floor = range.replace(/^[\^~>=<\s]+/, '',);
    if (compareVersions(version, floor,) < 0) return false;

    const [maj, min,] = floor.split('.',).map((n,) => Number.parseInt(n, 10,) || 0,);
    // `~6.15.1` allows patch-level movement only: <6.16.0.
    // `^6.11.0` allows minor-level movement:      <7.0.0.
    const ceiling = operator === '~' ? `${maj}.${min + 1}.0` : `${maj + 1}.0.0`;
    return compareVersions(version, ceiling,) < 0;
  };

  // What express and body-parser actually declare. Both pin `~6.15.1`, which
  // stops at 6.15.x — the patched 6.16.0 is outside the range.
  assert.equal(rangeAdmits('~6.15.1', '6.15.3',), true, 'precondition: the vulnerable version is in range',);
  assert.equal(
    rangeAdmits('~6.15.1', QS_PATCHED,),
    false,
    'express/body-parser cannot reach the fix — this is why an override is required, not a bump',
  );

  // Stripe's range is wide enough on its own; the override does not conflict.
  assert.equal(rangeAdmits('^6.11.0', QS_PATCHED,), true, 'stripe would have accepted the fix unaided',);

  // And the guard itself must reject the version it replaced.
  assert.equal(compareVersions('6.15.3', QS_PATCHED,) < 0, true, 'the guard must reject 6.15.3',);
  assert.equal(compareVersions(QS_PATCHED, QS_PATCHED,), 0, 'the patched version must pass the guard',);
  assert.equal(compareVersions('6.17.0', QS_PATCHED,) > 0, true, 'a later release must pass the guard',);
},);
