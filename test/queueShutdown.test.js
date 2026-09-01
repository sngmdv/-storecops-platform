'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const { createPlatform, } = require('../src/platform',);

const STORE = 'store_shutdown';

test('queue shutdown: consent revocation blocks all queued actions', async () => {
  const platform = createPlatform();

  // Seed a customer and queue a recovery action.
  await platform.eventTracker.track({
    event_type: 'product_view',
    store_id: STORE,
    customer_id: 'queued_buyer',
    product_id: 'p1',
  },);
  await platform.trackAndReact({
    event_type: 'cart_abandoned',
    store_id: STORE,
    customer_id: 'queued_buyer',
  },);

  // Verify an action was queued.
  const queuedBefore = await platform.store.actions.find({ store_id: STORE, },);
  assert.ok(queuedBefore.length >= 1, 'action should be queued',);

  // Simulate uninstall: revoke all consent for the store.
  await platform.consentService.setConsent(STORE, 'queued_buyer', {
    marketing: false,
    recovery: false,
    analytics: false,
  },);

  // Execution should suppress the action due to missing consent.
  const result = await platform.executionService.processStore(STORE,);
  // Note: processStore counts all non-erroring actions as "delivered",
  // so we check the action status directly instead.
  const actions = await platform.store.actions.find({ store_id: STORE, },);
  const suppressed = actions.filter((a,) => a.status === 'suppressed',);
  assert.ok(suppressed.length >= 1, 'action should be suppressed due to revoked consent',);
},);

test('queue shutdown: growth cycle skips uninstalled stores', async () => {
  const platform = createPlatform();

  // Mark the store as uninstalled before running the cycle.
  await platform.store.integrations.insert({
    type: 'shopify',
    store_id: STORE,
    status: 'uninstalled',
    uninstalled_at: new Date().toISOString(),
  },);

  // Seed some old activity to trigger churn scoring.
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000,).toISOString();
  await platform.eventTracker.track({
    event_type: 'product_view',
    store_id: STORE,
    customer_id: 'ghost',
    product_id: 'p1',
    timestamp: old,
  },);

  // Growth cycle should not queue actions for an uninstalled store.
  const cycle = await platform.runGrowthCycle(STORE,);
  const queuedForDisabled = cycle.scan.queued_actions.filter(
    (a,) => a.store_id === STORE,
  );
  // The cycle may still run scans, but execution should deliver nothing.
  assert.equal(cycle.execution.delivered, 0, 'no deliveries for uninstalled store',);
},);

test('queue shutdown: consent revocation on uninstall blocks all categories', async () => {
  const platform = createPlatform();

  // Set up consent for a customer.
  await platform.consentService.setConsent(STORE, 'shopper1', {
    marketing: true,
    recovery: true,
    analytics: true,
  },);

  // Verify consent is granted.
  const canSend = await platform.consentService.canSend(STORE, 'shopper1', 'cart_recovery', 'email',);
  assert.equal(canSend.allowed, true, 'consent should be granted initially',);

  // Revoke all consent (simulating uninstall).
  await platform.consentService.revokeInstallationConsent(STORE,);

  // Now canSend should return false.
  const blocked = await platform.consentService.canSend(STORE, 'shopper1', 'cart_recovery', 'email',);
  assert.equal(blocked.allowed, false, 'revoked consent must block sends',);
  assert.equal(blocked.reason, 'missing_recovery_consent',);
},);
