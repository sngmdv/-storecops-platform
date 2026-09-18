'use strict';

/**
 * M10 — responsive table containment.
 *
 * `overflow-x` does NOT apply to an element with `display: table`, so a table
 * cannot scroll itself. Every table wider than the viewport therefore needs a
 * block-level wrapper that scrolls. On a 375px phone that is *every* table in
 * `public/`: the legal pages have no min-width, and `app.css` sets
 * `table { min-width: 500px }` below 560px.
 *
 * The browser matrix found three violations — /subprocessors (124px),
 * /tracker-disclosure (228px) and admin.html's "Fraud by Store" table, which
 * was invisible because the harness never got past the admin login card. This
 * guard exists so a fourth cannot be added silently, since a table that is
 * merely *present* renders fine on a desktop and fails only on a phone.
 */

const test = require('node:test',);
const assert = require('node:assert/strict',);
const fs = require('node:fs',);
const path = require('node:path',);

const ROOT = path.join(__dirname, '..',);
const PUBLIC_DIR = path.join(ROOT, 'public',);
const STYLES_DIR = path.join(PUBLIC_DIR, 'styles',);

const stripHtmlComments = (src,) => src.replace(/<!--[\s\S]*?-->/g, '',);
const stripCssComments = (src,) => src.replace(/\/\*[\s\S]*?\*\//g, '',);

/** A `<div>` opening tag that establishes a horizontal scroll container, with
 * only whitespace between it and the `<table>` it wraps. Anchored at the end
 * of the prefix, so a wrapper that closes *before* the table does not count. */
const SCROLL_WRAPPER =
  /<div\b[^>]*(?:overflow-x\s*:|class="[^"]*\btable-scroll(?=[\s"]))[^>]*>\s*$/;

/** `\b` is not enough after a hyphenated identifier — `-` is a non-word char,
 * so `table-scroll\b` would also match `table-scroll-disabled`. */
const CLASS_USE = /class="[^"]*\btable-scroll(?=[\s"])/;
const CLASS_DEF = /\.table-scroll(?=[\s,{])/;

function pages() {
  return fs
    .readdirSync(PUBLIC_DIR,)
    .filter((f,) => f.endsWith('.html',),)
    .map((f,) => path.join(PUBLIC_DIR, f,),)
    .sort();
}

function sheets() {
  const out = new Map();
  for (const f of fs.readdirSync(STYLES_DIR,)) {
    if (f.endsWith('.css',)) {
      out.set(f, fs.readFileSync(path.join(STYLES_DIR, f,), 'utf8',),);
    }
  }
  return out;
}

/** Every `<table>` in the page that is NOT immediately preceded by a scroll
 * container, reported with its line number so the failure is actionable. */
function unwrappedTables(html,) {
  const clean = stripHtmlComments(html,);
  const bad = [];
  for (const m of clean.matchAll(/<table\b/g,)) {
    if (SCROLL_WRAPPER.test(clean.slice(0, m.index,),)) continue;
    const line = clean.slice(0, m.index,).split('\n',).length;
    bad.push(line,);
  }
  return bad;
}

test('M10: every table in public/ sits in a scroll container', () => {
  const offenders = [];
  for (const file of pages()) {
    const html = fs.readFileSync(file, 'utf8',);
    const bad = unwrappedTables(html,);
    if (bad.length > 0) {
      offenders.push(
        `${path.relative(ROOT, file,)} line(s) ${bad.join(', ',)}`,
      );
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'a <table> is not a scroll container — wrap it in '
      + '<div class="table-scroll"> or <div style="overflow-x:auto">:\n  '
      + offenders.join('\n  ',),
  );
},);

test('M10: table open/close tags are balanced in every page', () => {
  for (const file of pages()) {
    const html = stripHtmlComments(fs.readFileSync(file, 'utf8',),);
    const open = (html.match(/<table\b/g,) || []).length;
    const close = (html.match(/<\/table>/g,) || []).length;
    assert.strictEqual(
      open,
      close,
      `${path.relative(ROOT, file,)} has ${open} <table> and ${close} </table>`,
    );
  }
},);

test('M10: the scroll wrapper class is defined by a sheet the page loads', () => {
  const all = sheets();
  for (const file of pages()) {
    const html = stripHtmlComments(fs.readFileSync(file, 'utf8',),);
    if (!CLASS_USE.test(html,)) continue;

    const linked = [...html.matchAll(/href="\/styles\/([^"]+)"/g,),].map((m,) => m[1],);
    assert.ok(
      linked.length > 0,
      `${path.relative(ROOT, file,)} uses table-scroll but links no stylesheet`,
    );

    const defined = linked.some((name,) => {
      const css = all.get(name,);
      return Boolean(css,) && CLASS_DEF.test(stripCssComments(css,),);
    },);
    assert.ok(
      defined,
      `${path.relative(ROOT, file,)} wraps tables in .table-scroll, but none of `
        + `its stylesheets (${linked.join(', ',)}) defines .table-scroll — the `
        + 'wrapper is inert markup and the table still overflows.',
    );
  }
},);

test('M10: no page links a stylesheet that does not exist', () => {
  const all = sheets();
  for (const file of pages()) {
    const html = fs.readFileSync(file, 'utf8',);
    for (const m of html.matchAll(/href="\/styles\/([^"]+)"/g,)) {
      assert.ok(
        all.has(m[1],),
        `${path.relative(ROOT, file,)} links /styles/${m[1]} which is not on disk`,
      );
    }
  }
},);

/** An inline `<code>` token with no whitespace long enough to exceed a phone
 * viewport on its own. `overflow-wrap` has nothing to break on, so it pushes
 * the whole document wide even when every table is contained. */
const LONG_CODE_TOKEN = /<code>([^\s<]{30,})<\/code>/g;
const BREAK_RULE = /overflow-wrap\s*:\s*anywhere|word-break\s*:\s*break-(all|word)/;

const longCodeTokens = (html,) => [...stripHtmlComments(html,).matchAll(LONG_CODE_TOKEN,),].map((m,) => m[1],);
const hasBreakRule = (css,) => BREAK_RULE.test(stripCssComments(css,),);

test('M10: a long inline <code> token has a break opportunity available', () => {
  const all = sheets();
  for (const file of pages()) {
    const html = fs.readFileSync(file, 'utf8',);
    const tokens = longCodeTokens(html,);
    if (tokens.length === 0) continue;

    const linked = [...html.matchAll(/href="\/styles\/([^"]+)"/g,),].map((m,) => m[1],);
    const breaks = linked.some((name,) => {
      const css = all.get(name,);
      return Boolean(css,) && hasBreakRule(css,);
    },);
    assert.ok(
      breaks,
      `${path.relative(ROOT, file,)} contains unbreakable inline tokens `
        + `(e.g. ${tokens[0].slice(0, 40,)}) but none of its stylesheets `
        + `(${linked.join(', ',)}) sets overflow-wrap:anywhere or `
        + 'word-break:break-all — the token will push the document past a '
        + 'phone viewport.',
    );
  }
},);

test('M10: the long-token guard detects an unbreakable token (control)', () => {
  const long = 'window.Shopify.customerPrivacy.analyticsProcessingAllowed';
  assert.deepStrictEqual(longCodeTokens(`<p><code>${long}</code></p>`,), [long,],);
  assert.deepStrictEqual(longCodeTokens('<p><code>short</code></p>',), [],);
  // A break opportunity inside the token means it is not a hazard.
  assert.deepStrictEqual(longCodeTokens('<p><code>a b c d e f g h i j k l m n o p</code></p>',), [],);

  assert.ok(hasBreakRule('.legal code { overflow-wrap: anywhere; }',),);
  assert.ok(hasBreakRule('.legal code { word-break: break-all; }',),);
  assert.ok(!hasBreakRule('.legal code { color: red; }',),);
  // A commented-out rule must not satisfy the guard.
  assert.ok(!hasBreakRule('/* .legal code { overflow-wrap: anywhere; } */',),);
},);

test('M10: the guard detects an unwrapped table (control)', () => {
  // If this control ever passes a bare table, the guard above is vacuous.
  const bare = '<div class="card"><table class="a-table"><tr><td>1</td></tr></table></div>';
  assert.deepStrictEqual(unwrappedTables(bare,), [1,],);

  const wrapped = '<div class="table-scroll"><table><tr><td>1</td></tr></table></div>';
  assert.deepStrictEqual(unwrappedTables(wrapped,), [],);

  const wrappedInline = '<div style="overflow-x:auto"><table class="a-table"></table></div>';
  assert.deepStrictEqual(unwrappedTables(wrappedInline,), [],);

  // A wrapper that closes *before* the table must not count.
  const closedTooEarly =
    '<div style="overflow-x:auto"></div><table class="a-table"></table>';
  assert.deepStrictEqual(unwrappedTables(closedTooEarly,), [1,],);

  // A sibling scroll container elsewhere in the page must not count either.
  const elsewhere =
    '<div style="overflow-x:auto"><p>x</p></div><table class="a-table"></table>';
  assert.deepStrictEqual(unwrappedTables(elsewhere,), [1,],);

  // A commented-out wrapper must not satisfy the guard.
  const commented =
    '<!-- <div class="table-scroll"> --><table class="a-table"></table>';
  assert.deepStrictEqual(unwrappedTables(commented,), [1,],);

  // A similarly-prefixed class name must not satisfy the guard.
  const nearMiss =
    '<div class="table-scroll-disabled"><table class="a-table"></table></div>';
  assert.deepStrictEqual(unwrappedTables(nearMiss,), [1,],);
},);
