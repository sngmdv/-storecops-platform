'use strict';

/**
 * Environment-file loading (DEP-001), and the precedence rule that goes with it.
 *
 * THE DEFECT
 * ----------
 * This was inline in `server.js` and read:
 *
 *     try { process.loadEnvFile('.env.production'); }
 *     catch (_) { try { process.loadEnvFile('.env'); } catch (_) {} }
 *
 * `process.loadEnvFile` throws when the file is absent, so `.env` was only ever
 * read when `.env.production` was MISSING. Whenever both files existed — the
 * normal local setup — `.env` was never loaded at all. Two consequences, both
 * silent:
 *
 *   - `npm start` ran with production settings, including the production
 *     readiness gate and the production SQLite file. It is exactly how a
 *     developer first meets "Refusing to start with a misconfigured deployment"
 *     on their own machine.
 *   - Every override in `.env` was ignored. Editing it changed nothing, which is
 *     worse than not having the file: the developer concludes the variable is
 *     unread rather than that a different file won.
 *
 * It was also untestable where it stood — `server.js` binds a port at module
 * scope, so nothing in it is reachable from a test. Same reason `healthProbe`,
 * `growthScheduler` and `lifecycle` were extracted.
 *
 * PRECEDENCE, HIGHEST FIRST
 * -------------------------
 *   1. Variables already in `process.env` — Railway, Docker, a shell export.
 *      `process.loadEnvFile` never overwrites an existing variable, so a real
 *      injected value always wins over a file. This is what keeps a file from
 *      silently redefining a platform-supplied secret.
 *   2. The mode-appropriate file: `.env.production` under
 *      `NODE_ENV=production`, otherwise `.env`.
 *   3. `.env` as a fallback when `.env.production` is absent.
 *   4. Nothing — the injected environment is used on its own, which is the
 *      normal case in a container (`.dockerignore` excludes `.env*`).
 *
 * The file is selected from the NODE_ENV that is set *before* loading, so a
 * `.env` that itself sets `NODE_ENV=production` is honoured by the config layer
 * but does not change which file was read. That ordering is deliberate: reading
 * a file to discover which file to read cannot terminate.
 *
 * Node < 20.12 has no `process.loadEnvFile` and `dotenv` is not a dependency, so
 * on those versions no file is read. That used to happen in total silence; it now
 * says so.
 */

/**
 * Ordered env-file candidates for a given NODE_ENV. Pure, so it is directly
 * testable — the ordering IS the fix.
 *
 * @param {string} [nodeEnv]
 * @returns {string[]} highest priority first
 */
function resolveEnvFiles(nodeEnv,) {
  const mode = typeof nodeEnv === 'string' && nodeEnv.trim() !== '' ? nodeEnv.trim() : 'development';
  return mode === 'production' ? ['.env.production', '.env',] : ['.env',];
}

/** Load one file with Node's own loader, which throws when it is absent. */
function defaultLoad(file,) {
  process.loadEnvFile(file,);
}

/**
 * Load the environment, and report which file won.
 *
 * @param {object}   [options]
 * @param {object}   [options.env]   environment to read NODE_ENV from (tests)
 * @param {Function} [options.load]  loader(file) — overrides `process.loadEnvFile`
 * @param {object}   [options.log]   sink for the report lines
 * @returns {{loaded: string|null, viaDotenv: boolean, candidates: string[]}}
 */
function loadEnvironment({ env = process.env, load, log = console, } = {},) {
  const candidates = resolveEnvFiles(env.NODE_ENV,);
  const loader = load || (typeof process.loadEnvFile === 'function' ? defaultLoad : null);

  if (!loader) {
    let viaDotenv = false;
    try {
      require('dotenv',).config();
      viaDotenv = true;
    } catch {
      // dotenv is not installed — the common case, since it is not a dependency.
    }

    if (viaDotenv) {
      log.log('[BOOT] Loaded environment via dotenv (process.loadEnvFile is unavailable)',);
      return { loaded: 'dotenv', viaDotenv: true, candidates, };
    }

    log.warn?.(
      '[BOOT] No env-file support on this Node version (needs >= 20.12) and dotenv is ' +
      'not installed — configuration must come from the process environment.',
    );
    return { loaded: null, viaDotenv: false, candidates, };
  }

  for (const file of candidates) {
    try {
      loader(file,);
      // Naming the file matters: the previous version's precedence was invisible,
      // so an ignored override looked like an unread variable.
      log.log(`[BOOT] Loaded environment from ${file} (NODE_ENV=${env.NODE_ENV || 'unset'})`,);
      return { loaded: file, viaDotenv: false, candidates, };
    } catch {
      // Absent or unreadable — try the next candidate.
    }
  }

  log.log(
    `[BOOT] No env file found (tried ${candidates.join(', ',)}) — using the process environment`,
  );
  return { loaded: null, viaDotenv: false, candidates, };
}

module.exports = { loadEnvironment, resolveEnvFiles, };