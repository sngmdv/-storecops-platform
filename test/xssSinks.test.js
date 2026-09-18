'use strict';

process.env.NODE_ENV = 'test';

/**
 * XSS sink regression tests for the client bundle.
 *
 * Two sinks were fixed in P2 and both are easy to reintroduce:
 *
 *   1. `toast()` assigned its message straight to `innerHTML`. Toast messages
 *      are built as `${icon(...)} text`, so every interpolated value was an
 *      injection point — including a Shopify customer's name in the live
 *      purchase toast, which a third party controls.
 *   2. Inline `onclick="fn('${value}')"` arguments were escaped with `esc()`.
 *      That is the wrong helper: `esc()` emits `&#39;` for a quote, the HTML
 *      parser decodes it back to `'`, and the JS parser then sees an
 *      unescaped quote and breaks out of the string.
 *
 * The bundle is an IIFE with no exports, so the helpers are reached through a
 * test hook injected immediately before the closing `})();`.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('fs',);
const path = require('path',);
const vm = require('vm',);

const APP_SRC = path.join(__dirname, '..', 'public', 'js', 'app.js',);
const ADMIN_SRC = path.join(__dirname, '..', 'public', 'admin.html',);

function makeEl() {
  const el = {
    _html: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(c,) { this._set.add(c,); },
      remove(c,) { this._set.delete(c,); },
      toggle() {},
      contains(c,) { return this._set.has(c,); },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c,) { return c; },
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
    set(v,) { this._html = String(v,); },
  },);
  return el;
}

function makeDocument() {
  const cache = new Map();
  const get = (sel,) => {
    if (!cache.has(sel,)) cache.set(sel, makeEl(),);
    return cache.get(sel,);
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

/**
 * Load `public/js/app.js` in a stubbed DOM and return its internal helpers.
 *
 * The IIFE is not modified on disk — the export hook is injected into the
 * source string only.
 */
function loadAppInternals() {
  const doc = makeDocument();
  const loc = { search: '', hash: '', };
  const win = {
    StorecopsAPI: {
      session: () => null,
      store: () => null,
      saveSession() {},
      get: () => Promise.resolve({},),
      post: () => Promise.resolve({},),
      liveStream: () => null,
    },
    location: loc,
    Chart: undefined,
    shopify: undefined,
    addEventListener() {},
  };
  const sandbox = {
    window: win,
    document: doc,
    location: loc,
    sessionStorage: { setItem() {}, getItem() { return null; }, removeItem() {}, },
    localStorage: { setItem() {}, getItem() { return null; }, removeItem() {}, },
    navigator: { userAgent: 'node-test', },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({},), },),
    console: { log() {}, warn() {}, error() {}, },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    URLSearchParams,
  };
  vm.createContext(sandbox,);

  const original = fs.readFileSync(APP_SRC, 'utf8',);
  const hook = '\n  window.__internals = { toast, sanitizeToastMarkup, jsAttr, esc, icon, ICONS };\n})();\n';
  const instrumented = original.replace(/\n\}\)\(\);\s*$/, hook,);
  assert.notEqual(instrumented, original, 'failed to inject the test hook into app.js',);

  vm.runInContext(instrumented, sandbox, { filename: 'app.js', },);
  assert.ok(sandbox.window.__internals, 'app.js did not expose its internals',);
  return sandbox.window.__internals;
}

const internals = loadAppInternals();

// ─── toast() markup sanitizer ────────────────────────────────────────────────

test('XSS: toast keeps the app\'s own icon markup', () => {
  const { sanitizeToastMarkup, icon, } = internals;
  const out = sanitizeToastMarkup(`${icon('check-circle',)} Saved`,);

  assert.ok(out.includes('<svg',), 'the trusted icon must survive',);
  assert.ok(out.endsWith(' Saved',),);
},);

test('XSS: toast escapes data interpolated next to an icon', () => {
  const { sanitizeToastMarkup, icon, } = internals;
  const out = sanitizeToastMarkup(`${icon('dollar',)} <img src=x onerror=alert(1)> just bought`,);

  assert.ok(!out.includes('<img',), 'injected markup must not survive',);
  assert.ok(out.includes('&lt;img',), 'it should appear as escaped text',);
  assert.ok(out.includes('<svg',), 'the trusted icon must still render',);
},);

test('XSS: toast drops a forged svg that carries an event handler', () => {
  const { sanitizeToastMarkup, ICONS, } = internals;
  // A plausible attack: borrow a real icon's inner markup so the shape looks
  // familiar, then add an onload to the wrapper.
  const forged = `<svg onload="alert(1)">${ICONS['check-circle']}</svg>`;
  const out = sanitizeToastMarkup(forged,);

  assert.ok(!out.includes('onload',), 'the event handler must be gone',);
  // Re-derivation keeps the icon but rebuilds it without the handler.
  assert.ok(out.includes('<svg',),);
  assert.ok(!/<svg[^>]*onload/i.test(out,),);
},);

test('XSS: toast drops an svg whose inner markup is not one of ours', () => {
  const { sanitizeToastMarkup, } = internals;
  const out = sanitizeToastMarkup('<svg><script>alert(1)</script></svg>',);

  assert.ok(!out.includes('<svg',),);
  assert.ok(!out.includes('<script',),);
},);

test('XSS: a caller cannot forge the internal placeholder', () => {
  const { sanitizeToastMarkup, } = internals;
  // Control characters are stripped before substitution, so a crafted
  // placeholder cannot be used to smuggle markup back in.
  const out = sanitizeToastMarkup('\u00000\u0000<b>x</b>',);

  assert.ok(!out.includes('<b>',),);
  assert.ok(out.includes('&lt;b&gt;',),);
},);

// ─── jsAttr() double-decode escaping ─────────────────────────────────────────

test('XSS: jsAttr survives both the HTML and the JS decode pass', () => {
  const { jsAttr, } = internals;
  const payload = 'x\')-alert(1)-(\'';
  const escaped = jsAttr(payload,);

  // The HTML parser must not be able to terminate the attribute.
  assert.ok(!escaped.includes('"',), 'no raw double quote may remain',);
  // The JS parser must not be able to terminate the string: every quote in the
  // payload is backslash-escaped.
  assert.ok(!/(^|[^\\])'/.test(escaped,), 'no unescaped single quote may remain',);

  // Round-trip: decode the HTML entities, then read it as a JS string literal.
  const htmlDecoded = escaped
    .replace(/&quot;/g, '"',)
    .replace(/&#39;/g, '\'',)
    .replace(/&lt;/g, '<',)
    .replace(/&gt;/g, '>',)
    .replace(/&amp;/g, '&',);
  const evaluated = vm.runInNewContext(`'${htmlDecoded}'`,);
  assert.equal(evaluated, payload, 'the payload must round-trip as data, not code',);
},);

test('XSS: jsAttr neutralises a line-break injection', () => {
  const { jsAttr, } = internals;
  const escaped = jsAttr('a\'\nalert(1)//',);

  assert.ok(!/[\r\n]/.test(escaped,), 'literal newlines must be escaped',);
  const htmlDecoded = escaped.replace(/&#39;/g, '\'',).replace(/&amp;/g, '&',);
  const evaluated = vm.runInNewContext(`'${htmlDecoded}'`,);
  assert.equal(evaluated, 'a\'\nalert(1)//',);
},);

// ─── static guards: the sinks must stay closed ───────────────────────────────

test('XSS: app.js has no remaining unescaped onclick arguments', () => {
  const src = fs.readFileSync(APP_SRC, 'utf8',);
  const offenders = src.split('\n',)
    .map((line, i,) => ({ line, n: i + 1, }),)
    .map(({ line, n, },) => {
      const attr = /onclick="([^"]*)"/.exec(line,);
      return { attr: attr ? attr[1] : null, n, };
    },)
    .filter(({ attr, },) => attr !== null,)
    // Any string interpolation inside the handler must be routed through
    // jsAttr(). A bare `'${` that is not `'${jsAttr(` is the defect.
    .filter(({ attr, },) => /'\$\{(?!jsAttr\()/.test(attr,),);

  assert.deepEqual(offenders.map((o,) => o.n,), [], 'unescaped onclick interpolation found',);
},);

test('XSS: esc() is never used to escape an onclick argument', () => {
  // Scoped to the ATTRIBUTE, not the line. These templates are one line each and
  // routinely put `esc()`-ed cell text beside a converted onclick, so a
  // line-scoped check reports correct code as an offender. The contract is
  // about what the handler is escaped WITH, not what shares its line.
  for (const file of [APP_SRC, ADMIN_SRC,]) {
    const src = fs.readFileSync(file, 'utf8',);
    const bad = [];
    src.split('\n',).forEach((line, i,) => {
      for (const m of line.matchAll(/onclick="([^"]*)"/g,)) {
        if (/\besc\(/.test(m[1],)) bad.push(`${i + 1}: ${m[1].slice(0, 80,)}`,);
      }
    },);
    assert.deepEqual(bad, [], `${path.basename(file,)} uses esc() in an onclick`,);
  }
},);

test('XSS control: the esc()-in-onclick guard is scoped to the attribute', () => {
  const guard = (line,) => [...line.matchAll(/onclick="([^"]*)"/g,),]
    .some((m,) => /\besc\(/.test(m[1],),);

  assert.equal(guard('<b onclick="fn(\'x\')">y</b>',), false,);
  // Fires when esc() is genuinely inside the handler…
  assert.equal(guard('<b onclick="fn(\'${esc(x)}\')">y</b>',), true,);
  // …and stays quiet when the handler is converted and esc() is only escaping
  // sibling text on the same line — the false positive this scoping fixes.
  assert.equal(guard('<b onclick="fn(\'${jsAttr(x)}\')">${esc(y)}</b>',), false,);
},);

test('XSS control: the onclick guard actually detects a planted offender', () => {
  // A green guard proves nothing unless it can fail. Feed it the exact shape
  // it is meant to catch and confirm it fires.
  const guard = (attr,) => /'\$\{(?!jsAttr\()/.test(attr,);

  assert.equal(guard('triggerRecovery(\'${s}\')',), true,);
  assert.equal(guard('toast(\'${p.name} deactivated\')',), true,);
  assert.equal(guard('triggerRecovery(\'${jsAttr(s)}\')',), false,);
  assert.equal(guard('toggleFeature(\'${jsAttr(f.id)}\', ${!f.active})',), false,);
  assert.equal(guard('generateWinbackCampaign(\'${jsAttr(s)}\', ${n.length})',), false,);
},);

test('XSS: the toast sinks no longer assign caller input to innerHTML', () => {
  const app = fs.readFileSync(APP_SRC, 'utf8',);
  assert.ok(
    /el\.innerHTML = sanitizeToastMarkup\(message\)/.test(app,),
    'app.js toast() must route through sanitizeToastMarkup()',
  );

  const admin = fs.readFileSync(ADMIN_SRC, 'utf8',);
  assert.ok(
    /function toast\(msg\) \{ const t = \$\("#toast"\); t\.textContent/.test(admin,),
    'admin.html toast() must set textContent, not innerHTML',
  );
  assert.ok(!/t\.innerHTML = msg/.test(admin,),);
},);
