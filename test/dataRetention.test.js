'use strict';

/**
 * Tests for data-retention enforcement.
 *
 * The defect: config.retention defined five retention windows and nothing read
 * it. These tests pin the behaviours that make enforcement safe to switch on —
 * dry runs delete nothing, undateable rows are never deleted, a non-positive
 * window disables rather than empties a collection, and only the five policy
 * collections are ever touched.
 */

const { describe, it, } = require('node:test',);
const assert = require('node:assert/strict',);
const { createStore, } = require('../src/storage/store',);
const { createDataRetentionJob, resolveTimestamp, POLICIES, DAY_MS, } = require('../src/server/dataRetention',);

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0,);
const daysAgo = (d,) => new Date(NOW - d * DAY_MS,).toISOString();

/** A config with every window enabled, unless overridden. */
function testConfig(overrides = {},) {
  return {
    dataRetention: {
      enabled: true,
      intervalHours: 24,
      events: 365,
      deliveries: 180,
      consentRecords: 730,
      monitoringEvents: 90,
      sessions: 30,
      ...overrides,
    },
  };
}

function job(store, overrides = {},) {
  return createDataRetentionJob({
    store,
    config: testConfig(overrides,),
    logger: { log() {}, error() {}, },
    now: () => NOW,
  },);
}

describe('dataRetention: resolveTimestamp', () => {
  it('uses the first parseable field in preference order', () => {
    assert.equal(
      resolveTimestamp({ created_at: '2026-01-01T00:00:00.000Z', timestamp: '2026-02-01T00:00:00.000Z', }, ['timestamp', 'created_at',],),
      Date.parse('2026-02-01T00:00:00.000Z',),
    );
    assert.equal(
      resolveTimestamp({ created_at: '2026-01-01T00:00:00.000Z', }, ['timestamp', 'created_at',],),
      Date.parse('2026-01-01T00:00:00.000Z',),
    );
  },);

  it('returns null when a row cannot be dated', () => {
    assert.equal(resolveTimestamp({}, ['timestamp',],), null,);
    assert.equal(resolveTimestamp({ timestamp: 'not a date', }, ['timestamp',],), null,);
    assert.equal(resolveTimestamp({ timestamp: null, }, ['timestamp',],), null,);
    assert.equal(resolveTimestamp(null, ['timestamp',],), null,);
  },);
},);

describe('dataRetention: runOnce', () => {
  it('deletes only rows older than the window', async () => {
    const store = createStore();
    await store.events.insert({ store_id: 'A', timestamp: daysAgo(400,), },);
    await store.events.insert({ store_id: 'A', timestamp: daysAgo(100,), },);
    await store.events.insert({ store_id: 'A', timestamp: daysAgo(1,), },);

    const report = await job(store,).runOnce();

    assert.equal(report.collections.events.deleted, 1,);
    assert.equal((await store.events.find({},)).length, 2, 'recent rows must survive',);
  },);

  it('never deletes rows it cannot date', async () => {
    const store = createStore();
    await store.events.insert({ store_id: 'A', event_type: 'undated', },);
    await store.events.insert({ store_id: 'A', timestamp: daysAgo(999,), },);

    const report = await job(store,).runOnce();

    assert.equal(report.collections.events.deleted, 1,);
    const remaining = await store.events.find({},);
    assert.equal(remaining.length, 1,);
    assert.equal(remaining[0].event_type, 'undated', 'an undateable row must never be deleted',);
  },);

  it('deletes nothing in a dry run but reports what it would remove', async () => {
    const store = createStore();
    await store.events.insert({ store_id: 'A', timestamp: daysAgo(500,), },);
    await store.events.insert({ store_id: 'A', timestamp: daysAgo(500,), },);

    const report = await job(store,).runOnce({ dryRun: true, },);

    assert.equal(report.dry_run, true,);
    assert.equal(report.collections.events.matched, 2,);
    assert.equal(report.collections.events.deleted, 0,);
    assert.equal(report.total_deleted, 0,);
    assert.equal((await store.events.find({},)).length, 2, 'a dry run must not delete anything',);
  },);

  it('treats a non-positive window as disabled, not as delete-everything', async () => {
    const store = createStore();
    await store.events.insert({ store_id: 'A', timestamp: daysAgo(9999,), },);

    const report = await job(store, { events: 0, },).runOnce();

    assert.equal(report.collections.events, undefined,);
    assert.equal((await store.events.find({},)).length, 1, 'a 0-day window must not empty the collection',);
    assert.ok(
      report.skipped.some((s,) => String(s.reason,).includes('no positive retention window',),),
      'the disabled collection should be reported as skipped',
    );
  },);

  it('enforces every configured collection independently', async () => {
    const store = createStore();
    await store.events.insert({ store_id: 'A', timestamp: daysAgo(400,), },);
    await store.deliveries.insert({ store_id: 'A', created_at: daysAgo(200,), },);
    await store.monitoringEvents.insert({ store_id: 'A', timestamp: daysAgo(100,), },);
    await store.sessions.insert({ store_id: 'A', created_at: daysAgo(31,), },);

    const report = await job(store,).runOnce();

    assert.equal(report.collections.events.deleted, 1,);
    assert.equal(report.collections.deliveries.deleted, 1,);
    assert.equal(report.collections.monitoringEvents.deleted, 1,);
    assert.equal(report.collections.sessions.deleted, 1,);
    assert.equal(report.total_deleted, 4,);
  },);

  it('holds consent records back by default', async () => {
    const store = createStore();
    await store.consentRecords.insert({ store_id: 'A', created_at: daysAgo(5000,), },);

    const report = await job(store,).runOnce();

    assert.equal(report.collections.consentRecords, undefined,);
    assert.equal(
      (await store.consentRecords.find({},)).length,
      1,
      'consent records are the evidence of permission and must survive the sweep by default',
    );
    assert.ok(
      report.skipped.some((s,) => String(s.reason,).includes('held by policy',),),
      'the hold must be reported, not silent',
    );
  },);

  it('sweeps consent records only under an explicit opt-in', async () => {
    const store = createStore();
    await store.consentRecords.insert({ store_id: 'A', created_at: daysAgo(800,), },);
    await store.consentRecords.insert({ store_id: 'A', created_at: daysAgo(10,), },);

    const report = await job(store, { enforceConsent: true, },).runOnce();

    assert.equal(report.collections.consentRecords.deleted, 1,);
    assert.equal((await store.consentRecords.find({},)).length, 1,);
  },);

  it('never touches collections outside the policy', async () => {
    const store = createStore();
    const policyNames = POLICIES.map((p,) => p.collection,);

    // Seed ancient rows everywhere, including compliance-critical collections.
    for (const name of ['invoices', 'payments', 'auditLog', 'emailSuppressions', 'channelSuppressions', 'returns', 'leads',]) {
      await store[name].insert({ store_id: 'A', created_at: daysAgo(9999,), email: 'x@y.z', },);
    }
    // And a policy collection, to prove the sweep does run.
    await store.events.insert({ store_id: 'A', timestamp: daysAgo(9999,), },);

    const report = await job(store,).runOnce();

    assert.equal(report.total_deleted, 1, 'only the policy collection should be swept',);
    for (const name of ['invoices', 'payments', 'auditLog', 'emailSuppressions', 'channelSuppressions', 'returns', 'leads',]) {
      assert.equal(
        (await store[name].find({},)).length,
        1,
        `${name} must never be touched by the retention sweep`,
      );
      assert.ok(!policyNames.includes(name,),);
    }
  },);

  it('is idempotent', async () => {
    const store = createStore();
    await store.events.insert({ store_id: 'A', timestamp: daysAgo(500,), },);

    const first = await job(store,).runOnce();
    const second = await job(store,).runOnce();

    assert.equal(first.total_deleted, 1,);
    assert.equal(second.total_deleted, 0,);
  },);
},);

describe('dataRetention: start/stop', () => {
  it('does not start when disabled', () => {
    const store = createStore();
    const started = job(store, { enabled: false, },).start();
    assert.equal(started, false, 'retention must be opt-in',);
  },);

  it('starts and stops when enabled', () => {
    const store = createStore();
    const retention = job(store,).start();
    const instance = createDataRetentionJob({ store, config: testConfig(), logger: { log() {}, error() {}, }, },);

    assert.equal(instance.start(), true,);
    assert.equal(instance.stop(), true,);
    assert.equal(instance.stop(), false, 'stopping twice is a no-op',);
  },);
},);
