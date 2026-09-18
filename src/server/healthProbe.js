'use strict';

/**
 * Readiness probe and build identity (DEP-003 / DEP-007).
 *
 * THE DEFECT
 * ----------
 * `/health` returned `{ status: 'ok' }` unconditionally — no dependency check of
 * any kind — and `railway.json` pointed its `healthcheckPath` at it. Railway
 * therefore promoted a deploy and kept routing traffic to it even when the
 * storage backend was unreachable. A health check that cannot fail is not a
 * health check; it is a constant.
 *
 * Separately, build metadata was a `BUILD_TIME` build arg in `railway.json`
 * hardcoded to the literal `2026-09-12T14:20:00Z`. That was worse than absent:
 * it looked like build metadata, it never changed, and the Dockerfile never even
 * declared the `ARG`, so nothing consumed it. Every deploy would have reported
 * the same fictional build time. The commit SHA is what actually identifies a
 * build, and Railway exposes it.
 *
 * WHY THE PROBE IS NOT A DIRECTORY LISTING
 * ----------------------------------------
 * Each storage adapter implements `ping()`. Reaching into adapter internals from
 * the server layer (`store.db.prepare(...)`, `store._client.ping()`) would
 * couple the two and would silently stop working the day an adapter is swapped —
 * the same failure shape as the duplicated `COLLECTIONS` list. The probe asks a
 * question the adapter answers; `test/storageParity.test.js` asserts all three
 * adapters can answer it.
 */

const UNKNOWN = 'unknown';

/**
 * Build identity.
 *
 * `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_GIT_BRANCH`, `RAILWAY_DEPLOYMENT_ID` and
 * `RAILWAY_ENVIRONMENT_NAME` are provided by Railway to both builds and
 * deployments (https://docs.railway.com/variables/reference). Each falls back to
 * `unknown` rather than to a placeholder that could be mistaken for real data.
 *
 * `built_at` is nullable on purpose: if the build did not supply a timestamp,
 * saying so is better than inventing one.
 */
function getBuildInfo(env = process.env,) {
  return {
    commit: env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT_SHA || UNKNOWN,
    branch: env.RAILWAY_GIT_BRANCH || UNKNOWN,
    deployment_id: env.RAILWAY_DEPLOYMENT_ID || UNKNOWN,
    environment: env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || UNKNOWN,
    built_at: env.BUILD_TIME || null,
  };
}

/**
 * Durability warnings — deliberately NOT readiness failures.
 *
 * `STORAGE=sqlite` on an ephemeral filesystem serves every request perfectly
 * until the next restart, at which point it loses every merchant's data. That is
 * invisible in testing and it is a deploy-time setting, not a code defect, so it
 * must be surfaced without taking the instance out of rotation.
 */
function durabilityWarnings(config, env = process.env,) {
  const warnings = [];
  const storage = String(config?.storage || env.STORAGE || '',).toLowerCase();

  if (storage === 'sqlite' && !env.RAILWAY_VOLUME_MOUNT_PATH) {
    warnings.push(
      'STORAGE=sqlite but RAILWAY_VOLUME_MOUNT_PATH is unset — the database sits on an ' +
      'ephemeral filesystem and will be lost on the next deploy or restart.',
    );
  }

  return warnings;
}

function createHealthProbe({ store, config, } = {},) {
  const startedAt = Date.now();

  return {
    build: getBuildInfo(),

    /**
     * @returns {Promise<{ready: boolean, status: string, components: object,
     *   warnings: string[], uptime_ms: number, time: string}>}
     */
    async check() {
      const components = {};
      let ready = true;

      // Fail closed. An adapter that cannot be probed is not evidence of health,
      // and answering "ready" for an unverifiable dependency is exactly how a
      // broken instance stays in the load balancer. All three adapters implement
      // `ping()`, so this branch is a guard, not an expected path.
      if (typeof store?.ping !== 'function') {
        components.storage = { ok: false, error: 'storage adapter does not implement ping()', };
        ready = false;
      } else {
        components.storage = await store.ping();
        if (components.storage?.ok !== true) ready = false;
      }

      return {
        ready,
        status: ready ? 'ready' : 'not_ready',
        components,
        warnings: durabilityWarnings(config,),
        uptime_ms: Date.now() - startedAt,
        time: new Date().toISOString(),
      };
    },
  };
}

module.exports = { createHealthProbe, getBuildInfo, durabilityWarnings, };
