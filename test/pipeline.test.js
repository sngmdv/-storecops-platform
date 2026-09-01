'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const { createPlatform, } = require('../src/platform',);

const STORE = 'store_e2e';

async function seedShopper(platform, customer_id,) {
  await platform.eventTracker.track({
    event_type: 'product_view',
    store_id: STORE,
    customer_id,
    product_id: 'p1',
  },);
}

test('end-to-end: abandoned cart → recovery message → purchase → attributed revenue', async () => {
  const platform = createPlatform();
  await seedShopper(platform, 'mia',);

  // 1. Cart abandonment fires the recovery rule in real time.
  const tracked = await platform.trackAndReact({
    event_type: 'cart_abandoned',
    store_id: STORE,
    customer_id: 'mia',
  },);

  assert.equal(tracked.accepted, true,);
  assert.equal(tracked.high_priority, true,);
  assert.equal(tracked.decision.actions.length, 1,);
  assert.equal(tracked.decision.actions[0].rule_id, 'cart_recovery',);

  // 2. Execution layer delivers it.
  const execution = await platform.executionService.processStore(STORE,);
  assert.equal(execution.delivered, 1,);
  assert.equal(execution.failed, 0,);

  const deliveries = await platform.store.deliveries.find({ store_id: STORE, },);
  assert.equal(deliveries.length, 1,);
  assert.ok(['email', 'whatsapp',].includes(deliveries[0].channel,),);

  // 3. Customer converts — purchase lands within the attribution window.
  await platform.eventTracker.track({
    event_type: 'purchase',
    store_id: STORE,
    customer_id: 'mia',
    total: 250,
    items: [{ product_id: 'p1', quantity: 1, },],
  },);

  // 4. Attribution credits the recovery action.
  const attribution = await platform.attribution.attributeStore(STORE,);
  assert.equal(attribution.conversions, 1,);
  assert.equal(attribution.attributed_revenue, 250,);
  assert.ok(attribution.by_rule.cart_recovery,);
  assert.equal(attribution.by_rule.cart_recovery.revenue, 250,);

  // 5. Dashboard rolls everything up.
  const report = await platform.reporting.storeReport(STORE,);
  assert.equal(report.overview.revenue, 250,);
  assert.equal(report.overview.actions_delivered, 1,);
  assert.equal(report.funnel.abandoned, 1,);
  assert.ok(report.attribution,);
},);

test('orchestrator cooldown prevents duplicate messages', async () => {
  const platform = createPlatform();
  await seedShopper(platform, 'leo',);

  const first = await platform.trackAndReact({
    event_type: 'cart_abandoned',
    store_id: STORE,
    customer_id: 'leo',
  },);
  const second = await platform.trackAndReact({
    event_type: 'cart_abandoned',
    store_id: STORE,
    customer_id: 'leo',
  },);

  assert.equal(first.decision.actions.length, 1,);
  assert.equal(second.decision.actions.length, 0, 'second abandonment is deduplicated',);
  assert.equal(second.decision.skipped, 1,);
},);

test('growth cycle: churn scan queues win-back and execution delivers it', async () => {
  const platform = createPlatform();

  // Customer who went dark long ago after abandoning carts — recency
  // plus unconverted abandonment pushes the score past the win-back
  // threshold.
  const dark = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000,).toISOString();
  await platform.eventTracker.track({
    event_type: 'product_view',
    store_id: STORE,
    customer_id: 'gone',
    product_id: 'p1',
    timestamp: dark,
  },);
  for (let i = 0; i < 2; i++) {
    await platform.eventTracker.track({
      event_type: 'cart_abandoned',
      store_id: STORE,
      customer_id: 'gone',
      timestamp: dark,
    },);
  }

  const cycle = await platform.runGrowthCycle(STORE,);

  assert.ok(cycle.scan.queued_actions.some((a,) => a.rule_id === 'churn_winback',),);
  assert.ok(cycle.execution.delivered >= 1,);
  assert.ok(cycle.report,);
},);

test('sentiment escalation fires a dashboard alert on negative health', async () => {
  const platform = createPlatform();

  await platform.sentimentCollector.collect({ store_id: STORE, source: 'review', text: 'Scam. Terrible. Awful experience.', },);
  await platform.sentimentCollector.collect({ store_id: STORE, source: 'social', text: 'Worst shop ever, broken items, slow delivery.', },);

  const scan = await platform.orchestrator.scanStore(STORE,);
  const alert = scan.queued_actions.find((a,) => a.rule_id === 'sentiment_escalation',);
  assert.ok(alert, 'negative sentiment queues an internal alert',);

  const execution = await platform.executionService.processStore(STORE,);
  const delivery = (await platform.store.deliveries.find({ store_id: STORE, },)).find(
    (d,) => d.channel === 'dashboard',
  );
  assert.ok(delivery,);
  assert.ok(execution.delivered >= 1,);
},);

test('custom rules can be added and fire through the orchestrator', async () => {
  const platform = createPlatform();

  await platform.rulesEngine.addRule(STORE, {
    rule_id: 'vip_thanks',
    name: 'Thank VIP buyers',
    trigger: 'purchase',
    when: [{ field: 'total_spent', op: 'gte', value: 500, },],
    action: { type: 'checkout_nudge', channel: 'email', urgency: 'low', },
  },);

  await seedShopper(platform, 'vip',);
  const tracked = await platform.trackAndReact({
    event_type: 'purchase',
    store_id: STORE,
    customer_id: 'vip',
    total: 600,
  },);

  assert.ok(tracked.decision.actions.some((a,) => a.rule_id === 'vip_thanks',),);
},);

test('dynamic pricing reacts to competitor gap and respects guardrails', async () => {
  const platform = createPlatform();

  await platform.competitorIngestor.ingestSnapshot({
    store_id: STORE,
    competitor: 'cheapco',
    products: [{ id: 'p1', name: 'Widget', price: 50, in_stock: true, },],
  },);

  const rec = await platform.dynamicPricing.recommend({
    store_id: STORE,
    product_id: 'p1',
    current_price: 100, // 100% above market
  },);

  assert.equal(rec.direction, 'decrease',);
  assert.ok(rec.change_pct >= platform.dynamicPricing.GUARDRAIL.min_change_pct,);
  assert.ok(rec.recommended_price < 100,);
  assert.ok(rec.signals.some((s,) => s.signal === 'competitor_gap',),);
},);

test('website bot answers intents and recommends products', async () => {
  const platform = createPlatform();
  await seedShopper(platform, 'visitor',);

  const shipping = await platform.websiteBot.reply({
    store_id: STORE,
    customer_id: 'visitor',
    message: 'How long does shipping take?',
  },);
  assert.equal(shipping.intent, 'shipping',);

  const rec = await platform.websiteBot.reply({
    store_id: STORE,
    customer_id: 'visitor',
    message: 'What should I buy?',
  },);
  assert.equal(rec.intent, 'recommendation',);
},);

test('channel optimizer learns from delivered messages', async () => {
  const platform = createPlatform();

  // Seed store-level history: whatsapp converts, email doesn't.
  await platform.channelOptimizer.recordOutcome({
    store_id: STORE,
    customer_id: 'x',
    channel: 'whatsapp',
    event_type: 'whatsapp_sent',
  },);
  await platform.channelOptimizer.recordOutcome({
    store_id: STORE,
    customer_id: 'x',
    channel: 'whatsapp',
    event_type: 'whatsapp_read',
  },);
  await platform.eventTracker.track({
    event_type: 'email_opened',
    store_id: STORE,
    customer_id: 'fresh',
  },);

  // Customer with no history inherits the store's best channel; a
  // customer who opened email prefers email.
  const newCustomer = await platform.channelOptimizer.bestChannel(STORE, 'nobody',);
  assert.equal(newCustomer.channel, 'whatsapp',);

  const emailFan = await platform.channelOptimizer.bestChannel(STORE, 'fresh',);
  assert.equal(emailFan.channel, 'email',);
},);
