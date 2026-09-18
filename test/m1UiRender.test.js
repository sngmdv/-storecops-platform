'use strict';

process.env.NODE_ENV = 'test';

/**
 * M1 — "UI all pages".
 *
 * WHAT THIS VERIFIES
 * ------------------
 * The audit's M1 item is a manual pass over every page. This automates the two
 * things such a pass actually catches:
 *
 *   1. Every SPA hash route renders. FE-001 (`route()` referencing an
 *      undeclared `container`) blanked the entire app, and the existing
 *      regression test only exercised the DEFAULT route — so a renderer that
 *      throws on `#/billing` or `#/returns` would still have passed.
 *
 *   2. Every static page, and every asset each page references, resolves.
 *      A page can return 200 while `<script src="/js/missing.js">` 404s.
 *
 * FIDELITY NOTE
 * -------------
 * An earlier draft of this test stubbed `StorecopsAPI` with hand-written
 * responses. That reported 25 of 30 routes as broken — but the failures were
 * `document.getElementById is not a function` and `entries.map is not a
 * function`, i.e. limitations of the stub, not defects in the product. A test
 * that cannot distinguish those two things is worse than no test.
 *
 * So this version loads the REAL `public/js/api.js` and points its `fetch` at
 * the REAL Express server booted in-process. Renderers therefore receive
 * genuine API payloads, and only genuine renderer defects can fail the test.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('fs',);
const path = require('path',);
const vm = require('vm',);

const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

const PUBLIC_DIR = path.join(__dirname, '..', 'public',);
const APP_SRC = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'app.js',), 'utf8',);
const API_SRC = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'api.js',), 'utf8',);
const nodeFetch = globalThis.fetch;

// ── Stub DOM ────────────────────────────────────────────────────────────────

function makeEl(tag = 'div',) {
  const el = {
    tagName: String(tag,).toUpperCase(),
    _html: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x,) => this._set.add(x,),); },
      remove(...c) { c.forEach((x,) => this._set.delete(x,),); },
      toggle(c, on,) {
        if (on === undefined) {
          if (this._set.has(c,)) this._set.delete(c,); else this._set.add(c,);
        } else if (on) this._set.add(c,); else this._set.delete(c,);
      },
      contains(c,) { return this._set.has(c,); },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c,) { this.children.push(c,); return c; },
    prepend() {},
    insertBefore(c,) { return c; },
    removeChild() {},
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    hasAttribute() { return false; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, }; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v,) { this._html = String(v,); },
  },);
  Object.defineProperty(el, 'firstChild', {
    get() { return this.children[0] || null; },
  },);
  return el;
}

function makeDocument() {
  const cache = new Map();
  const get = (sel,) => {
    const key = String(sel,);
    if (!cache.has(key,)) cache.set(key, makeEl(),);
    return cache.get(key,);
  };
  const doc = {
    querySelector: get,
    querySelectorAll: () => [],
    getElementById: (id,) => get(`#${id}`,),
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    createElement: (tag,) => makeEl(tag,),
    createTextNode: (t,) => ({ textContent: String(t,), }),
    addEventListener() {},
    removeEventListener() {},
    body: makeEl('body',),
    documentElement: makeEl('html',),
  };
  return doc;
}

function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k,) => (map.has(k,) ? map.get(k,) : null),
    setItem: (k, v,) => map.set(k, String(v,),),
    removeItem: (k,) => map.delete(k,),
    clear: () => map.clear(),
    get length() { return map.size; },
    key: (i,) => [...map.keys(),][i] ?? null,
    _dump: () => map,
  };
}

function makeEventSource() {
  return class EventSourceStub {
    constructor(url,) { this.url = url; }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };
}

/**
 * Boot the real SPA against the real server.
 *
 * `base` is the in-process Express origin; the sandbox `fetch` rewrites the
 * client's relative `/api/v1/...` paths onto it, so `api.js` runs unmodified.
 */
function bootSpa(base, session,) {
  const doc = makeDocument();
  const localStorage = makeLocalStorage();
  if (session) {
    localStorage.setItem('storecops_session', JSON.stringify(session,),);
  }

  const listeners = {};
  const loc = { search: '', hash: '#/dashboard', pathname: '/app', };
  const win = {
    location: loc,
    Chart: undefined,
    shopify: undefined,
    addEventListener(type, fn,) { (listeners[type] = listeners[type] || []).push(fn,); },
    removeEventListener() {},
  };

  const sandbox = {
    window: win,
    document: doc,
    localStorage,
    location: loc,
    history: { replaceState() {}, pushState() {}, },
    sessionStorage: makeLocalStorage(),
    navigator: { userAgent: 'node-test', },
    // Rewrite relative API paths onto the in-process server.
    fetch: (url, opts,) => {
      const abs = /^https?:/.test(String(url,),) ? url : `${base}${url}`;
      return nodeFetch(abs, opts,);
    },
    EventSource: makeEventSource(),
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {}, },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    setImmediate,
    URLSearchParams,
    URL,
    JSON,
    Math,
    Date,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    Map,
    Set,
    Symbol,
  };
  // `window` also needs the globals app.js reaches for via `window.*`.
  Object.assign(win, {
    fetch: sandbox.fetch,
    localStorage,
    sessionStorage: sandbox.sessionStorage,
    location: loc,
    document: doc,
    EventSource: sandbox.EventSource,
    navigator: sandbox.navigator,
    setTimeout,
    clearTimeout,
    setInterval: sandbox.setInterval,
    clearInterval: sandbox.clearInterval,
    URLSearchParams,
  },);

  vm.createContext(sandbox,);
  // api.js defines window.StorecopsAPI; app.js consumes it.
  vm.runInContext(API_SRC, sandbox, { filename: 'api.js', },);
  vm.runInContext(APP_SRC, sandbox, { filename: 'app.js', },);
  return { doc, loc, listeners, sandbox, win, };
}

/** The route names the SPA actually registers, read from its own ROUTES table. */
function registeredRoutes() {
  const block = /const ROUTES = \{([\s\S]*?)\n  \};/.exec(APP_SRC,);
  assert.ok(block, 'could not locate the ROUTES table in app.js',);
  const names = [];
  const re = /^\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*\{/gm;
  let m;
  while ((m = re.exec(block[1],)) !== null) names.push(m[1] || m[2],);
  return names;
}

/** Let every pending microtask and timer-driven await settle. */
async function settle(times = 12,) {
  for (let i = 0; i < times; i++) {
    await new Promise((r,) => setImmediate(r,),);
  }
}

// ── Server + tenant ─────────────────────────────────────────────────────────

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

/** Create a real account so the SPA boots down the authenticated path. */
async function createTenant(base,) {
  const res = await nodeFetch(`${base}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', },
    body: JSON.stringify({
      email: 'm1-render@example.com',
      password: 'Mango-Ferry-Quilt-92',
      store_name: 'M1 Render Store',
    },),
  },);
  const body = await res.json();
  assert.ok(res.ok, `signup failed: ${res.status} ${JSON.stringify(body,)}`,);
  assert.ok(body.store_id, 'signup must return a store_id',);
  assert.ok(body.ingest_key, 'signup must return a write-only ingest_key',);
  return {
    storeId: body.store_id,
    token: body.token,
    apiKey: body.api_key,
    ingestKey: body.ingest_key,
  };
}

/**
 * Ingest a realistic event spread through the REAL `/track` endpoint, so the
 * renderers see authentic derived data (funnel, insights, churn) rather than
 * hand-written fixtures that may not match what the pipeline actually emits.
 */
async function seedEvents(base, tenant,) {
  const events = [
    { event_type: 'page_view', }, 
    { event_type: 'product_view', product_id: 'p_1', product_price: 42.5, },
    { event_type: 'product_view', product_id: 'p_2', product_price: 18, },
    { event_type: 'cart_updated', product_id: 'p_1', total: 42.5, },
    { event_type: 'cart_abandoned', product_id: 'p_1', total: 42.5, },
    { event_type: 'checkout_started', product_id: 'p_1', total: 42.5, },
    { event_type: 'purchase', product_id: 'p_1', total: 42.5, },
    { event_type: 'purchase', product_id: 'p_2', total: 18, },
    { event_type: 'refund', product_id: 'p_2', total: 18, },
    { event_type: 'search', },
    { event_type: 'email_opened', },
    { event_type: 'lead_captured', },
  ];

  const accepted = [];
  for (const [i, ev,] of events.entries()) {
    const res = await nodeFetch(`${base}/api/v1/track?api_key=${encodeURIComponent(tenant.ingestKey,)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify({
        store_id: tenant.storeId,
        timestamp: new Date(Date.now() - i * 60000,).toISOString(),
        visitor_id: 'v_1',
        session_id: 'sess_1',
        customer_id: 'cust_render_1',
        email: 'render-customer@example.com',
        ...ev,
      },),
    },);
    if (res.ok) accepted.push(ev.event_type,);
  }
  assert.ok(
    accepted.length >= 10,
    `expected the ingest pipeline to accept the event spread, accepted ${accepted.length}/${events.length}`,
  );
  return accepted;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('M1: every registered SPA route renders content against the real API', async () => {
  const { base, close, } = await bootServer();
  try {
    const session = await createTenant(base,);
    const routes = registeredRoutes();
    assert.ok(routes.length >= 25, `expected the full route table, found ${routes.length}`,);

    const { doc, loc, listeners, } = bootSpa(base, session,);
    await settle();
    const onHash = (listeners.hashchange || [])[0];
    assert.ok(onHash, 'app.js must register a hashchange listener',);

    const failures = [];
    for (const name of routes) {
      loc.hash = `#/${name}`;
      onHash();
      await settle();

      const html = doc.querySelector('#view',).innerHTML;
      if (!html || html.length < 20) {
        failures.push(`${name}: rendered nothing (${html.length} chars)`,);
        continue;
      }
      if (html.includes('Something went wrong',)) {
        const msg = /class="muted">([^<]*)</.exec(html,);
        failures.push(`${name}: renderer threw — ${msg ? msg[1] : html.slice(0, 120,)}`,);
      }
    }

    assert.deepEqual(failures, [], `routes failed to render:\n${failures.join('\n',)}`,);
  } finally {
    await close();
  }
},);

test('M1: an unknown hash route falls back to the dashboard instead of blanking', async () => {
  const { base, close, } = await bootServer();
  try {
    const session = await createTenant(base,);
    const { doc, loc, listeners, } = bootSpa(base, session,);
    await settle();
    const onHash = (listeners.hashchange || [])[0];

    loc.hash = '#/this-route-does-not-exist';
    onHash();
    await settle();

    const html = doc.querySelector('#view',).innerHTML;
    assert.ok(html && html.length > 20, 'an unknown route must not blank the view',);
    assert.ok(!html.includes('Something went wrong',),);
  } finally {
    await close();
  }
},);

test('M1: an unauthenticated boot shows the login shell, not a blank page', async () => {
  const { base, close, } = await bootServer();
  try {
    const { doc, listeners, } = bootSpa(base, null,);
    await settle();
    const login = doc.querySelector('#login',);
    assert.ok(
      !login.classList.contains('hidden',),
      'with no session the login shell must be visible',
    );
    assert.equal((listeners.hashchange || []).length >= 1, true,);
  } finally {
    await close();
  }
},);

/**
 * The empty-tenant pass above proves each renderer survives missing data. This
 * pass proves each renderer also survives PRESENT data — the far more common
 * real-world case, and the one where a `.map` over an undefined field or a
 * `.toFixed` on a null surfaces.
 */
test('M1: every route still renders once the tenant has real ingested data', async () => {
  const { base, close, } = await bootServer();
  try {
    const tenant = await createTenant(base,);
    const accepted = await seedEvents(base, tenant,);
    assert.ok(accepted.includes('purchase',), 'the purchase event must have been ingested',);

    const routes = registeredRoutes();
    const { doc, loc, listeners, } = bootSpa(base, tenant,);
    await settle();
    const onHash = (listeners.hashchange || [])[0];

    const failures = [];
    for (const name of routes) {
      loc.hash = `#/${name}`;
      onHash();
      await settle();

      const html = doc.querySelector('#view',).innerHTML;
      if (!html || html.length < 20) {
        failures.push(`${name}: rendered nothing`,);
        continue;
      }
      if (html.includes('Something went wrong',)) {
        const msg = /class="muted">([^<]*)</.exec(html,);
        failures.push(`${name}: ${msg ? msg[1] : 'threw'}`,);
      }
    }

    assert.deepEqual(
      failures,
      [],
      `routes failed to render with populated data:\n${failures.join('\n',)}`,
    );
  } finally {
    await close();
  }
},);

// ── Static pages and their asset references ─────────────────────────────────
/** Local (same-origin) asset references in an HTML document. */
function assetRefs(html,) {
  const refs = new Set();
  const re = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html,)) !== null) {
    const url = m[1];
    if (/^(https?:)?\/\//.test(url,)) continue;
    if (url.startsWith('#',) || url.startsWith('data:',) || url.startsWith('mailto:',)) continue;
    refs.add(url,);
  }
  return [...refs,];
}

test('M1: every static page and every asset it references resolves', async () => {
  const { base, close, } = await bootServer();
  try {
    const pages = [
      '/', '/app', '/admin', '/audit', '/privacy', '/terms', '/support',
      '/tracker-disclosure',
    ];

    const failures = [];
    for (const page of pages) {
      const res = await nodeFetch(`${base}${page}`,);
      if (res.status !== 200) {
        failures.push(`${page} -> HTTP ${res.status}`,);
        continue;
      }
      const html = await res.text();

      for (const ref of assetRefs(html,)) {
        const assetRes = await nodeFetch(`${base}${ref}`,);
        if (assetRes.status !== 200) {
          failures.push(`${page} references ${ref} -> HTTP ${assetRes.status}`,);
        }
      }
    }

    assert.deepEqual(failures, [], `static page problems:\n${failures.join('\n',)}`,);
  } finally {
    await close();
  }
},);

/** The set of paths the server accepts a query credential on, read from the
 * source so this guard cannot drift from the rule actually enforced. */
function queryCredentialPrefixes() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'createApp.js',), 'utf8',);
  const block = src.match(/const queryCredentialsAllowed =([\s\S]*?);\n/,);
  assert.ok(block, 'could not locate `queryCredentialsAllowed` in createApp.js',);
  return [...block[1].matchAll(/['"](\/[^'"]*)['"]/g,),].map((m,) => m[1],);
}

const stripJsComments = (src,) => src
  .replace(/\/\*[\s\S]*?\*\//g, '',)
  .replace(/(^|[^:])\/\/[^\n]*/gm, '$1',);

/** Every `new EventSource(...)` argument in a file, with a bare identifier
 * resolved to its declaration — `api.js` builds the URL into a local first. */
function eventSourceTargets(src,) {
  const clean = stripJsComments(src,);
  const targets = [];
  for (const m of clean.matchAll(/new\s+EventSource\s*\(\s*([^)]*?)\s*\)\s*;/g,)) {
    let arg = m[1].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(arg,)) {
      const decl = clean.match(new RegExp(`(?:const|let|var)\\s+${arg}\\s*=\\s*([\\s\\S]*?);`,),);
      if (decl) arg = decl[1];
    }
    targets.push(arg,);
  }
  return targets;
}

test('M1: an EventSource client only targets a query-credential endpoint', () => {
  // `EventSource` cannot set request headers, so a stream it opens can only
  // authenticate if the server accepts the credential in the query. The server
  // does so on a short allowlist; everywhere else an EventSource gets a 401,
  // and because `onerror` is easy to omit it then retries forever in silence.
  // admin.html's activity feed did exactly that — it 401'd on every load while
  // the feed looked "connected". Read such a stream with `fetch` instead.
  const allowed = queryCredentialPrefixes();
  assert.ok(allowed.length > 0, 'the server query-credential allowlist is empty',);

  const clients = [
    ...fs.readdirSync(PUBLIC_DIR,)
      .filter((f,) => f.endsWith('.html',),)
      .map((f,) => path.join(PUBLIC_DIR, f,),),
    ...fs.readdirSync(path.join(PUBLIC_DIR, 'js',),)
      .filter((f,) => f.endsWith('.js',),)
      .map((f,) => path.join(PUBLIC_DIR, 'js', f,),),
  ];

  const offenders = [];
  for (const file of clients) {
    const src = fs.readFileSync(file, 'utf8',);
    for (const target of eventSourceTargets(src,)) {
      if (allowed.some((p,) => target.includes(p,),)) continue;
      offenders.push(`${path.relative(path.join(__dirname, '..',), file,)} → new EventSource(${target.trim().slice(0, 60,)})`,);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `EventSource cannot carry a header, and only ${allowed.join(', ',)} accept a `
      + `query credential. Use fetch for anything else:\n${offenders.join('\n',)}`,
  );

  // The admin feed must exist in the supported form, so deleting it rather
  // than fixing it also fails this test.
  const admin = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html',), 'utf8',);
  assert.match(admin, /fetch\(API \+ "\/admin\/activity\/stream"/,);
  assert.match(admin, /"X-API-Key": API_KEY/,);
},);

test('M1: every page in public/ is reachable over HTTP', async () => {
  const { base, close, } = await bootServer();
  try {
    const onDisk = fs.readdirSync(PUBLIC_DIR,)
      .filter((f,) => f.endsWith('.html',),)
      .map((f,) => (f === 'index.html' ? '/' : `/${f.replace(/\.html$/, '',)}`),);

    const failures = [];
    for (const route of onDisk) {
      const res = await nodeFetch(`${base}${route}`,);
      if (res.status !== 200) failures.push(`${route} -> HTTP ${res.status}`,);
    }
    assert.deepEqual(failures, [], `unreachable pages:\n${failures.join('\n',)}`,);
  } finally {
    await close();
  }
},);
