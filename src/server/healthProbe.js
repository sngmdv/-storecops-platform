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

/** How long `ping()` may take before readiness is refused. A readiness probe
 * must answer within a bound: the orchestrator's own timeout is the fallback,
 * and it fires with no diagnostic at all.
 *
 * Overridable via `config.security.readinessPingTimeoutMs`
 * (`READINESS_PING_TIMEOUT_MS`) because the correct value depends on deployment
 * topology — a local SQLite file answers in microseconds, a remote Redis across
 * a region boundary does not — and because the bound is only meaningful while it
 * stays *inside* `railway.json`'s `healthcheckTimeout`. */
const DEFAULT_PING_TIMEOUT_MS = 2000;

/**
 * Resolve the effective bound.
 *
 * Only a positive finite number is accepted. `Number('')` is 0 and `Number('abc')`
 * is NaN; both are misconfiguration, and for a readiness probe the safe reading of
 * a misconfigured bound is the default, not "zero" — a zero bound would fail every
 * probe instantly and take a healthy instance out of rotation, which is a worse
 * outcome than ignoring the setting.
 */
function resolvePingTimeoutMs(explicit, configured,) {
  // A `for` head is grouping parens, so no trailing comma after the iterable.
  for (const candidate of [explicit, configured,]) {
    const value = Number(candidate,);
    if (Number.isFinite(value,) && value > 0) return value;
  }
  return DEFAULT_PING_TIMEOUT_MS;
}

/**
 * Probe storage without ever throwing and without ever hanging. Both matter.
 *
 * Express 4 does not catch a rejected async handler — `Layer.handle_request`
 * only wraps a *synchronous* call — so a throw here would leave the request
 * unanswered **and** raise an unhandled rejection, which terminates the
 * process by default. And a `ping()` that never settles (a blackholed host, an
 * ioredis command queued behind a reconnect) would hold `/ready` open until the
 * caller gave up, which is exactly the failure the probe exists to report.
 *
 * The adapters each promise never to throw, but that is a convention in a
 * comment, not a contract this module can rely on.
 */
async function probeStorage(store, timeoutMs,) {
  let timer;
  try {
    const expired = new Promise((resolve,) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: `ping() did not settle within ${timeoutMs}ms`, },),
        timeoutMs,
      );
      // A pending probe must not by itself keep the process alive.
      if (typeof timer.unref === 'function') timer.unref();
    },);
    // `Promise.resolve().then(...)` converts a *synchronous* throw into a
    // rejection, so the catch below covers both throwing styles.
    return await Promise.race([Promise.resolve().then(() => store.ping(),), expired,],);
  } catch (error) {
    return { ok: false, error: error?.message || String(error,), };
  } finally {
    clearTimeout(timer,);
  }
}

function createHealthProbe({ store, config, pingTimeoutMs, } = {},) {
  const startedAt = Date.now();
  const timeoutMs = resolvePingTimeoutMs(pingTimeoutMs, config?.security?.readinessPingTimeoutMs,);

  return {
    build: getBuildInfo(),
    // Exposed so an operator reading `/ready` can see which bound the probe
    // actually used, rather than inferring it from the response latency.
    pingTimeoutMs: timeoutMs,

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
        components.storage = await probeStorage(store, timeoutMs,);
        if (components.storage?.ok !== true) ready = false;
      }

      return {
        ready,
        status: ready ? 'ready' : 'not_ready',
        components,
        warnings: durabilityWarnings(config,),
        // Surfaced in the payload so a `not_ready` caused by the bound is
        // self-describing: without it the reader cannot tell a slow backend from
        // an unreachable one.
        ping_timeout_ms: timeoutMs,
        uptime_ms: Date.now() - startedAt,
        time: new Date().toISOString(),
      };
    },
  };
}

module.exports = {
  createHealthProbe,
  getBuildInfo,
  durabilityWarnings,
  resolvePingTimeoutMs,
  DEFAULT_PING_TIMEOUT_MS,
};
