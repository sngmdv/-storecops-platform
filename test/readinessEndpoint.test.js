'use strict';

process.env.NODE_ENV = 'test';

/**
 * DEP-003 / DEP-007 — readiness and build identity.
 *
 * THE DEFECT
 * ----------
 * `/health` returned `{ status: 'ok' }` unconditionally, with no dependency
 * check of any kind, and `railway.json` pointed `healthcheckPath` at it. Railway
 * therefore promoted deploys and kept routing traffic to instances whose storage
 * backend was unreachable. A health check that cannot fail is not a health
 * check.
 *
 * Separately, build metadata was a `BUILD_TIME` build arg hardcoded in
 * `railway.json` to the literal `2026-09-12T14:20:00Z`, which no `ARG` in the
 * Dockerfile ever declared and which nothing in `src/` read. Every deploy would
 * have reported the same fictional build time.
 *
 * WHAT THESE TESTS PIN DOWN
 * -------------------------
 *   - `/health` stays 200 when storage is down. That is deliberate — it is the
 *     liveness probe, and a restart policy must not fire on a database blip —
 *     which is exactly why it must not be the deploy healthcheck.
 *   - `/ready` returns 503 in the same situation. Test 3 asserts both on ONE
 *     instance, so the pair cannot be satisfied by an endpoint that merely
 *     always returns 200.
 *   - `railway.json` points at `/ready`, so a silent revert is caught.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('fs',);
const path = require('path',);

const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);
const { createHealthProbe, getBuildInfo, durabilityWarnings, } = require('../src/server/healthProbe',);
const { createStore, } = require('../src/storage/store',);

const nodeFetch = globalThis.fetch;
const ROOT = path.join(__dirname, '..',);

function bootServer() {
  const platform = createPlatform();
  const app = createApp(platform,);
  return new Promise((resolve,) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port, } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        platform,
        close: () => new Promise((done,) => server.close(done,),),
      },);
    },);
  },);
}

// ── The endpoint pair ───────────────────────────────────────────────────────

test('DEP-003: /health is liveness and /ready is readiness — 503 apart on one instance', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    // Healthy: both answer, and /ready names the backend it verified.
    const health = await nodeFetch(`${base}/health`,);
    assert.equal(health.status, 200,);
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'ok',);

    const ready = await nodeFetch(`${base}/ready`,);
    assert.equal(ready.status, 200, 'a healthy instance must be ready',);
    const readyBody = await ready.json();
    assert.equal(readyBody.ready, true,);
    assert.equal(readyBody.status, 'ready',);
    assert.equal(readyBody.components.storage.ok, true,);
    assert.equal(readyBody.components.storage.backend, 'memory', 'NODE_ENV=test uses memory storage',);

    // Now break storage, as a closed database or an unreachable Redis would.
    platform.store.ping = async () => ({ ok: false, backend: 'memory', error: 'simulated outage', });

    // The whole point, asserted on ONE instance: liveness still passes, so the
    // container is not restarted, while readiness fails, so it is taken out of
    // rotation. An implementation that always returned 200 for /ready would fail
    // here even though it passed the healthy case above.
    const healthAfter = await nodeFetch(`${base}/health`,);
    assert.equal(healthAfter.status, 200, 'liveness must not fail on a storage outage',);

    const readyAfter = await nodeFetch(`${base}/ready`,);
    assert.equal(readyAfter.status, 503, 'readiness must fail on a storage outage',);
    const readyAfterBody = await readyAfter.json();
    assert.equal(readyAfterBody.ready, false,);
    assert.equal(readyAfterBody.status, 'not_ready',);
    assert.equal(readyAfterBody.components.storage.error, 'simulated outage',);
  } finally {
    await close();
  }
},);

test('DEP-003: /ready fails closed when the adapter cannot be probed', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    delete platform.store.ping;

    const res = await nodeFetch(`${base}/ready`,);
    assert.equal(
      res.status,
      503,
      'an unverifiable dependency must not be reported as ready — silence is not health',
    );
    const body = await res.json();
    assert.equal(body.components.storage.ok, false,);
    assert.match(body.components.storage.error, /ping/,);
  } finally {
    await close();
  }
},);

test('DEP-003: railway.json healthchecks /ready, not the endpoint that cannot fail', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'railway.json',), 'utf8',),);
  assert.equal(
    config.deploy.healthcheckPath,
    '/ready',
    'pointing the deploy healthcheck at /health promotes instances whose storage is unreachable',
  );

  // The frozen build arg. It was a literal date that the Dockerfile never
  // consumed, so it identified nothing; build identity now comes from
  // RAILWAY_GIT_COMMIT_SHA at runtime.
  assert.equal(
    config.build?.buildArgs?.BUILD_TIME,
    undefined,
    'BUILD_TIME must not be a hardcoded literal in railway.json',
  );
},);

test('DEP-007: the Dockerfile declares the BUILD_TIME arg it is given', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile',), 'utf8',);
  assert.match(
    dockerfile,
    /^ARG BUILD_TIME=/m,
    'a build arg passed by railway.json must be declared, or it is silently ignored',
  );
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*?\/ready/m, 'the container healthcheck must probe /ready',);
},);

// ── Build identity ──────────────────────────────────────────────────────────

test('DEP-007: build identity reports real values, or unknown — never a plausible constant', () => {
  const build = getBuildInfo({
    RAILWAY_GIT_COMMIT_SHA: 'd0beb8f5c55b36df7d674d55965a23b8d54ad69b',
    RAILWAY_GIT_BRANCH: 'main',
    RAILWAY_DEPLOYMENT_ID: 'abc-123',
    RAILWAY_ENVIRONMENT_NAME: 'production',
    NODE_ENV: 'production',
  },);

  assert.equal(build.commit, 'd0beb8f5c55b36df7d674d55965a23b8d54ad69b',);
  assert.equal(build.branch, 'main',);
  assert.equal(build.deployment_id, 'abc-123',);
  assert.equal(build.environment, 'production',);

  // Unset build time is null, not a fabricated timestamp and not the string
  // "unknown" — the caller can tell "no data" from "a value".
  assert.equal(build.built_at, null,);

  const bare = getBuildInfo({ NODE_ENV: 'test', },);
  assert.equal(bare.commit, 'unknown',);
  assert.equal(bare.built_at, null,);

  // Control: a commit SHA must never fall back to a fixed string. If it did,
  // every deploy would look identical and the field would be worthless — which
  // is precisely the defect the BUILD_TIME literal had.
  assert.notEqual(getBuildInfo({ RAILWAY_GIT_COMMIT_SHA: 'aaa', },).commit, bare.commit,);
},);

test('DEP-003: durability warnings flag ephemeral SQLite without failing readiness', () => {
  const noVolume = durabilityWarnings({ storage: 'sqlite', }, { STORAGE: 'sqlite', },);
  assert.equal(noVolume.length, 1, 'sqlite on an ephemeral filesystem must warn',);
  assert.match(noVolume[0], /ephemeral/,);

  const withVolume = durabilityWarnings(
    { storage: 'sqlite', },
    { STORAGE: 'sqlite', RAILWAY_VOLUME_MOUNT_PATH: '/app/data', },
  );
  assert.deepEqual(withVolume, [], 'a mounted volume makes the warning unnecessary',);

  const memory = durabilityWarnings({ storage: 'memory', }, { STORAGE: 'memory', },);
  assert.deepEqual(memory, [], 'memory storage is knowingly ephemeral and documented as such',);
},);

test('DEP-003: the probe reports durability warnings without marking the instance unready', async () => {
  // A warning is not a failure: the instance serves every request correctly, it
  // just cannot survive a restart. Failing readiness here would take a working
  // deployment out of rotation.
  const probe = createHealthProbe({
    store: createStore(),
    config: { storage: 'sqlite', },
  },);

  const result = await probe.check();
  assert.equal(result.ready, true, 'a durability warning must not make the instance not-ready',);
  assert.equal(result.status, 'ready',);
  assert.ok(Array.isArray(result.warnings,),);
  assert.ok(typeof result.uptime_ms === 'number',);
  assert.ok(result.time,);
},);
