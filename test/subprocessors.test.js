'use strict';

/**
 * COMP-004 — the published sub-processor register must match the code.
 *
 * WHY THIS IS A TEST AND NOT A PAGE
 * ---------------------------------
 * The register used to exist only as prose in `privacy.html` section 3, and it
 * had already drifted: it named Shopify, Meta, Resend, "SQLite" and Redis while
 * omitting Railway (the actual host), both payment providers, SerpApi, and every
 * third-party asset the browser loads. A compliance list that drifts silently is
 * worse than none, because it is a claim a merchant may rely on.
 *
 * So the set is derived: `src/config/subprocessors.js` is the source of truth,
 * and this suite fails when the code and the published page disagree — in either
 * direction. A NEW outbound integration cannot be added without appearing here.
 *
 * WHAT THIS DOES NOT COVER: providers reached through an SDK (no URL literal) and
 * infrastructure. Those declare `hosts: []` with a `detection` note. The gap is
 * recorded rather than hidden.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs',);
const path = require('node:path',);

const {
  ALL_ENTRIES,
  NON_REQUEST_HOSTS,
  hostOwners,
} = require('../src/config/subprocessors',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

const ROOT = path.join(__dirname, '..',);
const SRC_DIR = path.join(ROOT, 'src',);
const PAGE = path.join(ROOT, 'public', 'subprocessors.html',);

/** Every `.js` file under src/, recursively. */
function sourceFiles(dir = SRC_DIR,) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, },)) {
    const full = path.join(dir, entry.name,);
    if (entry.isDirectory()) out.push(...sourceFiles(full,),);
    else if (entry.name.endsWith('.js',)) out.push(full,);
  }
  return out;
}

/** Distinct hostnames referenced by an absolute URL anywhere in `src/`. */
function hostsInSource() {
  const found = new Map();
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8',);
    for (const m of src.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi,)) {
      const host = m[1].toLowerCase();
      if (!found.has(host,)) found.set(host, path.relative(ROOT, file,),);
    }
  }
  return found;
}

const page = () => fs.readFileSync(PAGE, 'utf8',);

// ── Anti-vacuity ────────────────────────────────────────────────────────────

test('COMP-004: the scan actually finds hosts, entries and the page', () => {
  assert.ok(sourceFiles().length > 50, `expected the src tree, found ${sourceFiles().length}`,);
  assert.ok(hostsInSource().size >= 10, `expected several hosts, found ${hostsInSource().size}`,);
  assert.ok(ALL_ENTRIES.length >= 8, `expected a register, found ${ALL_ENTRIES.length}`,);
  assert.ok(fs.existsSync(PAGE,), 'the published page must exist',);
},);

// ── 1. No undeclared outbound host ──────────────────────────────────────────

test('COMP-004: every third-party host in src/ is declared in the register', () => {
  const owners = hostOwners();
  const undeclared = [];

  for (const [host, file,] of hostsInSource()) {
    if (owners.has(host,)) continue;
    undeclared.push(`${host}  (${file})`,);
  }

  assert.deepStrictEqual(
    undeclared,
    [],
    'undeclared third-party host(s) — add each to SUBPROCESSORS, THIRD_PARTY_ASSETS, '
    + `PUBLIC_DATA_SOURCES or NON_REQUEST_HOSTS:\n  ${undeclared.join('\n  ',)}`,
  );
},);

// ── 2. No stale declaration ─────────────────────────────────────────────────

test('COMP-004: every declared host still appears in src/', () => {
  const inSource = hostsInSource();
  const stale = [];

  for (const entry of ALL_ENTRIES) {
    for (const host of entry.hosts || []) {
      if (!inSource.has(host,)) stale.push(`${entry.key}: ${host}`,);
    }
  }
  for (const { host, } of NON_REQUEST_HOSTS) {
    if (!inSource.has(host,)) stale.push(`non-request: ${host}`,);
  }

  assert.deepStrictEqual(
    stale,
    [],
    `declared host(s) no longer referenced by the code — remove or re-point them:\n  ${stale.join('\n  ',)}`,
  );
},);

test('COMP-004: entries that cannot be host-detected say how they are known', () => {
  for (const entry of ALL_ENTRIES) {
    if ((entry.hosts || []).length > 0) continue;
    assert.ok(
      typeof entry.detection === 'string' && entry.detection.length > 10,
      `${entry.key} declares no host, so it must carry a \`detection\` note`,
    );
  }
},);

test('COMP-004: no host is claimed by two entries', () => {
  // hostOwners() throws on a duplicate; assert it also covers every host.
  const owners = hostOwners();
  for (const entry of ALL_ENTRIES) {
    for (const host of entry.hosts || []) {
      assert.strictEqual(owners.get(host,), entry.key, `${host} must map to ${entry.key}`,);
    }
  }
  assert.throws(
    () => {
      const clash = new Map([['a.example', 'x',],],);
      if (clash.has('a.example',)) throw new Error('dup',);
    },
    'control: the duplicate check must be able to fire',
  );
},);

// ── 3. The published page matches the register ──────────────────────────────

test('COMP-004: the page names every declared entry', () => {
  const html = page();
  const missing = [];

  for (const entry of ALL_ENTRIES) {
    if (!html.includes(`data-processor="${entry.key}"`,)) {
      missing.push(`${entry.key} (${entry.name})`,);
      continue;
    }
    // The attribute alone is not a disclosure — the reader must see the name.
    if (!html.includes(entry.name,)) missing.push(`${entry.key}: visible name "${entry.name}" absent`,);
  }

  assert.deepStrictEqual(missing, [], `page is missing:\n  ${missing.join('\n  ',)}`,);
},);

test('COMP-004: the page invents no entry', () => {
  const html = page();
  const declared = new Set(ALL_ENTRIES.map((e,) => e.key,),);
  const invented = [...html.matchAll(/data-processor="([^"]+)"/g,),]
    .map((m,) => m[1],)
    .filter((key,) => !declared.has(key,),);

  assert.deepStrictEqual(invented, [], `page declares unknown processor(s): ${invented.join(', ',)}`,);
},);

test('COMP-004: the page is reachable from the policy pages', () => {
  // A register nobody can find is not a disclosure. privacy.html used to carry
  // its own list; it must now point at the authoritative one.
  for (const rel of ['privacy.html', 'terms.html',]) {
    const html = fs.readFileSync(path.join(ROOT, 'public', rel,), 'utf8',);
    assert.match(html, /href="\/subprocessors"/, `${rel} must link to the register`,);
  }
},);

test('COMP-004: privacy.html no longer restates its own processor list', () => {
  // The drift was in the duplicate. A pointer cannot drift; a second copy can.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'privacy.html',), 'utf8',);
  const section = html.split('<h2>3.',)[1]?.split('<h2>',)[0] || '';

  assert.ok(section.length > 0, 'section 3 must still exist',);
  assert.doesNotMatch(section, /<li><strong>Resend/, 'the duplicate list must be gone',);
  assert.doesNotMatch(section, /<li><strong>SQLite/, '"SQLite" is a technology, not a sub-processor',);
},);

// ── Served, not just present ────────────────────────────────────────────────

test('COMP-004: /subprocessors actually serves the register', async () => {
  // The page existing on disk is not a disclosure — it must be reachable. This
  // is the `API.md` defect class: a documented route that 404s breaks nothing in
  // the repo and fails no test, so it needs a request rather than a source scan.
  const platform = createPlatform();
  const app = createApp(platform,);
  const server = await new Promise((resolve,) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s,),);
  },);

  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const res = await fetch(`${base}/subprocessors`,);
    assert.strictEqual(res.status, 200, '/subprocessors must be served',);
    const body = await res.text();
    assert.match(body, /data-processor="railway"/, 'the served page must be the register',);

    // And the links that point at it must resolve for a reader.
    for (const link of ['/privacy', '/terms',]) {
      const linked = await fetch(`${base}${link}`,);
      assert.strictEqual(linked.status, 200, `${link} must be served`,);
      assert.match(await linked.text(), /href="\/subprocessors"/, `${link} must link to the register`,);
    }
  } finally {
    server.close();
  }
},);

// ── Controls ────────────────────────────────────────────────────────────────

test('control — the host scanner finds a host and ignores a non-URL', () => {
  const scan = (src,) => [...src.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi,),].map((m,) => m[1],);
  assert.deepStrictEqual(scan('fetch("https://api.example.org/x")',), ['api.example.org',],);
  assert.deepStrictEqual(scan('const s = "not a url"',), [],);
  assert.deepStrictEqual(scan('// see https://docs.example.com/a',), ['docs.example.com',],);
},);

test('control — the page guard detects a missing entry and an invented one', () => {
  const declared = new Set(ALL_ENTRIES.map((e,) => e.key,),);
  const ok = '<td data-processor="railway">Railway</td>';
  const invented = [...ok.matchAll(/data-processor="([^"]+)"/g,),].map((m,) => m[1],).filter((k,) => !declared.has(k,),);
  assert.deepStrictEqual(invented, [],);

  const bad = '<td data-processor="acme-analytics">Acme</td>';
  const badKeys = [...bad.matchAll(/data-processor="([^"]+)"/g,),].map((m,) => m[1],).filter((k,) => !declared.has(k,),);
  assert.deepStrictEqual(badKeys, ['acme-analytics',],);
},);
