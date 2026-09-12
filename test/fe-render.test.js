'use strict';

process.env.NODE_ENV = 'test';

// FE-001 regression (audit item TEST-001): the SPA must actually render into
// #view. The original defect was `route()` referencing an undeclared `container`,
// which threw `ReferenceError: container is not defined` and left the page blank
// for every merchant. This test boots the real browser bundle in a stubbed DOM
// and asserts #view is populated — no jsdom dependency required.

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('fs',);
const path = require('path',);
const vm = require('vm',);

const APP_SRC = path.join(__dirname, '..', 'public', 'js', 'app.js',);

function makeEl() {
  const el = {
    _html: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) {
        if (on === undefined) {
          this._set.has(c) ? this._set.delete(c) : this._set.add(c);
        } else if (on) {
          this._set.add(c);
        } else {
          this._set.delete(c);
        }
      },
      contains(c) { return this._set.has(c); },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { return c; },
    prepend() {},
    removeChild() {},
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {},
    blur() {},
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); },
  },);
  return el;
}

function makeDocument() {
  const cache = new Map();
  const get = (sel) => {
    if (!cache.has(sel)) cache.set(sel, makeEl());
    return cache.get(sel);
  };
  return {
    querySelector: get,
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener() {},
    body: makeEl(),
    documentElement: makeEl(),
  };
}

// Minimal StorecopsAPI so the SPA boots into the authenticated path, which is
// what drives enterApp() -> route() -> the previously-broken fault line.
function makeApi() {
  const fakeReport = {
    overview: { events_tracked: 10, revenue_recovered: 0 },
    funnel: { product_views: 1, carts: 1, checkouts_started: 1, purchases: 1 },
    risk_bands: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
  };
  const fakeInsights = {
    restock_urgent: [], competitor_alerts: [], seo_issues: [], trending: [],
  };
  const session = { storeId: 'store_test', apiKey: 'key_test' };
  return {
    session: () => session,
    store: () => 'store_test',
    saveSession() {},
    get(url) {
      const u = String(url);
      if (u.includes('maturity')) return Promise.resolve({ score: 50 });
      if (u.includes('report')) return Promise.resolve(fakeReport);
      if (u.includes('insights')) return Promise.resolve(fakeInsights);
      if (u.includes('orders')) return Promise.resolve({ orders: [] });
      if (u.includes('actions')) return Promise.resolve([]);
      if (u.includes('churn')) return Promise.resolve({ risk_bands: {} });
      if (u.includes('attribution')) return Promise.resolve(null);
      return Promise.resolve({});
    },
    post: () => Promise.resolve({}),
    liveStream: () => null,
  };
}

test('FE-001: app.js boots and route() renders #view (not blank)', async () => {
  const doc = makeDocument();
  const api = makeApi();
  const loc = { search: '', hash: '' };
  const win = {
    StorecopsAPI: api,
    location: loc,
    Chart: undefined,
    shopify: undefined,
    addEventListener() {},
  };
  const sandbox = {
    window: win,
    document: doc,
    location: loc,
    sessionStorage: { setItem() {}, getItem() { return null; }, removeItem() {} },
    navigator: { userAgent: 'node-test' },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    console,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    URLSearchParams,
  };
  vm.createContext(sandbox);

  const code = fs.readFileSync(APP_SRC, 'utf8');
  // The IIFE self-executes. With a truthy session, enterApp() runs and calls
  // route(), which previously threw `ReferenceError: container is not defined`
  // and left #view empty. Any such throw now surfaces as an unhandled rejection
  // and, more importantly, leaves #view blank — both detected below.
  let rejection = null;
  const onReject = (r) => { rejection = r; };
  process.on('unhandledRejection', onReject);
  try {
    vm.runInContext(code, sandbox, { filename: 'app.js' });
    // Let the async boot chain (enterApp -> await refreshMaturity -> route) run.
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    process.off('unhandledRejection', onReject);
  }

  const view = doc.querySelector('#view');
  assert.equal(rejection, null,
    `boot produced an unhandled rejection: ${rejection && (rejection.message || rejection)}`);
  assert.ok(view.innerHTML && view.innerHTML.length > 0,
    '#view must be rendered, not left blank (FE-001 regression)');
  assert.ok(view.innerHTML.length > 50,
    '#view should contain real rendered content, not just a placeholder');
});
