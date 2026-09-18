'use strict';

process.env.NODE_ENV = 'test';

/**
 * Environment-file precedence (DEP-001).
 *
 * THE DEFECT
 * ----------
 * `server.js` loaded `.env.production` first and `.env` only when the first
 * attempt THREW — and `process.loadEnvFile` throws when a file is absent. So
 * whenever both files existed, `.env` was never read. `npm start` then ran with
 * production settings against the production database, and every `.env` override
 * was silently ignored: editing `.env` changed nothing, which reads to a
 * developer as "this variable is not used" rather than "another file won".
 *
 * The fix selects the file from NODE_ENV instead of from which file happens to
 * exist, and names the chosen file in the log so the precedence is never a guess.
 *
 * The `load` injection point is what makes this testable at all; the logic used
 * to be inline in `server.js`, which binds a port at module scope and is
 * therefore unreachable from a test.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs');
const path = require('node:path');

const { loadEnvironment, resolveEnvFiles, } = require('../src/config/loadEnvironment',);

/** A loader that only accepts the named files, recording every attempt. */
function loaderAccepting(available,) {
  const attempts = [];
  const load = (file,) => {
    attempts.push(file,);
    if (!available.includes(file,)) throw new Error(`ENOENT: ${file}`,);
  };
  return { load, attempts, };
}

/** Swallow the module's log lines, keeping them for assertions. */
function recordingLog() {
  const lines = [];
  return {
    lines,
    log: (m,) => lines.push(m,),
    warn: (m,) => lines.push(m,),
  };
}

// ── The ordering rule itself ────────────────────────────────────────────────

test('production prefers .env.production and falls back to .env', () => {
  assert.deepStrictEqual(resolveEnvFiles('production',), ['.env.production', '.env',],);
});

test('every other mode reads .env ONLY — never .env.production', () => {
  for (const mode of ['development', 'test', 'staging', '', undefined, null,]) {
    assert.deepStrictEqual(
      resolveEnvFiles(mode,),
      ['.env',],
      `NODE_ENV=${String(mode)} must not consider .env.production`,
    );
  }
});

// ── The regression: both files present, non-production ──────────────────────

test('with BOTH files present, a non-production run loads .env and never touches .env.production', () => {
  const { load, attempts, } = loaderAccepting(['.env.production', '.env',],);
  const logger = recordingLog();

  const result = loadEnvironment({ env: { NODE_ENV: 'development', }, load, log: logger, },);

  assert.deepStrictEqual(
    attempts,
    ['.env',],
    'the old code read .env.production first and never reached .env — that is the bug',
  );
  assert.strictEqual(result.loaded, '.env',);
  assert.ok(
    logger.lines.some((l,) => l.includes('.env',)),
    'the chosen file must be named in the log, so an ignored override is diagnosable',
  );
});

test('an unset NODE_ENV is treated as development, not as production', () => {
  const { load, attempts, } = loaderAccepting(['.env.production', '.env',],);
  const logger = recordingLog();

  const result = loadEnvironment({ env: {}, load, log: logger, },);

  assert.deepStrictEqual(attempts, ['.env',], 'an unset mode must not select the production file',);
  assert.strictEqual(result.loaded, '.env',);
});

// ── Production ──────────────────────────────────────────────────────────────

test('production loads .env.production and does not read .env when it succeeds', () => {
  const { load, attempts, } = loaderAccepting(['.env.production', '.env',],);
  const logger = recordingLog();

  const result = loadEnvironment({ env: { NODE_ENV: 'production', }, load, log: logger, },);

  assert.deepStrictEqual(attempts, ['.env.production',],);
  assert.strictEqual(result.loaded, '.env.production',);
});

test('production falls back to .env when .env.production is absent', () => {
  const { load, attempts, } = loaderAccepting(['.env',],);
  const logger = recordingLog();

  const result = loadEnvironment({ env: { NODE_ENV: 'production', }, load, log: logger, },);

  assert.deepStrictEqual(attempts, ['.env.production', '.env',],);
  assert.strictEqual(result.loaded, '.env',);
});

test('with no env file at all it says so and uses the process environment', () => {
  // The normal container case: .dockerignore excludes .env*, so the platform's
  // injected variables are all there is.
  const { load, } = loaderAccepting([],);
  const logger = recordingLog();

  const result = loadEnvironment({ env: { NODE_ENV: 'production', }, load, log: logger, },);

  assert.strictEqual(result.loaded, null,);
  assert.ok(
    logger.lines.some((l,) => l.includes('using the process environment',)),
    'silence here is how "why is my variable ignored" becomes an afternoon',
  );
});

test('control: the fake loader really does throw for absent files', () => {
  // Without this, `loaderAccepting([])` could be a no-op and every "falls back"
  // assertion above would pass for the wrong reason.
  const { load, attempts, } = loaderAccepting(['.env',],);
  assert.throws(() => load('.env.production',), /ENOENT/,);
  assert.deepStrictEqual(attempts, ['.env.production',],);
});

// ── The invariant that keeps the fix working ────────────────────────────────

test('server.js loads the environment before requiring anything that reads it', () => {
  // `src/config/config.js` reads process.env at import time and runs the
  // production readiness gate there, so moving this call below the requires
  // would silently revert the fix: the file would load after config was built.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js',), 'utf8',);

  const loadAt = src.indexOf('loadEnvironment();',);
  const platformAt = src.indexOf('require("./src/platform")',);
  const createAppAt = src.indexOf('require("./src/server/createApp")',);

  assert.ok(loadAt >= 0, 'server.js must call loadEnvironment()',);
  assert.ok(platformAt >= 0 && createAppAt >= 0, 'the expected requires must still be present',);
  assert.ok(
    loadAt < platformAt && loadAt < createAppAt,
    'loadEnvironment() must run before src/platform is required, or the loaded values '
      + 'arrive too late to be read',
  );
});
