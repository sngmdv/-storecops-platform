'use strict';

process.env.NODE_ENV = 'test';

/**
 * FE-003 — the client pages must be usable without a mouse and without sight.
 *
 * WHAT THIS PINS
 * --------------
 *   1. Every visible form control has a programmatic accessible name. A
 *      placeholder is not a name: it is not reliably announced, and it vanishes
 *      the moment the user types.
 *   2. No `<label>` is used purely as a layout container. A label with nothing
 *      to label adds a nameless node to the accessibility tree.
 *   3. Anything clickable that is not a native control is reachable by keyboard
 *      and announced correctly — either it declares `role` + `tabindex`, or it
 *      already contains a focusable control (so a keyboard user has a way in).
 *   4. The password hint states the minimum the SERVER enforces.
 *
 * The ledger's numbers for this item were stale again — it claimed "3/111
 * buttons with aria-label", but there are 32 buttons and none of them is
 * icon-only-without-a-name. The real defects were the ones above. Checks are
 * derived from the pages, so the counts cannot go stale in the other direction.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs',);
const path = require('node:path',);

const { MIN_PASSWORD, } = require('../src/server/auth',);

const PUBLIC_DIR = path.join(__dirname, '..', 'public',);
const PAGES = fs.readdirSync(PUBLIC_DIR,).filter((f,) => f.endsWith('.html',),);
const read = (f,) => fs.readFileSync(path.join(PUBLIC_DIR, f,), 'utf8',);

/** Non-interactive tags that carry no keyboard behaviour of their own. */
const NON_INTERACTIVE = new Set(['div', 'span', 'tr', 'td', 'li',],);

/** `{ page, tag, attrs }` for every non-interactive element with an onclick. */
function clickableNonInteractive(html,) {
  const found = [];
  for (const m of html.matchAll(/<(div|span|tr|td|li)\b([^>]*\bonclick=[^>]*)>/g,)) {
    const tag = m[1];
    if (!NON_INTERACTIVE.has(tag,)) continue;
    // Everything up to the element's own closing tag, so the "is there a
    // focusable control inside?" question is about this element, not the rest
    // of the file. Nested same-name tags make this approximate for deeply
    // nested markup; the elements that matter here are not.
    const close = html.indexOf(`</${tag}>`, m.index,);
    const inner = close === -1 ? '' : html.slice(m.index, close,);
    found.push({ tag, attrs: m[2], inner, index: m.index, },);
  }
  return found;
}

const hasRoleAndTabindex = (attrs,) => /\brole=/.test(attrs,) && /\btabindex=/.test(attrs,);
const hasFocusableInside = (inner,) => /<button\b|<a\b[^>]*href=|<input\b|<select\b|<textarea\b/.test(inner,);

// ── Comment stripping ───────────────────────────────────────────────────────
// A guard satisfied by commented-out code is not a guard: commenting out a
// broken fix is precisely how a developer disables it, and the markup stays in
// the file. Strip before inspecting.

const stripHtmlComments = (src,) => src.replace(/<!--[\s\S]*?-->/g, '',);
const stripCssComments = (src,) => src.replace(/\/\*[\s\S]*?\*\//g, '',);

/**
 * Line comments, plus block comments. The `[^:]` guard preserves `https://`.
 * Both bundles were checked: no `//` appears inside a string or regex literal,
 * so this heuristic is exact for them.
 */
const stripJsComments = (src,) =>
  stripCssComments(src,).replace(/(^|[^:])\/\/[^\n]*/gm, '$1',);

/**
 * The body of the `addEventListener("keydown", ...)` delegation, located by
 * brace matching rather than by a fixed character window — a window either
 * misses the tail or spills into the next function, and either way the guard
 * stops being about *this* handler.
 */
function delegationBody(src,) {
  const clean = stripJsComments(src,);
  const start = clean.indexOf('addEventListener("keydown", (event) => {',);
  if (start === -1) return null;

  const open = clean.indexOf('{', start,);
  let depth = 0;
  let quote = null;
  for (let i = open; i < clean.length; i += 1) {
    const ch = clean[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return clean.slice(open + 1, i,);
    }
  }
  return null;
}

// ── Anti-vacuity ────────────────────────────────────────────────────────────

test('a11y: the scan actually finds controls, labels and clickable elements', () => {
  assert.ok(PAGES.length >= 8, `expected the client pages, found ${PAGES.length}`,);
  const all = PAGES.map(read,).join('\n',);
  assert.ok(/<input\b/.test(all,), 'the scan must find form controls',);
  assert.ok(/<label\b/.test(all,), 'the scan must find labels',);
  assert.ok(/onclick=/.test(all,), 'the scan must find clickable elements',);
},);

// ── 1. Every visible control has an accessible name ─────────────────────────

test('FE-003: every visible form control has an accessible name', () => {
  const offenders = [];

  for (const page of PAGES) {
    const html = stripHtmlComments(read(page,),);
    for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g,)) {
      const tag = m[1];
      const attrs = m[2];
      const type = (attrs.match(/\btype="([^"]*)"/,) || [])[1] || '';
      if (type === 'hidden' || type === 'submit' || type === 'button') continue;

      if (/\baria-label=|\baria-labelledby=/.test(attrs,)) continue;

      const id = (attrs.match(/\bid="([^"]*)"/,) || [])[1];
      if (id && new RegExp(`<label\\b[^>]*\\bfor="${id}"`,).test(html,)) continue;

      // Implicit association: the control sits inside its label.
      const before = html.slice(0, m.index,);
      const lastOpen = before.lastIndexOf('<label',);
      const lastClose = before.lastIndexOf('</label>',);
      if (lastOpen > lastClose) continue;

      offenders.push(`${page}: <${tag}${id ? ` id="${id}"` : ''}${type ? ` type="${type}"` : ''}>`,);
    }
  }

  assert.deepStrictEqual(offenders, [], `control(s) with no accessible name:\n  ${offenders.join('\n  ',)}`,);
},);

// ── 2. No label without something to label ──────────────────────────────────

test('FE-003: no <label> is used as a layout container', () => {
  const offenders = [];

  for (const page of PAGES) {
    const html = stripHtmlComments(read(page,),);
    for (const m of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g,)) {
      if (/\bfor=/.test(m[1],)) continue;
      if (/<(input|select|textarea)\b/.test(m[2],)) continue;
      offenders.push(`${page}: ${m[0].replace(/\s+/g, ' ',).slice(0, 90,)}`,);
    }
  }

  assert.deepStrictEqual(offenders, [], `label(s) with nothing to label:\n  ${offenders.join('\n  ',)}`,);
},);

// ── 3. Non-native clickables are keyboard reachable ─────────────────────────

test('FE-003: every non-native clickable is keyboard reachable and announced', () => {
  const offenders = [];

  for (const page of PAGES) {
    for (const el of clickableNonInteractive(stripHtmlComments(read(page,),),)) {
      if (hasRoleAndTabindex(el.attrs,)) continue;
      // A row whose own "Detail" button is keyboard reachable is usable without
      // a mouse; adding role="button" to a <tr> would instead destroy its table
      // semantics for assistive tech. So an inner control is a valid answer.
      if (hasFocusableInside(el.inner,)) continue;
      offenders.push(`${page}: <${el.tag} ${el.attrs.replace(/\s+/g, ' ',).slice(0, 80,)}>`,);
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `clickable element(s) unreachable by keyboard:\n  ${offenders.join('\n  ',)}`,
  );
},);

test('FE-003: the SPA bundle marks its clickable cards the same way', () => {
  const bundle = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'app.js',), 'utf8',);
  const offenders = clickableNonInteractive(stripJsComments(bundle,),)
    .filter((el,) => !hasRoleAndTabindex(el.attrs,),)
    .filter((el,) => !hasFocusableInside(el.inner,),)
    .map((el,) => `<${el.tag} ${el.attrs.replace(/\s+/g, ' ',).slice(0, 80,)}>`,);

  assert.deepStrictEqual(offenders, [], `unreachable element(s) in app.js:\n  ${offenders.join('\n  ',)}`,);
},);

test('FE-003: both bundles delegate Enter/Space to those elements', () => {
  // `role` + `tabindex` makes a div focusable and announced, but a div still
  // has no default activation. Without this, the fix is cosmetic.
  //
  // Scoped to THIS handler's body, not to the file. app.js also attaches a
  // `keydown` listener to the bookkeeping input, so a file-scoped check passes
  // while the delegation itself is renamed away and the fix silently becomes
  // cosmetic again.
  for (const rel of [path.join('js', 'app.js',), 'admin.html',]) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, rel,), 'utf8',);
    const body = delegationBody(src,);
    assert.ok(body, `${rel} must wire an Enter/Space delegation`,);
    assert.match(body, /closest\('\[role="button"\]\[tabindex\]'\)/, `${rel} must target the marked elements`,);
    assert.match(body, /el\.click\(\)/, `${rel} must activate the element`,);
    assert.match(body, /"Enter"/, `${rel} must accept Enter`,);
    assert.match(body, /" "/, `${rel} must accept Space`,);
  }
},);

// ── 4. The password hint matches what the server enforces ───────────────────

test('FE-003: the signup password hint states the enforced minimum', () => {
  const html = read('app.html',);

  assert.ok(
    html.includes(`min ${MIN_PASSWORD} characters`,),
    `the hint must state the real minimum (${MIN_PASSWORD})`,
  );

  // And it must not still advertise a different number.
  const claimed = [...html.matchAll(/min (\d+) characters/g,),].map((m,) => Number(m[1],),);
  assert.deepStrictEqual(claimed, [MIN_PASSWORD,],);
},);

// ── 5. The .sr-only utility is available wherever it is used ────────────────

test('FE-003: every page using .sr-only loads a stylesheet that defines it', () => {
  const offenders = [];

  for (const page of PAGES) {
    const html = stripHtmlComments(read(page,),);
    // `(?=[\s"])` — a bare `\b` also matches the boundary inside `.sr-only-x`,
    // because `-` is a non-word character. A renamed utility would then satisfy
    // the check while defining nothing.
    if (!/class="[^"]*\bsr-only(?=[\s"])/.test(html,)) continue;

    const sheets = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g,),]
      .map((m,) => m[1],)
      .filter((href,) => href.startsWith('/styles/',),);

    if (sheets.length === 0) {
      offenders.push(`${page}: uses .sr-only but loads no local stylesheet`,);
      continue;
    }
    const defines = sheets.some((href,) => {
      const file = path.join(PUBLIC_DIR, href.replace(/^\//, '',),);
      return fs.existsSync(file,)
        && /\.sr-only(?=[\s,{])/.test(stripCssComments(fs.readFileSync(file, 'utf8',),),);
    },);
    if (!defines) offenders.push(`${page}: .sr-only used but not defined in ${sheets.join(', ',)}`,);
  }

  assert.deepStrictEqual(offenders, [], offenders.join('\n',),);
},);

// ── Controls ────────────────────────────────────────────────────────────────

test('control — the accessible-name guard detects an unlabelled control', () => {
  const named = (html, id,) => new RegExp(`<label\\b[^>]*\\bfor="${id}"`,).test(html,);
  assert.strictEqual(named('<label for="a">A</label><input id="a">', 'a',), true,);
  assert.strictEqual(named('<label>A</label><input id="a">', 'a',), false,);
  assert.strictEqual(named('<label for="b">B</label><input id="a">', 'a',), false,);
},);

test('control — the keyboard guard detects an unmarked clickable div', () => {
  const ok = (attrs,) => /\brole=/.test(attrs,) && /\btabindex=/.test(attrs,);
  assert.strictEqual(ok(' class="card" role="button" tabindex="0" onclick="go()"',), true,);
  assert.strictEqual(ok(' class="card" onclick="go()"',), false,);
  // role without tabindex is still not reachable.
  assert.strictEqual(ok(' role="button" onclick="go()"',), false,);
},);

test('control — the label guard detects a label with nothing to label', () => {
  const orphan = (inner, attrs = '',) => !/\bfor=/.test(attrs,) && !/<(input|select|textarea)\b/.test(inner,);
  assert.strictEqual(orphan('Email',), true,);
  assert.strictEqual(orphan('<input id="x">',), false,);
  assert.strictEqual(orphan('Email', ' for="x"',), false,);
},);

test('control — the delegation guard is scoped to the handler, not the file', () => {
  const src = [
    'document.addEventListener("keydown", (event) => {',
    '  if (event.key !== "Enter") return;',
    '  event.target.closest(\'[role="button"][tabindex]\').click();',
    '});',
    '$("#bk-input").addEventListener("keydown", (e) => { save(); });',
  ].join('\n',);

  const body = delegationBody(src,);
  assert.ok(body,);
  assert.match(body, /closest\(/,);
  assert.doesNotMatch(body, /save\(\)/, 'the unrelated listener must not leak into the body',);

  // Renaming the delegation away leaves the unrelated listener behind. That is
  // exactly how the first version of this guard passed while the fix was dead.
  const renamed = src.replace(
    'document.addEventListener("keydown"',
    'document.addEventListener("keydown-disabled"',
  );
  assert.match(renamed, /addEventListener\("keydown"/, 'a file-scoped check is still satisfied',);
  assert.strictEqual(delegationBody(renamed,), null, 'the handler-scoped check is not',);
},);

test('control — the .sr-only guard rejects a renamed utility', () => {
  const defines = (css,) => /\.sr-only(?=[\s,{])/.test(css,);
  assert.strictEqual(defines('.sr-only {\n  position: absolute;\n}',), true,);
  assert.strictEqual(defines('.sr-only, .visually-hidden {',), true,);
  assert.strictEqual(defines('.sr-only-disabled {\n  position: absolute;\n}',), false,);
  // The bare `\b` form was fooled by exactly this, because `-` is a non-word
  // character and so is a word boundary.
  assert.strictEqual(/\.sr-only\b/.test('.sr-only-disabled {',), true,);
},);

test('control — commented-out markup does not satisfy the page guards', () => {
  const html = '<!-- <label for="email">Email</label> --><input id="email">';
  assert.match(html, /for="email"/, 'the raw source still contains it',);
  assert.doesNotMatch(stripHtmlComments(html,), /for="email"/, 'the stripped source does not',);
},);
