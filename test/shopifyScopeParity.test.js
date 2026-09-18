'use strict';

/**
 * Guard test: the Shopify scopes we request during OAuth must match the scopes
 * declared in shopify.app.toml.
 *
 * These are two independent lists — one is JavaScript, one is TOML read by the
 * Shopify CLI — and they had already drifted: the OAuth request asked for
 * read_products,read_orders,read_customers while the manifest declared those
 * plus read_inventory. The inventory ledger needs read_inventory, so the grant
 * was narrower than the manifest and the stock feed silently failed.
 *
 * Nothing else in the suite compares them, so this is the only thing standing
 * between the two lists and another silent divergence.
 */

const { describe, it, } = require('node:test',);
const assert = require('node:assert/strict',);
const fs = require('node:fs',);
const path = require('node:path',);

const { PLATFORM_CONFIG, } = require('../src/server/oauthConnectors',);

const TOML_PATH = path.join(__dirname, '..', 'shopify.app.toml',);

/** Parse the declared scopes out of [access_scopes] in the manifest. */
function declaredScopes() {
  const raw = fs.readFileSync(TOML_PATH, 'utf8',);

  // Strip comments first: the file documents the removed scopes in prose
  // (read_script_tags, write_products, …) and a naive scan would pick those up
  // as if they were still declared.
  const withoutComments = raw
    .split('\n',)
    .map((line,) => {
      const hash = line.indexOf('#',);
      return hash === -1 ? line : line.slice(0, hash,);
    },)
    .join('\n',);

  const match = withoutComments.match(/\[access_scopes\][\s\S]*?scopes\s*=\s*"([^"]*)"/,);
  assert.ok(match, 'could not find [access_scopes].scopes in shopify.app.toml',);

  return match[1]
    .split(',',)
    .map((s,) => s.trim(),)
    .filter(Boolean,)
    .sort();
}

describe('shopify scope parity', () => {
  it('requests exactly the scopes the manifest declares', () => {
    const declared = declaredScopes();
    const requested = String(PLATFORM_CONFIG.shopify.scopes,)
      .split(',',)
      .map((s,) => s.trim(),)
      .filter(Boolean,)
      .sort();

    assert.deepEqual(
      requested,
      declared,
      'oauthConnectors.js and shopify.app.toml have drifted. Update both together.',
    );
  },);

  it('still requests the scopes the code actually depends on', () => {
    const requested = PLATFORM_CONFIG.shopify.scopes;

    // integrations.js reads products/orders/customers; inventoryLedger.js reads
    // stock levels. Dropping any of these breaks a live feature.
    for (const scope of ['read_products', 'read_orders', 'read_customers', 'read_inventory',]) {
      assert.ok(requested.includes(scope,), `missing required scope: ${scope}`,);
    }
  },);

  it('does not request scopes the App Store review rejects', () => {
    const requested = PLATFORM_CONFIG.shopify.scopes;

    // Broad write scopes and the deprecated Script Tag scopes are the most
    // common cause of rejection, and nothing in the codebase uses them.
    for (const scope of ['write_products', 'write_orders', 'write_customers', 'write_themes', 'read_script_tags', 'write_script_tags',]) {
      assert.ok(!requested.includes(scope,), `unused scope must not be requested: ${scope}`,);
    }
  },);
},);
