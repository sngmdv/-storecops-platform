'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const { createPlatform, } = require('../src/platform',);
const {
  createRateLimiter,
  webhookVerifier,
  signBody,
} = require('../src/server/security',);

const STORE = 'store_toolkit';

/** Local-time ISO timestamp at a given hour (timezone-safe tests). */
function atHour(daysAgo, hour,) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo,);
  d.setHours(hour, 15, 0, 0,);
  return d.toISOString();
}

test('Search Console + SEO growth: intent gap, content ideas, rankings', async () => {
  const platform = createPlatform();

  await platform.searchConsole.ingestPerformance({
    store_id: STORE,
    rows: [
      { query: 'buy wireless earbuds', page: '/earbuds', impressions: 500, clicks: 4, position: 14, },
      { query: 'best phone cases', page: '/cases', impressions: 300, clicks: 20, position: 3, },
    ],
  },);

  const perf = await platform.searchConsole.performance(STORE,);
  assert.equal(perf.queries.length, 2,);

  const gap = await platform.seoGrowth.intentGap(STORE, ['phone cases',],);
  const earbudGap = gap.gaps.find((g,) => g.query === 'buy wireless earbuds',);
  assert.ok(earbudGap, 'weak-ranking query should be flagged as a gap',);
  assert.equal(earbudGap.intent, 'transactional',);

  const ideas = await platform.seoGrowth.contentOpportunities(STORE, ['phone cases',],);
  assert.ok(ideas.ideas.length >= 1,);
  assert.ok(ideas.ideas[0].headline.length > 5,);

  await platform.searchConsole.ingestRankings({
    store_id: STORE,
    rankings: [
      { keyword: 'wireless earbuds', brand: 'us', position: 3, },
      { keyword: 'wireless earbuds', brand: 'rival', position: 1, },
    ],
  },);
  const comparison = await platform.seoGrowth.rankingComparison(STORE, 'us',);
  assert.equal(comparison.comparison[0].our_position, 3,);
  assert.equal(comparison.comparison[0].gap_to_leader, 2,);

  const content = platform.seoGrowth.generateProductContent({
    product_id: 'p1',
    name: 'wireless earbuds pro',
    keywords: ['wireless earbuds', 'bluetooth',],
  },);
  assert.ok(content.meta_title.length <= 60,);
  assert.ok(content.meta_description.length <= 160,);
},);

test('SEO auto-fix suggestions come from failed audit checks', async () => {
  const platform = createPlatform();
  const audit = platform.seoAuditEngine.auditHtml('<html><body>no seo here</body></html>', 'http://example.test',);
  const fixes = platform.seoGrowth.autoFixSuggestions(audit, { brand: 'TestStore', keywords: ['gadgets',], },);

  assert.ok(fixes.fixes.length >= 3,);
  assert.ok(fixes.fixes.some((f,) => f.target === 'meta_description',),);
  assert.ok(fixes.fixes.some((f,) => f.target === 'https',),);
},);

test('Defection detector flags competitor-browsing customers', async () => {
  const platform = createPlatform();

  await platform.eventTracker.track({
    store_id: STORE, event_type: 'purchase', customer_id: 'vip1', total: 300,
  },);
  await platform.eventTracker.track({
    store_id: STORE, event_type: 'competitor_view', customer_id: 'vip1',
  },);

  const result = await platform.defectionDetector.detect(STORE,);
  assert.equal(result.count, 1,);
  assert.equal(result.flagged[0].customer_id, 'vip1',);
  assert.equal(result.flagged[0].severity, 'HIGH',);
},);

test('Seasonal alerts surface upcoming retail moments', async () => {
  const platform = createPlatform();
  const result = platform.seasonalAlerts.upcoming({
    store_id: STORE,
    horizonDays: 45,
    now: new Date(2026, 10, 20,), // Nov 20 — Black Friday 8 days out
  },);

  const blackFriday = result.opportunities.find((o,) => o.event === 'Black Friday',);
  assert.ok(blackFriday,);
  assert.equal(blackFriday.days_until, 8,);
  assert.equal(blackFriday.prep_status, 'START_NOW',);
},);

test('Competitor ad intelligence summarizes the ad landscape', async () => {
  const platform = createPlatform();

  await platform.adIntelligence.ingest({
    store_id: STORE,
    ads: [
      { competitor: 'rival-a', platform: 'meta', creative_type: 'video', headline: 'Sale!', cta: 'Shop Now', },
      { competitor: 'rival-a', platform: 'meta', creative_type: 'video', headline: 'New drop', cta: 'Shop Now', },
      { competitor: 'rival-b', platform: 'tiktok', creative_type: 'static', headline: 'Deal', cta: 'Buy', },
    ],
  },);

  const analysis = await platform.adIntelligence.analyze(STORE,);
  assert.equal(analysis.competitors[0].competitor, 'rival-a',);
  assert.equal(analysis.competitors[0].ad_count, 2,);
  assert.equal(analysis.competitors[0].primary_format, 'video',);
  assert.ok(analysis.insights.some((i,) => i.includes('video',),),);
},);

test('Competitor promotion tracking + monthly landscape report', async () => {
  const platform = createPlatform();

  await platform.competitorIngestor.ingestSnapshot({
    store_id: STORE, competitor: 'rival-a',
    captured_at: new Date(Date.now() - 86400000,).toISOString(),
    products: [{ id: 'x', name: 'Widget', price: 100, in_stock: true, },],
  },);
  await platform.competitorIngestor.ingestSnapshot({
    store_id: STORE, competitor: 'rival-a',
    products: [{ id: 'x', name: 'Widget', price: 100, in_stock: true, promotion: 'BOGO', },],
  },);

  const analysis = await platform.competitorIntelligence.analyzeCompetitor(STORE, 'rival-a',);
  assert.ok(analysis.alerts.some((a,) => a.type === 'COMPETITOR_PROMOTION' && a.detail.detected_offer === 'BOGO',),);

  const landscape = await platform.competitorIntelligence.landscapeReport(STORE,);
  assert.equal(landscape.period, 'monthly',);
  assert.equal(landscape.competitors[0].active_promotions, 1,);
},);

test('Segmentation splits VIPs from newcomers', async () => {
  const platform = createPlatform();

  for (let i = 0; i < 3; i += 1) {
    await platform.eventTracker.track({
      store_id: STORE, event_type: 'purchase', customer_id: 'bigspender',
      total: 250, timestamp: atHour(1, 12,),
    },);
  }
  await platform.eventTracker.track({
    store_id: STORE, event_type: 'page_view', customer_id: 'newbie',
  },);

  const result = await platform.segmentation.segmentStore(STORE,);
  assert.ok(result.distribution.VIP >= 1,);
  assert.ok(result.distribution.NEW >= 1,);

  const vip = await platform.segmentation.segmentCustomer(STORE, 'bigspender',);
  assert.equal(vip.segment, 'VIP',);
},);

test('Trend campaign generator drafts reviewable campaigns', async () => {
  const platform = createPlatform();

  await platform.externalSignals.ingestBatch([
    { store_id: STORE, keyword: 'smart rings', source: 'google_trends', score: 80, },
    { store_id: STORE, keyword: 'smart rings', source: 'reddit', score: 90, },
  ],);

  const result = await platform.campaignGenerator.generate({ store_id: STORE, },);
  assert.ok(result.count >= 1,);
  const trendDraft = result.drafts.find((d,) => d.source === 'trend',);
  assert.ok(trendDraft,);
  assert.ok(trendDraft.subject.toLowerCase().includes('smart rings',),);
  assert.equal(result.status, 'AWAITING_APPROVAL',);

  const listed = await platform.campaignGenerator.list(STORE,);
  assert.ok(listed.length >= 1,);
},);

test('Send-time optimizer learns the engagement hour', async () => {
  const platform = createPlatform();

  await platform.eventTracker.track({
    store_id: STORE, event_type: 'email_opened', customer_id: 'c1', timestamp: atHour(2, 20,),
  },);
  await platform.eventTracker.track({
    store_id: STORE, event_type: 'email_opened', customer_id: 'c1', timestamp: atHour(1, 21,),
  },);
  await platform.eventTracker.track({
    store_id: STORE, event_type: 'email_opened', customer_id: 'c1', timestamp: atHour(1, 21,),
  },);

  const best = await platform.sendTimeOptimizer.bestSendHour(STORE, 'c1', 'email',);
  assert.equal(best.hour, 21,);
  assert.equal(best.basis, 'customer_history',);

  const fallback = await platform.sendTimeOptimizer.bestSendHour(STORE, 'stranger', 'push',);
  assert.equal(fallback.basis, 'default',); // no push history anywhere yet
  assert.equal(fallback.hour, 18,);
},);

test('Scan queues browse-abandonment and VIP surprise actions', async () => {
  const platform = createPlatform();

  // Heavy browser, never added to cart.
  for (let i = 0; i < 4; i += 1) {
    await platform.eventTracker.track({
      store_id: STORE, event_type: 'product_view', customer_id: 'windowshopper', product_id: `p${i}`,
    },);
  }
  // Quiet VIP.
  await platform.eventTracker.track({
    store_id: STORE, event_type: 'purchase', customer_id: 'quietvip', total: 600, timestamp: atHour(40, 10,),
  },);

  const scan = await platform.orchestrator.scanStore(STORE,);
  const ruleIds = scan.queued_actions.map((a,) => a.rule_id,);
  assert.ok(ruleIds.includes('browse_abandonment',), `got: ${ruleIds}`,);
  assert.ok(ruleIds.includes('vip_surprise',), `got: ${ruleIds}`,);
},);

test('Retargeting builds cart and browse abandoner audiences', async () => {
  const platform = createPlatform();

  await platform.eventTracker.track({
    store_id: STORE, event_type: 'cart_abandoned', customer_id: 'abandoner',
  },);
  for (let i = 0; i < 3; i += 1) {
    await platform.eventTracker.track({
      store_id: STORE, event_type: 'product_view', customer_id: 'looker', product_id: `p${i}`,
    },);
  }

  const audiences = await platform.retargeting.buildAudiences(STORE,);
  assert.equal(audiences.sizes.cart_abandoners, 1,);
  assert.equal(audiences.sizes.browse_abandoners, 1,);
  assert.equal(audiences.ad_drafts.length, 2,);
},);

test('Stockout predictions and purchase orders close the restock loop', async () => {
  const platform = createPlatform();

  await platform.inventoryLedger.setStockBatch(STORE, [
    { product_id: 'hot-item', stock: 3, lead_time_days: 7, },
  ],);
  for (let i = 0; i < 4; i += 1) {
    await platform.eventTracker.track({
      store_id: STORE, event_type: 'purchase', customer_id: `buyer${i}`,
      items: [{ product_id: 'hot-item', quantity: 5, price: 20, },], total: 100,
    },);
  }

  const insights = await platform.productInsights.analyze(STORE,);
  assert.ok(insights.stockout_predictions.length >= 1,);
  assert.ok(insights.restock_urgent.length >= 1,);
  assert.ok(insights.restock_urgent[0].reorder_point !== undefined,);

  const { po, } = await platform.purchaseOrders.generate({ store_id: STORE, supplier: 'Acme Supplies', },);
  assert.ok(po,);
  assert.equal(po.supplier, 'Acme Supplies',);
  assert.ok(po.document.includes('PURCHASE ORDER',),);
  assert.ok(po.total_units >= 1,);
},);

test('Reporting: ROI, maturity, weekly digest and custom reports', async () => {
  const platform = createPlatform();

  await platform.eventTracker.track({
    store_id: STORE, event_type: 'purchase', customer_id: 'c1', total: 150,
  },);

  const roi = await platform.reporting.roi(STORE,);
  assert.equal(typeof roi.roi_percent, 'number',);
  assert.ok(['PROFITABLE', 'BUILDING',].includes(roi.verdict,),);

  const maturity = await platform.reporting.maturityScore(STORE,);
  assert.ok(maturity.score >= 0 && maturity.score <= 100,);
  assert.ok(maturity.stage.length > 0,);

  const digest = await platform.reporting.weeklyDigest(STORE,);
  assert.ok(digest.headline.revenue >= 150,);
  assert.ok(['BASELINE', 'IMPROVING', 'DECLINING', 'STABLE',].includes(digest.sentiment_trend.direction,),);

  const custom = await platform.reporting.customReport({
    store_id: STORE, event_types: ['purchase',], format: 'csv',
  },);
  assert.equal(custom.events_matched, 1,);
  assert.ok(custom.csv.startsWith('event_id,event_type',),);
},);

test('Security: rate limiter, webhook signature, RBAC and GDPR export', async () => {
  const platform = createPlatform();

  // Rate limiter: third call inside the window is rejected.
  const limiter = createRateLimiter({ windowMs: 60000, max: 2, },);
  const calls = [];
  for (let i = 0; i < 3; i += 1) {
    let statusCode = 200;
    const res = {
      set() {},
      status(code,) { statusCode = code; return this; },
      json(body,) { calls.push({ statusCode, body, },); return this; },
    };
    limiter({ get: () => 'key-1', ip: '1.2.3.4', }, res, () => calls.push({ statusCode: 200, passed: true, },),);
  }
  assert.equal(calls.filter((c,) => c.passed,).length, 2,);
  assert.equal(calls.find((c,) => c.statusCode === 429,).statusCode, 429,);

  // Webhook signature: valid passes, tampered fails.
  const secret = 's3cret';
  const body = JSON.stringify({ event_type: 'purchase', },);
  const verifier = webhookVerifier(secret,);
  let passed = false;
  verifier(
    { get: (h,) => (h === 'x-storecops-signature' ? signBody(secret, body,) : null), rawBody: body, },
    {},
    () => { passed = true; },
  );
  assert.ok(passed,);

  let rejected = false;
  verifier(
    { get: () => 'deadbeef', rawBody: body, },
    { status: () => ({ json: () => { rejected = true; }, }), },
    () => {},
  );
  assert.ok(rejected,);

  // RBAC: first user is admin; viewers cannot mutate.
  await platform.rbac.createUser({ email: 'boss@shop.com', },);
  const viewer = await platform.rbac.createUser({ email: 'intern@shop.com', role: 'viewer', },);
  assert.equal(viewer.role, 'viewer',);

  let blocked = null;
  const res = {
    status(code,) { blocked = code; return this; },
    json() { return this; },
  };
  await platform.rbac.middleware('mutate',)(
    { get: () => 'intern@shop.com', originalUrl: '/x', },
    res,
    () => { blocked = 200; },
  );
  assert.equal(blocked, 403,);

  // GDPR export returns everything held about the customer.
  await platform.eventTracker.track({
    store_id: STORE, event_type: 'purchase', customer_id: 'subject@shop.com', email: 'subject@shop.com', total: 50,
  },);
  const exportData = await require('../src/server/security',).exportCustomerData(platform, STORE, 'subject@shop.com',);
  assert.ok(exportData.profile,);
  assert.ok(exportData.events.length >= 1,);
},);
