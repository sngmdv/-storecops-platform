'use strict';

process.env.NODE_ENV = 'test';

/**
 * `public/js/api.js` session handling.
 *
 * `saveSession()` used to REPLACE the stored session object. `enterFromAuth()`
 * stores the bearer token first, then calls `enterApp()`, which calls
 * `saveSession(storeId, apiKey)` with no token — so the token was dropped
 * microseconds after login and the whole session silently degraded to the
 * API-key fallback in `request()`.
 *
 * Nothing pinned that behaviour, which is how it regressed unnoticed. These
 * tests pin the merge, and the two header tests below pin *why* it matters.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs',);
const path = require('node:path',);
const vm = require('node:vm',);

const API_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js',), 'utf8',);

/** Load api.js in a stubbed browser and expose the session store + fetch spy. */
function loadApi({ onFetch, } = {},) {
  const map = new Map();
  const calls = [];
  const localStorage = {
    getItem: (k,) => (map.has(k,) ? map.get(k,) : null),
    setItem: (k, v,) => map.set(k, String(v,),),
    removeItem: (k,) => map.delete(k,),
  };
  const win = {};
  const sandbox = {
    window: win,
    localStorage,
    fetch: (url, opts,) => {
      calls.push({ url, opts, },);
      if (onFetch) onFetch(url, opts,);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({},), },);
    },
    EventSource: class {
      addEventListener() {}
      close() {}
    },
    console: { log() {}, warn() {}, error() {}, },
    URLSearchParams,
    JSON,
  };
  vm.createContext(sandbox,);
  vm.runInContext(API_SRC, sandbox, { filename: 'api.js', },);
  assert.ok(win.StorecopsAPI, 'api.js must expose window.StorecopsAPI',);
  return { api: win.StorecopsAPI, map, calls, };
}

const read = (map,) => JSON.parse(map.get('storecops_session',),);

// ── The merge ───────────────────────────────────────────────────────────────

test('a tokenless saveSession does not wipe the stored bearer token', () => {
  const { api, map, } = loadApi();

  // Exactly the login sequence: token first, then enterApp()'s bare call.
  api.saveSession('store_1', 'key_1', { token: 'tok_1', email: 'a@b.c', },);
  api.saveSession('store_1', 'key_1',);

  const s = read(map,);
  assert.strictEqual(s.token, 'tok_1', 'the bearer token must survive enterApp()',);
  assert.strictEqual(s.email, 'a@b.c',);
  assert.strictEqual(s.storeId, 'store_1',);
  assert.strictEqual(s.apiKey, 'key_1',);
},);

test('an explicitly supplied token still replaces the previous one', () => {
  const { api, map, } = loadApi();
  api.saveSession('store_1', 'key_1', { token: 'tok_1', },);
  api.saveSession('store_1', 'key_2', { token: 'tok_2', },);

  const s = read(map,);
  assert.strictEqual(s.token, 'tok_2', 'a fresh login must not inherit the old token',);
  assert.strictEqual(s.apiKey, 'key_2',);
},);

test('saveSession works with no prior session at all', () => {
  const { api, map, } = loadApi();
  api.saveSession('store_9', 'key_9',);
  assert.deepStrictEqual(read(map,), { storeId: 'store_9', apiKey: 'key_9', },);
},);

test('clearSession removes the session', () => {
  const { api, map, } = loadApi();
  api.saveSession('store_1', 'key_1', { token: 'tok_1', },);
  api.clearSession();
  assert.strictEqual(map.has('storecops_session',), false,);
  assert.strictEqual(api.session(), null,);
},);

// ── Why the merge matters: the auth header ──────────────────────────────────

test('an authenticated request sends the bearer token, not the API key', async () => {
  const { api, calls, } = loadApi();
  api.saveSession('store_1', 'key_1', { token: 'tok_1', },);
  await api.get('/report/store_1',);

  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer tok_1',);
  assert.strictEqual(calls[0].opts.headers['X-API-Key'], undefined,);
},);

test('with no token the request degrades to the API key — the regression symptom', async () => {
  const { api, calls, } = loadApi();
  api.saveSession('store_1', 'key_1',);
  await api.get('/report/store_1',);

  assert.strictEqual(calls[0].opts.headers['X-API-Key'], 'key_1',);
  assert.strictEqual(calls[0].opts.headers.Authorization, undefined,);
},);

test('a corrupt stored session does not throw', () => {
  const { api, map, } = loadApi();
  map.set('storecops_session', '{not json',);
  assert.strictEqual(api.session(), null,);
  // And it must still be usable afterwards.
  api.saveSession('store_1', 'key_1',);
  assert.strictEqual(read(map,).storeId, 'store_1',);
},);

// ── Control ─────────────────────────────────────────────────────────────────

test('control — the merge assertion detects a replace-style saveSession', () => {
  // The pre-fix implementation, verbatim in shape.
  const replaceStyle = (storeId, apiKey, extra = {},) => JSON.stringify({ storeId, apiKey, ...extra, },);

  const stored = JSON.parse(replaceStyle('store_1', 'key_1', { token: 'tok_1', },),);
  assert.strictEqual(stored.token, 'tok_1',);

  const afterEnterApp = JSON.parse(replaceStyle('store_1', 'key_1',),);
  assert.strictEqual(
    afterEnterApp.token,
    undefined,
    'if this survives, the merge test above is vacuous',
  );
},);
