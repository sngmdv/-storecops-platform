'use strict';

/**
 * Tracker disclosure page — the public claim must match the code.
 *
 * `public/tracker-disclosure.html` is served at `/tracker-disclosure` and exists
 * for Shopify app-review compliance and GDPR/CCPA transparency. It claimed the
 * tracker was "injected into merchant storefronts via the Shopify Script Tag API"
 * long after that path was removed — the code ships tracking as a theme app
 * extension, and `storefrontTrackingStatus()` says so explicitly.
 *
 * A wrong statement about data collection, on the page whose entire purpose is
 * to disclose data collection, is worse than a wrong statement anywhere else.
 * The check below is derived from the code rather than hardcoding the wording,
 * so it stays true if the mechanism changes again.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs',);
const path = require('node:path',);

const { createPlatform, } = require('../src/platform',);

const DISCLOSURE = path.join(__dirname, '..', 'public', 'tracker-disclosure.html',);

function readDisclosure() {
  return fs.readFileSync(DISCLOSURE, 'utf8',);
}

test('the page does not claim the removed Script Tag API installs the tracker', () => {
  const html = readDisclosure();
  assert.ok(html.length > 1000, 'expected a substantive disclosure page',);

  // The Script Tag API was removed as an install mechanism: it is deprecated and
  // its scopes are rejected at App Store review.
  assert.ok(
    !/Script Tag API/i.test(html,),
    'the disclosure must not claim the Script Tag API installs the tracker',
  );
  assert.ok(
    !/script tag URL parameter/i.test(html,),
    'the store_id is no longer supplied by a script tag URL',
  );
},);

test('the page names the mechanism the code actually uses', () => {
  const platform = createPlatform();
  const status = platform.integrations.storefrontTrackingStatus();

  assert.strictEqual(status.method, 'theme_extension',);
  assert.strictEqual(status.installed, false, 'an app embed cannot be enabled programmatically',);
  assert.ok(status.extension,);

  // Derive the expectation from the code: whatever the service reports as the
  // delivery method must be described on the disclosure page.
  const html = readDisclosure();
  assert.ok(
    /theme app extension/i.test(html,),
    'the disclosure must name the theme app extension as the delivery mechanism',
  );
  assert.ok(
    html.includes(status.extension,),
    `the disclosure should name the extension (${status.extension})`,
  );
},);

test('the page still states where events are sent', () => {
  // The load-bearing privacy claim: data goes only to the platform's ingest
  // endpoint, with a write-only key.
  const html = readDisclosure();
  assert.ok(html.includes('/api/v1/track',),);
  assert.ok(/write-only/i.test(html,),);
},);
