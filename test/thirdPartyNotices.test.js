'use strict';

process.env.NODE_ENV = 'test';

/**
 * DOC-003 — third-party code must be attributed, and CDN dependencies pinned.
 *
 * Two distinct defects this pins down:
 *
 *   1. **Attribution.** `public/vendor/chart.umd.min.js` is Chart.js, MIT. The minifier keeps the
 *      copyright banner but strips the permission notice, and MIT requires *both*. There was no
 *      THIRD_PARTY_NOTICES anywhere, so the bundled dependency was shipped without its terms.
 *   2. **An unpinned CDN dependency.** Both `public/index.html` and `public/app.html` loaded
 *      `lucide@latest`. Every page load resolved to whatever upstream had most recently published,
 *      so a breaking release would have broken the icon layer with no deploy and no diff to review.
 *
 * The asset list is **derived from the HTML**, not hand-maintained: add a `<script src>` for a new
 * library and this fails until it is documented. Same reasoning as `shopifyScopeParity`,
 * `m2WebhookContract`, `storageIndexes` and `apiDocs`.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs',);
const path = require('node:path',);

const PUBLIC_DIR = path.join(__dirname, '..', 'public',);
const NOTICES = fs.readFileSync(path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md',), 'utf8',);

/**
 * Package CDNs encode the library name in the path (`/lucide@1.47.0/...`).
 * Anything else (Google Fonts, a vendor host) is identified by its hostname.
 */
const PACKAGE_CDNS = new Set(['unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'esm.sh',],);

/** `<link rel>` values that actually fetch a third-party resource. */
const ASSET_RELS = new Set(['stylesheet', 'preconnect', 'dns-prefetch', 'preload',],);

/** Third-party asset references in the shipped HTML: `{ kind, ref, token, file }`. */
function thirdPartyAssets() {
  const found = [];

  const classify = (ref, file,) => {
    const remote = ref.match(/^https?:\/\/([^/]+)\/(.*)$/,);
    if (remote) {
      const [, host, rest,] = remote;
      const token = PACKAGE_CDNS.has(host,)
        // `lucide@1.47.0/dist/umd/lucide.min.js` → `lucide`
        ? (rest.split('/',)[0] || '').split('@',)[0]
        // `fonts.googleapis.com/css2?family=Inter...` → `fonts`
        : host.split('.',)[0];
      found.push({ kind: 'remote', ref, token, file, },);
    } else if (ref.startsWith('/vendor/',)) {
      // Vendored bundle: `chart.umd.min.js` → `chart`.
      found.push({ kind: 'vendored', ref, token: path.basename(ref,).split('.',)[0], file, },);
    }
  };

  for (const file of fs.readdirSync(PUBLIC_DIR,).filter((f,) => f.endsWith('.html',),)) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file,), 'utf8',);

    for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g,)) classify(m[1], file,);

    // Attribute order varies (`rel` before `href` and vice versa), so both are
    // pulled out independently. Only resource-fetching rels count — `<a href>`
    // social links are not third-party *code* and carry no license obligation.
    for (const tag of html.matchAll(/<link[^>]*>/g,)) {
      const t = tag[0];
      const rel = (t.match(/rel="([^"]*)"/,) || [])[1];
      const href = (t.match(/href="([^"]*)"/,) || [])[1];
      if (href && rel && ASSET_RELS.has(rel,)) classify(href, file,);
    }
  }

  return found;
}

const ASSETS = thirdPartyAssets();
const TOKENS = [...new Set(ASSETS.map((a,) => a.token.toLowerCase(),),),];

// ── Anti-vacuity ────────────────────────────────────────────────────────────

test('the asset scan actually found the known third-party dependencies', () => {
  assert.ok(ASSETS.length >= 4, `expected to find the third-party assets, found ${ASSETS.length}`,);
  assert.ok(TOKENS.includes('lucide',), 'the Lucide CDN script must be detected',);
  assert.ok(TOKENS.includes('chart',), 'the vendored Chart.js bundle must be detected',);
  assert.ok(TOKENS.includes('fonts',), 'the Google Fonts link must be detected',);
  assert.ok(NOTICES.length > 1000, 'THIRD_PARTY_NOTICES.md must have been read',);
},);

// ── Attribution ─────────────────────────────────────────────────────────────

test('DOC-003: every third-party asset is documented in THIRD_PARTY_NOTICES.md', () => {
  const lower = NOTICES.toLowerCase();
  const undocumented = [...new Set(ASSETS.filter((a,) => !lower.includes(a.token.toLowerCase(),),)
    .map((a,) => `${a.token} (${a.ref} in ${a.file})`,),),];

  assert.deepStrictEqual(
    undocumented,
    [],
    `third-party code shipped without its terms documented:\n  ${undocumented.join('\n  ',)}`,
  );
},);

test('DOC-003: the notices carry the full permission notice, not just a copyright line', () => {
  // "Released under the MIT License" is not MIT compliance; the permission
  // notice has to travel with the code.
  assert.match(NOTICES, /Permission is hereby granted, free of charge/,);
  assert.match(NOTICES, /THE SOFTWARE IS PROVIDED "AS IS"/,);
  assert.match(NOTICES, /Permission to use, copy, modify, and\/or distribute/,);
},);

test('DOC-003: the vendored Chart.js bundle retains its license banner', () => {
  // The banner is what survives minification; if a future re-vendor drops it,
  // the file alone would carry no evidence of its origin.
  const bundle = fs.readFileSync(path.join(PUBLIC_DIR, 'vendor', 'chart.umd.min.js',), 'utf8',);
  const banner = bundle.slice(0, 400,);

  assert.match(banner, /Chart\.js v\d+\.\d+\.\d+/,);
  assert.match(banner, /Released under the MIT License/,);
  assert.match(banner, /\(c\) \d{4} Chart\.js Contributors/,);
},);

// ── Pinning ─────────────────────────────────────────────────────────────────

test('DOC-003: no CDN script is loaded at a floating version', () => {
  const floating = ASSETS
    .filter((a,) => a.kind === 'remote' && /@(latest|next|beta|canary|\*)/.test(a.ref,),)
    .map((a,) => `${a.ref} (${a.file})`,);

  assert.deepStrictEqual(
    floating,
    [],
    'unpinned CDN dependency — a breaking upstream release breaks the page with no deploy:\n  '
      + floating.join('\n  ',),
  );
},);

test('DOC-003: remote scripts declare an explicit version', () => {
  const unversioned = ASSETS
    .filter((a,) => a.kind === 'remote' && a.ref.endsWith('.js',),)
    .filter((a,) => !/@\d+\.\d+/.test(a.ref,),)
    .map((a,) => `${a.ref} (${a.file})`,);

  assert.deepStrictEqual(unversioned, [], `remote script without a pinned version:\n  ${unversioned.join('\n  ',)}`,);
},);

// ── Control ─────────────────────────────────────────────────────────────────

test('control — the undocumented-asset check can actually fail', () => {
  const lower = NOTICES.toLowerCase();
  const fake = [{ token: 'not-a-real-library-xyz', ref: 'x', file: 'x', },];
  const undoc = fake.filter((a,) => !lower.includes(a.token.toLowerCase(),),);
  assert.strictEqual(undoc.length, 1, 'if this passes, the attribution guard is vacuous',);
},);
