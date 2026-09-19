'use strict';

process.env.NODE_ENV = 'test';

/**
 * No async Express handler or middleware may be able to reject unhandled.
 *
 * THE DEFECT CLASS (items 41 and 42)
 * ----------------------------------
 * Express 4.22.2's `Layer.handle_request` wraps only the *synchronous* call, so a
 * rejected async handler is never answered **and** escalates to an unhandled
 * rejection, which terminates the process by default. (Item 33's
 * `installProcessHandlers` turns that into a graceful exit 1 — better, but still
 * an outage, and the request is still never answered.)
 *
 * `apiRoutes.js` protects its routes with a `wrap()` helper. Nothing protected the
 * app-level handlers in `createApp.js`, the RBAC middleware in `security.js`, or
 * the authentication gate itself. Seven were unguarded, including:
 *   - `apiKeyMiddleware` — the authentication gate for all 280 API routes;
 *   - `createRbac().middleware()` — mounted directly on 7 routes (item 42);
 *   - `GET /unsubscribe` — the one route in `apiRoutes.js` that forgot `wrap()`,
 *     on a public endpoint whose only credential is the token in the query.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM THE M8 ONE
 * -----------------------------------------------
 * The M8 guard scanned `createApp.js` and only async *function literals* passed to
 * `app.<verb>()`. That is a property of one file, in one position. It reported
 * "0 unguarded" while seven existed, because it could not see:
 *   - `router.<verb>(...)` registrations in the same file;
 *   - `app.use(async ...)`;
 *   - **factory-produced** middleware — `return async (req, res, next) => {...}` —
 *     which is a *return value*, not a call argument.
 *
 * A guard that proves a property must state the domain it proves it over. This one
 * covers every async function in `src/server/` that Express can reach, and the
 * detector is self-tested below so it cannot quietly stop seeing a position.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const path = require('path',);

const { scanSource, scanDir, } = require('./helpers/astScan',);

const SERVER_DIR = path.join(__dirname, '..', 'src', 'server',);

/** Names of the unguarded entries in a synthetic source, for readable failures. */
function unguardedIn(source,) {
  return scanSource(source, 'synthetic.js',)
    .filter((h,) => !h.guarded,)
    .map((h,) => `${h.kind}@${h.line}`,);
}

// ── The detector must actually detect ───────────────────────────────────────

test('the scan flags an expression-bodied async handler — it can hold no catch', () => {
  assert.deepEqual(
    unguardedIn(`
      app.get('/x', async (req, res,) => res.json(await thing(),),);
    `,),
    ['registration:app@2',],
  );
},);

test('the scan flags a block-bodied async handler with no try', () => {
  // This is the case the try-detection logic exists for. An expression body is
  // already caught by the shape check alone, so without this control, neutering
  // the try detection would go unnoticed.
  assert.deepEqual(
    unguardedIn(`
      router.get('/y', async (req, res,) => {
        const rows = await store.find({},);
        res.json(rows,);
      },);
    `,),
    ['registration:router@2',],
  );
},);

test('the scan flags async middleware passed to app.use', () => {
  assert.deepEqual(
    unguardedIn(`
      app.use(async (req, res, next,) => {
        await touch(req,);
        next();
      },);
    `,),
    ['registration:app@2',],
  );
},);

test('the scan flags a factory-produced middleware — the item-42 shape', () => {
  // A `return async (req, res, next) => {...}` is a *return value*, not a call
  // argument. A scan that only inspects arguments cannot see it, which is exactly
  // how `createRbac().middleware()` stayed unguarded.
  assert.deepEqual(
    unguardedIn(`
      function factory() {
        return async (req, res, next,) => {
          const user = await store.users.findOne({},);
          req.user = user;
          next();
        };
      }
    `,),
    ['factory-return@3',],
  );
},);

test('the scan accepts the guarded forms — try/catch, and wrap()', () => {
  // A block body with a try.
  assert.deepEqual(
    unguardedIn(`
      router.get('/y', async (req, res,) => {
        try { res.json(await store.find({},),); } catch (error) { res.status(500,).end(); }
      },);
    `,),
    [],
  );

  // A factory-produced middleware with a try.
  assert.deepEqual(
    unguardedIn(`
      function factory() {
        return async (req, res, next,) => {
          try { await touch(req,); } catch (error) { return res.status(503,).end(); }
          return next();
        };
      }
    `,),
    [],
  );

  // `wrap(handler)` — the wrapper's own body carries the try/catch, so the inner
  // handler does not need one. This is how 287 routes in apiRoutes.js are safe.
  assert.deepEqual(
    unguardedIn(`
      router.get('/z', wrap(async (req, res,) => {
        const rows = await store.find({},);
        return res.json(rows,);
      },),);
    `,),
    [],
  );
},);

test('the scan follows an async middleware assigned to a variable', () => {
  // `return mw` hands it straight to Express, so nothing upstream can guard it —
  // it must guard itself. This is the shape a regression to
  // `return resolveIdentity;` produces, and the first version of this detector
  // missed it: it only understood `return async (...) => {...}`, not a returned
  // *identifier*.
  assert.deepEqual(
    unguardedIn(`
      function factory() {
        const mw = async (req, res, next,) => {
          await touch(req,);
          next();
        };
        return mw;
      }
    `,),
    ['returned-middleware@3',],
  );

  // The same variable WITH its own try is fine.
  assert.deepEqual(
    unguardedIn(`
      function factory() {
        const mw = async (req, res, next,) => {
          try { await touch(req,); } catch (error) { return res.status(503,).end(); }
          return next();
        };
        return mw;
      }
    `,),
    [],
  );

  // Delegation: the variable is not returned, so it is guarded when every call
  // site is. This is how `apiKeyMiddleware` is built — `resolveIdentity` has no
  // try of its own, and is called from inside the returned wrapper's try.
  assert.deepEqual(
    unguardedIn(`
      function factory() {
        const resolve = async (req, res, next,) => {
          await touch(req,);
          next();
        };
        return async (req, res, next,) => {
          try { return await resolve(req, res, next,); } catch (error) { return res.status(503,).end(); }
        };
      }
    `,),
    [],
  );

  // …but a call site outside any try is a real hole, and must be reported.
  assert.deepEqual(
    unguardedIn(`
      function factory() {
        const resolve = async (req, res, next,) => {
          await touch(req,);
          next();
        };
        return async (req, res, next,) => {
          await resolve(req, res, next,);
        };
      }
    `,).sort(),
    ['delegated-middleware@3', 'factory-return@7',],
  );
},);

test('the scan ignores things that are not Express handlers', () => {
  // A synchronous handler: Express catches a synchronous throw itself.
  assert.deepEqual(unguardedIn('app.get("/x", (req, res,) => res.json({},),);',), [],);

  // A sub-router or a factory call passed as middleware is a CallExpression, not
  // a function literal. Note this is a *deliberate* blind spot of the old guard —
  // the new one covers it from the factory's definition instead.
  assert.deepEqual(unguardedIn('app.use("/api/v1", rateLimiter, createApiRouter(platform,),);',), [],);

  // An internal async helper that Express never sees is not this suite's business.
  assert.deepEqual(unguardedIn('async function helper() { await thing(); }',), [],);
},);

// ── The property ────────────────────────────────────────────────────────────

test('no async Express handler or middleware in src/server/ can reject unhandled', () => {
  const findings = scanDir(SERVER_DIR,);
  const unguarded = findings.filter((h,) => !h.guarded,);

  assert.deepEqual(
    unguarded.map((h,) => `${h.file}:${h.line} [${h.kind}${h.path ? ` ${h.path}` : ''}]`,),
    [],
    'Express 4 does not catch a rejected async handler — it leaves the request unanswered AND '
    + 'raises an unhandled rejection, which terminates the process. Wrap the body in try/catch, or '
    + 'pass it through wrap() the way apiRoutes.js does.',
  );
},);

test('the scan actually read the server layer — it is not passing vacuously', () => {
  const findings = scanDir(SERVER_DIR,);

  assert.ok(
    findings.length >= 300,
    `only ${findings.length} handler-position async functions found — is the scan reading src/server/?`,
  );

  // Each of these was one of the seven unguarded sites. If the detector stops
  // seeing a position, the property above would pass while checking less — which
  // is precisely how "0 unguarded" was reported while seven existed.
  const has = (predicate,) => findings.some(predicate,);

  assert.ok(
    has((h,) => h.file === 'security.js' && h.kind === 'factory-return',),
    'the scan no longer sees factory-produced middleware — item 42 is invisible again',
  );
  assert.ok(
    has((h,) => h.file === 'createApp.js' && h.kind === 'factory-return',),
    'the scan no longer sees apiKeyMiddleware, the authentication gate',
  );
  assert.ok(
    has((h,) => h.file === 'createApp.js' && h.path === '/logout',),
    'the scan no longer sees router.<verb> registrations inside createApp.js',
  );
  assert.ok(
    has((h,) => h.file === 'createApp.js' && h.path === '/me',),
    'the scan no longer sees router.<verb> registrations inside createApp.js',
  );
  assert.ok(
    has((h,) => (h.file === 'routes/admin.js' || h.file === 'admin.js' || h.file === 'apiRoutes.js') && h.path === '/unsubscribe',),
    'the scan no longer sees the wrap() path for /unsubscribe (moved to routes/admin.js by the F4 split)',
  );

  // The wrap() path must remain the dominant one — if `wrap` stopped being
  // recognised, 287 routes would silently read as "internal helpers" and vanish
  // from the scan entirely.
  const wrapped = findings.filter((h,) => h.kind === 'wrap',).length;
  assert.ok(wrapped >= 250, `only ${wrapped} wrap()-protected handlers found — is wrap() still recognised?`,);
},);
