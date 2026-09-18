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
 *
 * M8 ADDITIONS
 * ------------
 *   - The probe must be TOTAL (a throwing or non-settling `ping()` still gets an
 *     answer) and BOUNDED (it gives up before the orchestrator does, so the 503
 *     body is actually read).
 *   - No async app-level handler in `createApp.js` may be able to reject
 *     unhandled, because Express 4 cannot catch one.
 *
 * The last group parses `createApp.js` with `espree` — the parser ESLint already
 * uses, and therefore already present wherever `npm run lint` works. It is used
 * rather than a hand-written scanner because a hand-written one is not reliable
 * here: `/^https?:\/\//` on line 1036 of `createApp.js` was mis-lexed as a line
 * comment, which silently skipped a handler. A guard that skips the thing it is
 * checking is worse than no guard, because it certifies safety it never tested.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('fs',);
const os = require('os',);
const path = require('path',);
const espree = require('espree',);

const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);
const {
  createHealthProbe,
  getBuildInfo,
  durabilityWarnings,
  resolvePingTimeoutMs,
  DEFAULT_PING_TIMEOUT_MS,
} = require('../src/server/healthProbe',);
const { createStore, } = require('../src/storage/store',);
const { createSqliteStore, } = require('../src/storage/sqliteStore',);

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

// ── M8: the probe must be total and time-bounded ────────────────────────────

/**
 * Run `fn`, collecting any unhandled rejections it provokes.
 *
 * Node terminates the process on an unhandled rejection by default, so the
 * listener is installed before `fn` runs; without it the failure mode under test
 * would take the whole suite down instead of failing one test.
 */
async function withRejectionWatch(fn,) {
  const seen = [];
  const onRejection = (reason,) => seen.push(reason,);
  process.on('unhandledRejection', onRejection,);
  try {
    await fn();
    // A rejection is reported on a later turn than the request that caused it.
    await new Promise((resolve,) => setTimeout(resolve, 50,),);
  } finally {
    process.off('unhandledRejection', onRejection,);
  }
  return seen;
}

test('M8: /ready answers when ping() throws — no hang, and no unhandled rejection', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    const rejections = await withRejectionWatch(async () => {
      // A synchronous throw. Express would catch this if it happened in the
      // handler itself; it does not, because it happens one await deeper.
      platform.store.ping = () => {
        throw new Error('storage exploded',);
      };
      const sync = await nodeFetch(`${base}/ready`, { signal: AbortSignal.timeout(5000,), },);
      assert.equal(sync.status, 503,);
      assert.equal((await sync.json()).components.storage.error, 'storage exploded',);

      // A rejected promise — the shape an async adapter actually produces, and
      // the one that reaches Express as an unhandled rejection.
      platform.store.ping = async () => {
        throw new Error('async storage exploded',);
      };
      const asyncRes = await nodeFetch(`${base}/ready`, { signal: AbortSignal.timeout(5000,), },);
      assert.equal(asyncRes.status, 503,);
      assert.equal((await asyncRes.json()).components.storage.error, 'async storage exploded',);
    },);

    assert.equal(
      rejections.length,
      0,
      'a rejected ping() escaped as an unhandled rejection — by default that terminates the process',
    );

    // Control: liveness still passes, so this cannot be satisfied by an endpoint
    // that simply answers 503 to everything.
    assert.equal((await nodeFetch(`${base}/health`,)).status, 200,);
  } finally {
    await close();
  }
},);

test('M8: /ready answers when ping() never settles, bounded by the ping timeout', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    // Control first: a healthy store answers promptly, so the bound below cannot
    // be satisfied by an endpoint that always waits the full timeout.
    const healthyStart = Date.now();
    const healthy = await nodeFetch(`${base}/ready`,);
    const healthyMs = Date.now() - healthyStart;
    assert.equal(healthy.status, 200,);
    assert.ok(healthyMs < 500, `a healthy /ready took ${healthyMs}ms — it should not wait at all`,);

    // A ping that never settles: a blackholed host, or a command queued behind a
    // reconnect. With no bound this request never returns, and the orchestrator
    // kills it with no diagnostic.
    platform.store.ping = () => new Promise(() => {},);

    const start = Date.now();
    const res = await nodeFetch(`${base}/ready`, { signal: AbortSignal.timeout(10000,), },);
    const waited = Date.now() - start;

    assert.equal(res.status, 503,);
    const body = await res.json();
    assert.match(body.components.storage.error, /did not settle/,);
    assert.equal(body.ping_timeout_ms, DEFAULT_PING_TIMEOUT_MS, 'the payload names the bound it used',);

    // It waited for the bound — not less (the bound did not apply) and not much
    // more (the bound was ignored).
    assert.ok(waited >= DEFAULT_PING_TIMEOUT_MS - 150, `gave up after ${waited}ms, before the bound`,);
    assert.ok(waited < DEFAULT_PING_TIMEOUT_MS + 2000, `waited ${waited}ms — the bound did not apply`,);
  } finally {
    await close();
  }
},);

test('M8: the ping bound is configurable, and an unusable value falls back rather than becoming 0', () => {
  const D = DEFAULT_PING_TIMEOUT_MS;

  // Honoured — explicit argument first, then config.
  assert.equal(resolvePingTimeoutMs(250, undefined,), 250,);
  assert.equal(resolvePingTimeoutMs(undefined, 300,), 300,);
  assert.equal(resolvePingTimeoutMs(250, 300,), 250, 'the explicit argument must win over config',);
  assert.equal(resolvePingTimeoutMs(undefined, '450',), 450, 'a value read from the environment arrives as a string',);

  // Nothing set.
  assert.equal(resolvePingTimeoutMs(undefined, undefined,), D,);

  // Misconfigured. `Number('')` is 0 and `Number('abc')` is NaN, and honouring
  // either would fail every probe instantly and drain a healthy instance — a
  // worse outcome than ignoring the setting.
  for (const bad of [0, -1, NaN, '', 'abc', null, Infinity,]) {
    assert.equal(
      resolvePingTimeoutMs(bad, undefined,),
      D,
      `a bound of ${String(bad,)} must fall back to the default, not be honoured`,
    );
  }
},);

test('M8: the probe reports the bound it will use', async () => {
  const probe = createHealthProbe({
    store: createStore(),
    config: { security: { readinessPingTimeoutMs: 750, }, },
  },);
  assert.equal(probe.pingTimeoutMs, 750, 'config.security.readinessPingTimeoutMs must reach the probe',);

  const result = await probe.check();
  assert.equal(result.ping_timeout_ms, 750,);
  assert.equal(result.ready, true,);

  // Control: the explicit argument still wins, so the config path is not simply
  // ignored in favour of a constant.
  const overridden = createHealthProbe({
    store: createStore(),
    config: { security: { readinessPingTimeoutMs: 750, }, },
    pingTimeoutMs: 120,
  },);
  assert.equal(overridden.pingTimeoutMs, 120,);
},);

test('M8: the readiness bound stays inside the orchestrator healthcheck window', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'railway.json',), 'utf8',),);
  const windowMs = Number(cfg.deploy.healthcheckTimeout,) * 1000;

  assert.ok(
    Number.isFinite(windowMs,) && windowMs > 0,
    'railway.json must declare healthcheckTimeout, in seconds',
  );
  assert.ok(
    DEFAULT_PING_TIMEOUT_MS < windowMs,
    `the probe must give up (${DEFAULT_PING_TIMEOUT_MS}ms) before Railway does (${windowMs}ms); `
    + 'otherwise the 503 body is never read and the outage is undiagnosable',
  );
},);

test('M8: /ready fails on a real database closed under a live instance, while /health stays up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storecops-m8-',),);
  const dbPath = path.join(dir, 'storecops.db',);
  const store = createSqliteStore(dbPath,);
  const app = createApp(createPlatform({ store, },),);
  const server = await new Promise((resolve,) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s,),);
  },);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const before = await nodeFetch(`${base}/ready`,);
    assert.equal(before.status, 200, 'a freshly opened database must be ready',);

    // The real thing, not a stubbed ping: close the handle under a live instance.
    await store.close();

    const closed = await nodeFetch(`${base}/ready`,);
    assert.equal(closed.status, 503, 'a closed handle must not be reported as ready',);
    assert.match((await closed.json()).components.storage.error, /not open|closed/i,);

    // Liveness must NOT fail here — it is the restart signal, and a storage blip
    // must not trigger a restart loop instead of a traffic drain.
    assert.equal((await nodeFetch(`${base}/health`,)).status, 200,);

    // And the file itself going away — the shape of a volume that failed to mount.
    fs.unlinkSync(dbPath,);
    assert.equal((await nodeFetch(`${base}/ready`,)).status, 503,);
  } finally {
    await new Promise((done,) => server.close(done,),);
    fs.rmSync(dir, { recursive: true, force: true, },);
  }
},);

// ── M8: no async app-level handler may reject unhandled ─────────────────────

const APP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all',],);

function* walkAst(node,) {
  if (!node || typeof node.type !== 'string') return;
  yield node;
  for (const key of Object.keys(node,)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value,)) {
      for (const child of value) yield* walkAst(child,);
    } else if (value && typeof value.type === 'string') {
      yield* walkAst(value,);
    }
  }
}

function containsTry(node,) {
  for (const n of walkAst(node,)) if (n.type === 'TryStatement') return true;
  return false;
}

/**
 * Every handler registered directly on `app` that is `async`, and whether it can
 * reject unhandled.
 *
 * An expression-bodied handler (`async (req, res) => res.json(await x())`) is
 * always unguarded — there is nowhere for a `catch` to live. A block body is
 * guarded when it contains a `try`. A non-function last argument (a router such
 * as `createApiRouter(platform)`) is not a handler and is skipped.
 */
function asyncAppHandlers(source,) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true, },);
  const out = [];

  for (const node of walkAst(ast,)) {
    if (node.type !== 'ExpressionStatement') continue;
    const call = node.expression;
    if (call?.type !== 'CallExpression') continue;
    const callee = call.callee;
    if (callee?.type !== 'MemberExpression') continue;
    if (callee.object?.type !== 'Identifier' || callee.object.name !== 'app') continue;
    if (callee.property?.type !== 'Identifier' || !APP_VERBS.has(callee.property.name,)) continue;

    const last = call.arguments[call.arguments.length - 1];
    if (!last) continue;
    if (last.type !== 'ArrowFunctionExpression' && last.type !== 'FunctionExpression') continue;
    if (last.async !== true) continue;

    out.push({
      line: node.loc.start.line,
      verb: callee.property.name,
      path: call.arguments[0]?.type === 'Literal' ? String(call.arguments[0].value,) : '<dynamic>',
      guarded: last.body.type === 'BlockStatement' && containsTry(last.body,),
    },);
  }
  return out;
}

test('M8: the handler detector actually detects — an unguarded handler is flagged', () => {
  // Without this, a detector that quietly returned nothing would let the guard
  // below pass while checking nothing at all.
  const unguarded = `
    app.get('/x', async (req, res,) => res.json(await thing(),),);
  `;
  const flagged = asyncAppHandlers(unguarded,);
  assert.equal(flagged.length, 1,);
  assert.equal(flagged[0].guarded, false, 'an expression-bodied async handler cannot contain a catch',);
  assert.equal(flagged[0].path, '/x',);

  // A BLOCK body with no try is the case the `containsTry` logic exists for, and
  // the only one that exercises it — an expression body is already unguarded on
  // the shape check alone. Without this, neutering the try detection would go
  // unnoticed because every other case would still pass.
  const blockNoTry = `
    app.get('/x', async (req, res,) => {
      const data = await thing();
      res.json(data,);
    },);
  `;
  const blockFlagged = asyncAppHandlers(blockNoTry,);
  assert.equal(blockFlagged.length, 1,);
  assert.equal(blockFlagged[0].guarded, false, 'a block body with no try can still reject unhandled',);

  // A try nested inside a block still counts — a handler that guards its risky
  // work inside an `if` is guarded.
  const nestedTry = `
    app.get('/x', async (req, res,) => {
      if (req.query.q) {
        try { res.json(await thing(),); } catch (error) { res.status(500,).end(); }
      }
      res.end();
    },);
  `;
  assert.equal(asyncAppHandlers(nestedTry,).filter((h,) => !h.guarded,).length, 0,);

  const guarded = `
    app.get('/x', async (req, res,) => {
      try { res.json(await thing(),); } catch (error) { res.status(500,).end(); }
    },);
  `;
  assert.equal(asyncAppHandlers(guarded,).filter((h,) => !h.guarded,).length, 0,);

  // A synchronous handler is not the detector's business: Express catches a
  // synchronous throw itself.
  const syncHandler = `
    app.get('/x', (req, res,) => res.json({},),);
  `;
  assert.equal(asyncAppHandlers(syncHandler,).length, 0,);

  // A sub-router is not a handler either.
  const subRouter = `
    app.use('/api/v1', rateLimiter, createApiRouter(platform,),);
  `;
  assert.equal(asyncAppHandlers(subRouter,).length, 0,);
},);

test('M8: no async app-level handler in createApp.js can reject unhandled', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'server', 'createApp.js',), 'utf8',);
  const handlers = asyncAppHandlers(source,);
  const unguarded = handlers.filter((h,) => !h.guarded,);

  assert.deepEqual(
    unguarded.map((h,) => `line ${h.line}: ${h.verb.toUpperCase()} ${h.path}`,),
    [],
    'Express 4 does not catch a rejected async handler — it leaves the request unanswered AND '
    + 'raises an unhandled rejection, which terminates the process. Wrap the body in try/catch.',
  );

  // A guard that passes because it found nothing is not a guard. These are the
  // handlers whose absence would mean the scan is not reading the file — the
  // last one specifically because a hand-written scanner silently skipped it.
  assert.ok(handlers.length >= 15, `only ${handlers.length} async handlers found — is the scan reading the file?`,);
  const paths = handlers.map((h,) => h.path,);
  for (const expected of [
    '/ready',
    '/health/status',
    '/connect/status',
    '/connect/:platform/callback',
    '/api/v1/connect/pending/:token',
    '/webhooks/shopify/app-uninstalled',
  ]) {
    assert.ok(paths.includes(expected,), `expected the scan to have inspected ${expected}`,);
  }
},);
