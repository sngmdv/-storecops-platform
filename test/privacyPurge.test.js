'use strict';

/**
 * Guard tests for the privacy module.
 *
 * The defect these lock down: the shop/redact handler hardcoded 16 of the 52
 * collections, and `deleteCustomerData` scrubbed only 4, so a deleted
 * customer's email survived in `leads`, `attributions`, `invoices`, `returns`,
 * `supportTickets` and others. `customers/redact` is a Shopify App Store
 * requirement, so that was a submission blocker.
 *
 * The first test below is NOT the important one, contrary to what this comment
 * used to claim. It cannot fail: `privacy.js` derives `PURGEABLE_COLLECTIONS` by
 * subtracting the three exemption maps from `COLLECTIONS`, so every name is
 * classified *by construction* and `unclassified` is structurally always empty.
 * Measured, not reasoned: appending `brandNewUnclassifiedThing` to `COLLECTIONS`
 * left all 9 tests in this file green — while silently making the new collection
 * **purgeable**, i.e. deleted on uninstall, with nobody having decided that. A
 * collection that belonged under a legal hold or in the platform-global set would
 * simply have been deleted, and the guard would have said nothing.
 *
 * `freezes the collection inventory` below is the test that actually holds the
 * line: it compares `COLLECTIONS` against a frozen fixture, so adding a collection
 * fails until its class is decided. `CLASSIFIED_INVENTORY` is a test fixture, not a
 * second source of truth — `privacy.js` still derives behaviour from `COLLECTIONS`,
 * and the assertion fails if the two disagree in either direction.
 */

const { describe, it, } = require('node:test',);
const assert = require('node:assert/strict',);
const { createStore, COLLECTIONS, } = require('../src/storage/store',);
const {
  purgeStoreData,
  redactCustomerData,
  collectCustomerData,
  classificationReport,
} = require('../src/server/privacy',);

const CUST = 'cust_guard_1';
const EMAIL = 'guard@example.com';

/**
 * The frozen collection inventory — the list of every collection that has had a
 * purge-classification decision made about it, sorted.
 *
 * This exists because the derived-by-subtraction design makes "purgeable" the
 * silent default. `privacy.js` cannot detect an unclassified collection, so the
 * only place a missing decision can be observed is here, against a fixed list.
 *
 * Adding a collection to `COLLECTIONS` without touching this list fails the test
 * below. Updating this list without classifying the collection in `privacy.js`
 * fails the `classificationReport` tests instead. Both directions are covered.
 */
const CLASSIFIED_INVENTORY = [
  'actions', 'activityLogs', 'attributions',
  'auditLog', 'campaignActions', 'campaigns',
  'channelSuppressions', 'competitorAds', 'competitorSnapshots',
  'connectors', 'consentRecords', 'customers',
  'deepAudits', 'deliveries', 'emailSuppressions',
  'events', 'externalSignals', 'featureUsage',
  'forecasts', 'integrations', 'inventory',
  'invoices', 'leads', 'marketingSpend',
  'monitoringEvents', 'notifications', 'oauthStates',
  'onboardingStates', 'passwordResets', 'payments',
  'pendingConnections', 'purchaseOrders', 'reportRequests',
  'reports', 'retargetingAudiences', 'retentionSnapshots',
  'returnAuditLog', 'returns', 'rules',
  'searchConsole', 'secretLedger', 'sentimentSamples',
  'seoAudits', 'seoOptimizations', 'sessions',
  'siteAudits', 'subscriptions', 'supportTickets',
  'trackedCompetitors', 'trendReports', 'twoFactorSecrets',
  'users',
  // PURGEABLE, decided deliberately: this holds a sha256 of the signed request
  // body, the store_id it was attributed to, the topic and a timestamp — no
  // customer identifier of any kind. Deleting it on uninstall is correct: the
  // store is gone, so no further delivery can be attributed to it and the
  // replay guard has nothing left to protect.
  'webhookDeliveries', 'webhookQueue',
];

describe('privacy: collection classification', () => {
  it('freezes the collection inventory, so a new collection forces a decision', () => {
    assert.deepEqual(
      [...COLLECTIONS,].sort(),
      CLASSIFIED_INVENTORY,
      'COLLECTIONS changed. Decide what the new collection is — purgeable, platform-global, under '
      + 'legal hold, or retained by the caller — record that decision in src/server/privacy.js, then '
      + 'update CLASSIFIED_INVENTORY. The default is PURGEABLE, so a collection added without a '
      + 'decision is DELETED on uninstall and nothing else will tell you.',
    );
  },);

  it('classifies every collection exactly once', () => {
    const report = classificationReport();

    assert.equal(report.total, COLLECTIONS.length,);
    assert.deepEqual(report.unclassified, [], 'every collection must be classified — add it to src/server/privacy.js',);
    assert.deepEqual(report.stale, [], 'a classification names a collection that no longer exists',);

    const accounted =
      report.purgeable.length +
      report.platform_global.length +
      report.legal_hold.length +
      report.retained_by_caller.length;
    assert.equal(accounted, COLLECTIONS.length, 'classifications must not overlap',);
  },);

  it('keeps opt-out records and the audit log out of the purge set', () => {
    const report = classificationReport();
    for (const name of ['emailSuppressions', 'channelSuppressions', 'auditLog', 'users',]) {
      assert.ok(
        report.platform_global.includes(name,),
        `${name} must never be purged — deleting it is a compliance regression`,
      );
    }
  },);
},);

describe('privacy: purgeStoreData', () => {
  it('purges store-scoped data, preserves legal holds, and leaves other tenants alone', async () => {
    const store = createStore();

    await store.events.insert({ store_id: 'A', event_type: 'product_view', },);
    await store.leads.insert({ store_id: 'A', email: EMAIL, },);
    await store.supportTickets.insert({ store_id: 'A', customer_id: CUST, },);
    await store.invoices.insert({ store_id: 'A', customer_id: CUST, amount: 10, },);
    await store.users.insert({ store_id: 'A', email: 'owner@example.com', },);
    await store.emailSuppressions.insert({ store_id: 'A', email: 'optout@example.com', },);
    await store.integrations.insert({ store_id: 'A', type: 'shopify', },);
    await store.events.insert({ store_id: 'B', event_type: 'product_view', },);

    const result = await purgeStoreData(store, 'A',);

    assert.ok(result.total_deleted >= 3, `expected several deletions, got ${result.total_deleted}`,);
    assert.equal((await store.events.find({ store_id: 'A', },)).length, 0,);
    assert.equal((await store.leads.find({ store_id: 'A', },)).length, 0,);
    assert.equal((await store.supportTickets.find({ store_id: 'A', },)).length, 0,);

    // Untouched tenants.
    assert.equal((await store.events.find({ store_id: 'B', },)).length, 1, 'other tenants must be untouched',);

    // Preserved.
    assert.equal((await store.invoices.find({ store_id: 'A', },)).length, 1, 'legal hold must survive',);
    assert.equal((await store.users.find({ store_id: 'A', },)).length, 1, 'platform accounts must survive',);
    assert.equal(
      (await store.emailSuppressions.find({ store_id: 'A', },)).length,
      1,
      'opt-out records must survive so we never message an opted-out recipient',
    );
    assert.equal(
      (await store.integrations.find({ store_id: 'A', },)).length,
      1,
      'the integration row is retained for the caller to mark uninstalled',
    );
  },);

  it('refuses to run without a store id', async () => {
    const store = createStore();
    await store.events.insert({ store_id: 'A', event_type: 'x', },);
    await store.events.insert({ event_type: 'no-store-row', },);

    await assert.rejects(() => purgeStoreData(store, undefined,), /non-empty store_id/,);
    await assert.rejects(() => purgeStoreData(store, '',), /non-empty store_id/,);

    // The guard exists because an undefined store_id would otherwise match every
    // row that has no store_id at all.
    assert.equal((await store.events.find({},)).length, 2, 'nothing should have been deleted',);
  },);

  it('is idempotent', async () => {
    const store = createStore();
    await store.events.insert({ store_id: 'A', event_type: 'x', },);

    const first = await purgeStoreData(store, 'A',);
    const second = await purgeStoreData(store, 'A',);

    assert.ok(first.total_deleted >= 1,);
    assert.equal(second.total_deleted, 0, 'second purge should find nothing to delete',);
  },);
},);

describe('privacy: redactCustomerData breadth', () => {
  it('scrubs the identifier from every collection that can hold it', async () => {
    const store = createStore();

    await store.customers.insert({ store_id: 'A', identity: CUST, email: EMAIL, },);
    await store.events.insert({ store_id: 'A', customer_id: CUST, email: EMAIL, },);
    await store.deliveries.insert({ store_id: 'A', customer_id: CUST, },);
    await store.actions.insert({ store_id: 'A', customer_id: CUST, },);
    // These are the collections the old implementation missed entirely.
    await store.leads.insert({ store_id: 'A', email: EMAIL, name: 'G', },);
    await store.supportTickets.insert({ store_id: 'A', customer_id: CUST, subject: 'help', },);
    await store.invoices.insert({ store_id: 'A', customer_id: CUST, amount: 10, },);
    await store.returns.insert({ store_id: 'A', customer_id: CUST, },);
    await store.attributions.insert({ store_id: 'A', customer_id: CUST, },);
    await store.notifications.insert({ store_id: 'A', customer_id: CUST, },);
    await store.activityLogs.insert({ store_id: 'A', customer_id: CUST, },);
    await store.consentRecords.insert({ store_id: 'A', customer_id: CUST, },);
    await store.reportRequests.insert({ store_id: 'A', customer_id: CUST, },);

    const result = await redactCustomerData(store, 'A', CUST,);

    assert.equal(result.anonymized, true,);
    assert.ok(result.total_scrubbed >= 12, `expected >=12 collections touched, got ${result.total_scrubbed}`,);

    const scrubbed = [
      'events', 'deliveries', 'actions', 'leads', 'supportTickets',
      'invoices', 'returns', 'attributions', 'notifications',
      'activityLogs', 'consentRecords', 'reportRequests',
    ];
    for (const name of scrubbed) {
      for (const row of await store[name].find({ store_id: 'A', },)) {
        assert.notEqual(row.customer_id, CUST, `${name} still holds customer_id`,);
        assert.notEqual(row.email, EMAIL, `${name} still holds email`,);
      }
    }

    // The invoice survives as a financial record but is de-identified.
    const invoices = await store.invoices.find({ store_id: 'A', },);
    assert.equal(invoices.length, 1, 'legal-hold row must not be deleted by a redaction',);
    assert.equal(invoices[0].amount, 10, 'non-identifying financial fields are preserved',);
  },);

  it('does not touch other tenants', async () => {
    const store = createStore();
    await store.customers.insert({ store_id: 'A', identity: CUST, email: EMAIL, },);
    await store.customers.insert({ store_id: 'B', identity: CUST, email: EMAIL, },);

    await redactCustomerData(store, 'A', CUST,);

    const other = await store.customers.findOne({ store_id: 'B', identity: CUST, },);
    assert.ok(other, 'the same customer id in another tenant must be unaffected',);
  },);

  it('refuses to run without a store id', async () => {
    const store = createStore();
    await assert.rejects(() => redactCustomerData(store, undefined, CUST,), /non-empty store_id/,);
  },);
},);

describe('privacy: collectCustomerData mirrors the redaction', () => {
  it('returns held data from collections the old export ignored', async () => {
    const store = createStore();
    await store.customers.insert({ store_id: 'A', identity: CUST, email: EMAIL, },);
    await store.events.insert({ store_id: 'A', customer_id: CUST, },);
    await store.leads.insert({ store_id: 'A', email: EMAIL, },);
    await store.supportTickets.insert({ store_id: 'A', customer_id: CUST, },);

    const exported = await collectCustomerData(store, 'A', CUST,);

    // Backwards-compatible keys still present.
    assert.ok(exported.profile,);
    assert.ok(exported.events.length >= 1,);
    assert.ok(exported.exported_at,);
    assert.ok(exported.total_records >= 4, `expected >=4 records, got ${exported.total_records}`,);

    // New breadth.
    assert.equal(exported.collections.leads.length, 1,);
    assert.equal(exported.collections.supportTickets.length, 1,);
  },);
},);
