'use strict';

process.env.NODE_ENV = 'test';

/**
 * DOC-001 — the public API documentation must describe routes that exist.
 *
 * `API.md` is what a Shopify reviewer and any integrating merchant reads. It
 * documented **11 endpoints that returned 404**: `/dashboard/:store_id` and
 * `/reporting/:store_id` did not exist at all (`reporting` is not a route — the
 * real one is singular `/report`), `/inventory/:store_id/analyze` was documented
 * as GET when it is POST, and all six webhook paths were wrong, because webhooks
 * are mounted at the **root**, not under `/api/v1`. The base URL was the dead
 * `your-app.up.railway.app` placeholder, in three places.
 *
 * Nothing in the repo could have caught this: the routes were fine, the code was
 * fine — only the prose was wrong. So the check is *derived*: parse the document,
 * read the real router, and require every documented route to resolve. Add a
 * route to API.md that does not exist and this fails.
 *
 * Same reasoning as the other parity guards (`shopifyScopeParity`,
 * `m2WebhookContract`, `storageIndexes`): a hand-maintained list drifts, so
 * derive it and let the drift become a failing test.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs',);
const path = require('node:path',);

const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

const API_MD = path.join(__dirname, '..', 'API.md',);

/**
 * Recover the mount path from an Express router layer's `regexp.source`.
 * Express encodes a router mounted at `/api/v1` as `^\/api\/v1\/?(?=\/|$)`.
 * Naively splitting on the first backslash yields `api` — which silently turns
 * every probe path into `/api/customers/:store_id`, a route that does not exist,
 * so everything 404s and the sweep proves nothing.
 */
function mountPathFromRegexp(regexp,) {
  const source = regexp?.source || '';
  if (!source || source === '^\\/?' || source === '^\\/') return '';

  const p = source
    .replace(/^\^/, '',)
    .replace(/\\\//g, '/',)
    .split('/?(',)[0]
    .split('(?=',)[0]
    .replace(/\/+$/, '',);

  return p === '/' ? '' : p;
}

/** Every route the app actually serves, as `METHOD /path`. */
function realRoutes(app,) {
  const found = new Set();

  const walk = (stack, prefix,) => {
    for (const layer of stack) {
      if (layer.route) {
        const p = `${prefix}${layer.route.path}`.replace(/\/{2,}/g, '/',);
        for (const m of Object.keys(layer.route.methods,)) found.add(`${m.toUpperCase()} ${p}`,);
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, `${prefix}${mountPathFromRegexp(layer.regexp,)}`,);
      }
    }
  };

  walk(app._router.stack, '',);
  return found;
}

/**
 * Routes documented in API.md, as `{ method, path }`.
 *
 * Deliberately reads only the `METHOD /path` lines, which is the format the
 * document already uses — no markup is invented for the test's benefit.
 */
function documentedRoutes(markdown,) {
  const out = [];
  for (const m of markdown.matchAll(/^(GET|POST|PUT|PATCH|DELETE) +(\/[A-Za-z0-9_/:.\-{}]*)/gm,)) {
    out.push({ method: m[1], path: m[2], },);
  }
  return out;
}

/** Which documented routes do not exist. Kept pure so the control can exercise it. */
function missingRoutes(documented, real,) {
  return documented
    .filter((r,) => !real.has(`${r.method} ${r.path}`,),)
    .map((r,) => `${r.method} ${r.path}`,);
}

const platform = createPlatform();
const app = createApp(platform,);
const REAL = realRoutes(app,);
const MARKDOWN = fs.readFileSync(API_MD, 'utf8',);
const DOCUMENTED = documentedRoutes(MARKDOWN,);

// ── Controls: the guard must be able to fail ────────────────────────────────

test('control — the detector flags a documented route that does not exist', () => {
  const bogus = [{ method: 'GET', path: '/api/v1/definitely-not-a-route', },];
  assert.deepStrictEqual(
    missingRoutes(bogus, REAL,),
    ['GET /api/v1/definitely-not-a-route',],
    'if this passes, the guard below is vacuous',
  );
},);

test('control — the detector accepts a documented route that does exist', () => {
  const real = [{ method: 'GET', path: '/health', },];
  assert.deepStrictEqual(missingRoutes(real, REAL,), [],);
},);

// ── Anti-vacuity ────────────────────────────────────────────────────────────

test('both sides of the comparison are non-trivial', () => {
  assert.ok(MARKDOWN.length > 1000, 'API.md must have been read',);
  assert.ok(
    DOCUMENTED.length >= 25,
    `expected API.md to document a real surface, parsed only ${DOCUMENTED.length}`,
  );
  assert.ok(
    REAL.size >= 300,
    `expected the live router to expose 300+ method/route pairs, enumerated ${REAL.size}`,
  );
  // A parser that returned nothing, or a router walk that found nothing, would
  // make every assertion below pass while checking nothing.
  assert.ok(REAL.has('GET /health',), 'the router walk must find known root routes',);
  assert.ok(REAL.has('GET /api/v1/report/:store_id',), 'the router walk must reattach mount prefixes',);
},);

// ── The guard ───────────────────────────────────────────────────────────────

test('DOC-001: every route documented in API.md exists in the live router', () => {
  const missing = missingRoutes(DOCUMENTED, REAL,);
  assert.deepStrictEqual(
    missing,
    [],
    `API.md documents routes that return 404:\n  ${missing.join('\n  ',)}\n`
      + 'Either fix the path in API.md or remove the section.',
  );
},);

test('DOC-001: the documented base URL is not a placeholder', () => {
  // It pointed at `your-app.up.railway.app` — a host that has never served this
  // app — in three places, including both SDK examples.
  const url = MARKDOWN.match(/https?:\/\/[A-Za-z0-9.\-]+/g,) || [];
  const hosts = [...new Set(url,),];

  for (const placeholder of ['your-app.up.railway.app', 'example.com', 'localhost',]) {
    assert.ok(
      !hosts.some((h,) => h.includes(placeholder,),),
      `API.md still advertises the placeholder host "${placeholder}"`,
    );
  }
  assert.ok(
    hosts.some((h,) => h.includes('storecops-production.up.railway.app',),),
    'API.md must state the real base URL',
  );
},);

test('DOC-001: no documented webhook path is nested under /api/v1', () => {
  // The specific defect: webhooks are mounted at the root. Documenting them
  // under /api/v1 was wrong for all six.
  const nested = DOCUMENTED
    .filter((r,) => r.path.startsWith('/api/v1/webhooks/',),)
    .map((r,) => `${r.method} ${r.path}`,);

  assert.deepStrictEqual(nested, [], `webhook routes are root-level, not under /api/v1: ${nested}`,);
},);
