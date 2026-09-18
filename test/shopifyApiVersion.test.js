'use strict';

/**
 * Shopify Admin API version — single source of truth.
 *
 * The defect these lock down: `billingService.js` fell back to `2025-01` while
 * `config.js` and `integrations.js` both used `2026-07`. `2025-01` is a version
 * Shopify no longer serves, so any caller that passed a config object without
 * `shopifyApiVersion` got a silently broken billing path — the failure looks
 * like a generic 4xx, not a config error.
 *
 * The real guard is the source scan at the bottom: it fails if a fourth literal
 * appears anywhere in `src/`, which is how the drift happened in the first place.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs',);
const path = require('node:path',);

const {
  DEFAULT_SHOPIFY_API_VERSION,
  UNSUPPORTED_SHOPIFY_API_VERSIONS,
  resolveShopifyApiVersion,
} = require('../src/config/shopifyApiVersion',);
const { createPlatform, } = require('../src/platform',);

const SRC_DIR = path.join(__dirname, '..', 'src',);
// This module is where the unsupported list legitimately lives.
const DEFINITION_FILE = path.join(SRC_DIR, 'config', 'shopifyApiVersion.js',);

/**
 * Remove comments so a version mentioned only in prose is not counted as a use.
 * Without this the scan would flag the explanatory comments that document the
 * very bug being guarded against.
 */
function stripComments(source,) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '',)
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1',);
}

function collectJsFiles(dir,) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, },)) {
    const full = path.join(dir, entry.name,);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      found.push(...collectJsFiles(full,),);
    } else if (entry.name.endsWith('.js',)) {
      found.push(full,);
    }
  }
  return found;
}

test('the default version is not one Shopify has dropped', () => {
  assert.ok(DEFAULT_SHOPIFY_API_VERSION,);
  assert.ok(
    !UNSUPPORTED_SHOPIFY_API_VERSIONS.includes(DEFAULT_SHOPIFY_API_VERSION,),
    `the default (${DEFAULT_SHOPIFY_API_VERSION}) must not be a dropped version`,
  );
},);

test('control: the unsupported list is not empty', () => {
  // If this list were empty the source scan below would pass vacuously — it
  // would be searching for nothing and always succeed.
  assert.ok(UNSUPPORTED_SHOPIFY_API_VERSIONS.length > 0,);
  assert.ok(UNSUPPORTED_SHOPIFY_API_VERSIONS.includes('2025-01',),);
},);

test('an explicit value wins over the environment and the default', () => {
  const previous = process.env.SHOPIFY_API_VERSION;
  process.env.SHOPIFY_API_VERSION = '2026-10';
  try {
    assert.strictEqual(resolveShopifyApiVersion('2026-04',), '2026-04',);
    assert.strictEqual(resolveShopifyApiVersion(undefined,), '2026-10',);
    assert.strictEqual(resolveShopifyApiVersion('',), '2026-10', 'empty string is not a value',);
  } finally {
    if (previous === undefined) delete process.env.SHOPIFY_API_VERSION;
    else process.env.SHOPIFY_API_VERSION = previous;
  }
},);

test('with nothing supplied it falls back to the supported default', () => {
  const previous = process.env.SHOPIFY_API_VERSION;
  delete process.env.SHOPIFY_API_VERSION;
  try {
    // This is the exact call the billing path makes when handed a partial config.
    assert.strictEqual(resolveShopifyApiVersion(undefined,), DEFAULT_SHOPIFY_API_VERSION,);
    assert.strictEqual(resolveShopifyApiVersion(), DEFAULT_SHOPIFY_API_VERSION,);
  } finally {
    if (previous !== undefined) process.env.SHOPIFY_API_VERSION = previous;
  }
},);

test('the live platform config carries a supported version', () => {
  const platform = createPlatform();
  const version = platform.config.shopifyApiVersion;

  assert.ok(version,);
  assert.ok(
    !UNSUPPORTED_SHOPIFY_API_VERSIONS.includes(version,),
    `platform.config.shopifyApiVersion resolved to a dropped version: ${version}`,
  );
},);

test('no source file hardcodes a dropped version outside this definition', () => {
  const files = collectJsFiles(SRC_DIR,);
  // Anti-vacuity: a scan that reads no files proves nothing.
  assert.ok(files.length > 50, `expected to scan the source tree, found ${files.length} files`,);

  const offenders = [];
  for (const file of files) {
    if (file === DEFINITION_FILE) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8',),);
    for (const version of UNSUPPORTED_SHOPIFY_API_VERSIONS) {
      if (code.includes(version,)) {
        offenders.push(`${path.relative(SRC_DIR, file,)} mentions ${version}`,);
      }
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    'a dropped API version must never be a code literal — derive it via ' +
      `resolveShopifyApiVersion() instead:\n${offenders.join('\n',)}`,
  );
},);
