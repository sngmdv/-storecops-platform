'use strict';

const { describe, it, } = require('node:test',);
const assert = require('node:assert/strict',);
const { createRetentionEngine, WEIGHTS, RISK_BANDS, INTERVENTION_TEMPLATES, } = require('../src/layers/intelligence/retentionEngine',);
const { createStore, } = require('../src/storage/store',);

// ── Helper: seed a store with data ──────────────────────────────────

function seedStore(store, opts = {},) {
  const storeId = opts.store_id || 'test-store-1';
  const now = new Date().toISOString();
  const daysAgo = (d,) => new Date(Date.now() - d * 86400000,).toISOString();

  return {
    async setup() {
      await store.integrations.insert({
        store_id: storeId,
        store_name: opts.store_name || 'Test Store',
        type: opts.platform || 'shopify',
        status: opts.status || 'flowing',
        connected: true,
        last_sync_at: opts.lastSyncDaysAgo !== null && opts.lastSyncDaysAgo !== undefined ? daysAgo(opts.lastSyncDaysAgo,) : daysAgo(0.5,),
        last_dashboard_access: opts.lastAccessDaysAgo !== null && opts.lastAccessDaysAgo !== undefined ? daysAgo(opts.lastAccessDaysAgo,) : daysAgo(0.2,),
        created_at: opts.createdDaysAgo !== null && opts.createdDaysAgo !== undefined ? daysAgo(opts.createdDaysAgo,) : daysAgo(60,),
      },);

      if (opts.plan && opts.plan !== 'starter') {
        await store.subscriptions.insert({
          shopInstallationId: storeId,
          planId: opts.plan || 'growth',
          status: opts.subStatus || 'active',
          price_monthly: opts.price || 49,
          started_at: daysAgo(30,),
          current_period_end: opts.renewalDaysAhead !== null && opts.renewalDaysAhead !== undefined ? daysAgo(-opts.renewalDaysAhead,) : null,
        },);
      }

      // Seed events
      const eventCount = opts.eventCount || 0;
      const eventDaysBack = opts.eventDaysBack || 0;
      for (let i = 0; i < eventCount; i++) {
        await store.events.insert({
          store_id: storeId,
          event_type: opts.eventType || 'product_view',
          customer_id: `cust-${i % 5}`,
          timestamp: daysAgo(eventDaysBack + i * 0.1,),
        },);
      }

      // Seed actions
      const actionCount = opts.actionCount || 0;
      for (let i = 0; i < actionCount; i++) {
        await store.actions.insert({
          store_id: storeId,
          action_type: opts.actionType || 'cart_recovery',
          rule_id: opts.ruleId || 'cart_recovery_email',
          status: opts.actionStatus || 'completed',
          customer_id: `cust-${i}`,
        },);
      }

      // Seed deliveries
      const deliveryCount = opts.deliveryCount || 0;
      for (let i = 0; i < deliveryCount; i++) {
        await store.deliveries.insert({
          store_id: storeId,
          channel: 'email',
          status: 'delivered',
          delivered_at: daysAgo(i * 0.5,),
        },);
      }

      return storeId;
    },
  };
}

// ── Retention Engine Unit Tests ───────────────────────────────────────

describe('Retention Engine', () => {
  describe('Constants', () => {
    it('weights sum to 1.0', () => {
      const sum = Object.values(WEIGHTS,).reduce((a, b,) => a + b, 0,);
      assert.ok(Math.abs(sum - 1.0,) < 0.001, `Weights sum to ${sum}, expected 1.0`,);
    },);

    it('risk bands cover 0-100 without gaps', () => {
      assert.equal(RISK_BANDS.CRITICAL.min, 0,);
      assert.equal(RISK_BANDS.THRIVING.max, 100,);
      const bands = Object.values(RISK_BANDS,);
      for (let i = 1; i < bands.length; i++) {
        assert.equal(bands[i].min, bands[i - 1].max + 1,);
      }
    },);

    it('intervention templates have required fields', () => {
      for (const [key, tmpl,] of Object.entries(INTERVENTION_TEMPLATES,)) {
        assert.ok(tmpl.id, `${key} missing id`,);
        assert.ok(tmpl.channel, `${key} missing channel`,);
        assert.ok(tmpl.urgency, `${key} missing urgency`,);
        assert.ok(tmpl.subject, `${key} missing subject`,);
      }
    },);
  },);

  describe('Health Score Calculation', () => {
    it('returns score 0 for non-existent store', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      const result = await engine.calculateHealthScore('non-existent',);
      assert.equal(result.score, 0,);
      assert.ok(result.error,);
    },);

    it('gives high score to fully engaged store', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      const seeder = seedStore(store, {
        store_id: 'healthy-store',
        plan: 'growth',
        lastSyncDaysAgo: 0.1,
        lastAccessDaysAgo: 0.1,
        eventCount: 25000,
        eventDaysBack: 1,
        actionCount: 5,
        actionStatus: 'completed',
        deliveryCount: 10,
        createdDaysAgo: 90,
      },);
      await seeder.setup();

      const health = await engine.calculateHealthScore('healthy-store',);
      assert.ok(health.score >= 60, `Expected score >= 60, got ${health.score}`,);
      assert.ok(health.risk.band === 'LOW' || health.risk.band === 'THRIVING',);
    },);

    it('gives low score to disengaged store', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      const seeder = seedStore(store, {
        store_id: 'dead-store',
        plan: 'growth',
        lastSyncDaysAgo: 60,
        lastAccessDaysAgo: 45,
        eventCount: 0,
        actionCount: 0,
        deliveryCount: 0,
        createdDaysAgo: 120,
      },);
      await seeder.setup();

      const health = await engine.calculateHealthScore('dead-store',);
      assert.ok(health.score < 30, `Expected score < 30, got ${health.score}`,);
      assert.equal(health.risk.band, 'CRITICAL',);
    },);

    it('returns component breakdown', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      await seedStore(store, { store_id: 'comp-store', plan: 'growth', eventCount: 100, },).setup();

      const health = await engine.calculateHealthScore('comp-store',);
      assert.ok(health.components,);
      assert.ok(health.components.feature_adoption,);
      assert.ok(health.components.engagement_recency,);
      assert.ok(health.components.data_freshness,);
      assert.ok(health.components.plan_utilization,);
      assert.ok(health.components.growth_trajectory,);
      assert.ok(health.components.automation_activity,);
      assert.equal(typeof health.components.feature_adoption.score, 'number',);
    },);

    it('new stores get a grace period bump', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      await seedStore(store, {
        store_id: 'new-store',
        plan: 'starter',
        lastSyncDaysAgo: 5,
        lastAccessDaysAgo: 3,
        eventCount: 10,
        createdDaysAgo: 3,
      },).setup();

      const health = await engine.calculateHealthScore('new-store',);
      assert.equal(health.risk.is_new_store, true,);
      assert.ok(health.risk.adjusted_score >= health.risk.raw_score,);
    },);
  },);

  describe('Churn Reasons', () => {
    it('identifies low engagement as a reason', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      await seedStore(store, {
        store_id: 'disengaged',
        plan: 'growth',
        lastAccessDaysAgo: 30,
        lastSyncDaysAgo: 0.5,
        eventCount: 1000,
        createdDaysAgo: 60,
      },).setup();

      const health = await engine.calculateHealthScore('disengaged',);
      const reasons = health.reasons.map((r,) => r.reason,);
      assert.ok(reasons.includes('low_engagement',), `Expected low_engagement in reasons: ${reasons}`,);
    },);

    it('identifies stale data as a reason', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      await seedStore(store, {
        store_id: 'stale-data',
        plan: 'growth',
        lastSyncDaysAgo: 45,
        lastAccessDaysAgo: 0.5,
        eventCount: 1000,
        createdDaysAgo: 60,
      },).setup();

      const health = await engine.calculateHealthScore('stale-data',);
      const reasons = health.reasons.map((r,) => r.reason,);
      assert.ok(reasons.includes('data_stale',), `Expected data_stale in reasons: ${reasons}`,);
    },);

    it('sorts reasons by severity', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      await seedStore(store, {
        store_id: 'multi-issue',
        plan: 'growth',
        lastSyncDaysAgo: 60,
        lastAccessDaysAgo: 45,
        eventCount: 0,
        actionCount: 0,
        deliveryCount: 0,
        createdDaysAgo: 120,
      },).setup();

      const health = await engine.calculateHealthScore('multi-issue',);
      assert.ok(health.reasons.length >= 2,);
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, };
      for (let i = 1; i < health.reasons.length; i++) {
        assert.ok(
          severityOrder[health.reasons[i].severity] >= severityOrder[health.reasons[i - 1].severity],
          'Reasons should be sorted by severity',
        );
      }
    },);
  },);

  describe('Revenue Metrics', () => {
    it('calculates MRR from active subscriptions', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);

      await store.integrations.insert({ store_id: 's1', type: 'shopify', },);
      await store.integrations.insert({ store_id: 's2', type: 'shopify', },);
      await store.subscriptions.insert({ shopInstallationId: 's1', planId: 'growth', status: 'active', price_monthly: 49, },);
      await store.subscriptions.insert({ shopInstallationId: 's2', planId: 'scale', status: 'active', price_monthly: 149, },);

      const metrics = await engine.getRevenueMetrics();
      assert.equal(metrics.mrr, 198,);
      assert.equal(metrics.arr, 198 * 12,);
      assert.equal(metrics.active_subscriptions, 2,);
    },);

    it('calculates churn rate correctly', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);

      await store.integrations.insert({ store_id: 'a1', },);
      await store.integrations.insert({ store_id: 'a2', },);
      await store.integrations.insert({ store_id: 'c1', },);
      await store.subscriptions.insert({ shopInstallationId: 'a1', planId: 'growth', status: 'active', price_monthly: 49, },);
      await store.subscriptions.insert({ shopInstallationId: 'a2', planId: 'growth', status: 'active', price_monthly: 49, },);
      await store.subscriptions.insert({ shopInstallationId: 'c1', planId: 'growth', status: 'cancelled', price_monthly: 49, },);

      const metrics = await engine.getRevenueMetrics();
      // 1 cancelled out of 2 active + 1 cancelled = 33.33%
      assert.ok(Math.abs(metrics.churn_rate - 33.33,) < 1,);
    },);

    it('handles zero stores gracefully', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      const metrics = await engine.getRevenueMetrics();
      assert.equal(metrics.mrr, 0,);
      assert.equal(metrics.total_stores, 0,);
      assert.equal(metrics.churn_rate, 0,);
    },);
  },);

  describe('Analyze All Stores', () => {
    it('returns stores sorted by health score ascending', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);

      await seedStore(store, { store_id: 'good-store', plan: 'growth', eventCount: 5000, lastSyncDaysAgo: 0.1, lastAccessDaysAgo: 0.1, actionCount: 3, deliveryCount: 5, },).setup();
      await seedStore(store, { store_id: 'bad-store', plan: 'starter', lastSyncDaysAgo: 90, lastAccessDaysAgo: 60, eventCount: 0, createdDaysAgo: 120, },).setup();

      const analysis = await engine.analyzeAllStores();
      assert.ok(analysis.stores.length >= 2,);
      assert.ok(analysis.stores[0].health.score <= analysis.stores[1].health.score,);
    },);

    it('includes risk summary and metrics', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      await seedStore(store, { store_id: 'solo-store', },).setup();

      const analysis = await engine.analyzeAllStores();
      assert.ok(analysis.metrics,);
      assert.ok(analysis.risk_summary,);
      assert.equal(typeof analysis.risk_summary.critical, 'number',);
      assert.equal(typeof analysis.risk_summary.thriving, 'number',);
    },);

    it('identifies upgrade candidates', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);

      // Starter store with high utilization — should be flagged
      await seedStore(store, {
        store_id: 'ready-upgrade',
        plan: 'starter',
        eventCount: 400,
        lastSyncDaysAgo: 0.1,
        lastAccessDaysAgo: 0.1,
        createdDaysAgo: 30,
      },).setup();

      const analysis = await engine.analyzeAllStores();
      const candidates = analysis.upgrade_candidates.map((c,) => c.store_id,);
      assert.ok(candidates.includes('ready-upgrade',), `Expected ready-upgrade in candidates: ${candidates}`,);
    },);
  },);

  describe('Interventions', () => {
    it('generates interventions for at-risk store', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      await seedStore(store, {
        store_id: 'needs-help',
        plan: 'growth',
        lastSyncDaysAgo: 45,
        lastAccessDaysAgo: 30,
        eventCount: 0,
        actionCount: 0,
        deliveryCount: 0,
        createdDaysAgo: 90,
      },).setup();

      const interventions = await engine.generateInterventions('needs-help',);
      assert.ok(interventions.interventions.length > 0, 'Expected at least one intervention',);
      assert.ok(interventions.interventions[0].personalized,);
      assert.ok(interventions.interventions[0].personalized.subject,);
    },);

    it('generates no interventions for healthy store', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      await seedStore(store, {
        store_id: 'very-healthy',
        plan: 'scale',
        lastSyncDaysAgo: 0.1,
        lastAccessDaysAgo: 0.1,
        eventCount: 100000,
        actionCount: 10,
        deliveryCount: 20,
        createdDaysAgo: 180,
      },).setup();

      const interventions = await engine.generateInterventions('very-healthy',);
      // A very healthy store should have 0 or very few interventions
      assert.ok(interventions.interventions.length <= 2, `Expected <= 2 interventions for healthy store, got ${interventions.interventions.length}`,);
    },);

    it('personalizes templates with store data', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      await seedStore(store, {
        store_id: 'personalize-test',
        store_name: 'My Awesome Shop',
        plan: 'growth',
        lastSyncDaysAgo: 60,
        lastAccessDaysAgo: 45,
        eventCount: 0,
        createdDaysAgo: 120,
      },).setup();

      const interventions = await engine.generateInterventions('personalize-test',);
      const hasPersonalized = interventions.interventions.some(
        (i,) => i.personalized && (i.personalized.subject.includes('My Awesome Shop',) || i.personalized.body.includes('My Awesome Shop',)),
      );
      assert.ok(hasPersonalized, 'Expected at least one intervention to include the store name',);
    },);
  },);

  describe('Snapshots', () => {
    it('records and retrieves snapshots', async () => {
      const store = createStore();
      const engine = createRetentionEngine({ store, config: { env: 'test', }, },);
      await seedStore(store, { store_id: 'snap-store', },).setup();

      const analysis = await engine.analyzeAllStores();
      await engine.recordSnapshot(analysis,);

      const history = await engine.getHistory();
      assert.equal(history.length, 1,);
      assert.ok(history[0].recorded_at,);
      assert.ok(history[0].metrics,);
    },);
  },);
},);
