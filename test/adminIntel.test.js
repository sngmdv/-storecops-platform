'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const adminIntel = require('../src/layers/intelligence/adminIntelligence',);

// ─── Admin Daily Brief ──────────────────────────────────────────────────────

test('Admin Brief: generates brief with empty data', () => {
  const brief = adminIntel.generateAdminBrief({
    stores: [], leads: [], retentionSnapshots: [], deliveries: [], events: [], campaignActions: [],
  },);
  assert.ok(brief,);
  assert.ok(brief.date,);
  assert.ok(Array.isArray(brief.priorities,),);
  assert.equal(brief.metrics.totalMRR, 0,);
  assert.equal(brief.metrics.totalStores, 0,);
},);

test('Admin Brief: identifies critical stores as priority', () => {
  const brief = adminIntel.generateAdminBrief({
    stores: [
      { storeId: 's1', mrr: 100, riskBand: 'critical', healthScore: 20, status: 'active', },
      { storeId: 's2', mrr: 200, riskBand: 'low', healthScore: 80, status: 'active', },
    ],
    leads: [], retentionSnapshots: [], deliveries: [], events: [], campaignActions: [],
  },);
  assert.ok(brief.priorities.length > 0,);
  assert.equal(brief.priorities[0].type, 'urgent',);
  assert.equal(brief.metrics.atRiskRevenue, 100,);
},);

test('Admin Brief: identifies hot leads as priority', () => {
  const brief = adminIntel.generateAdminBrief({
    stores: [],
    leads: [
      { score: 90, status: 'new', createdAt: new Date().toISOString(), },
      { score: 50, status: 'new', createdAt: new Date().toISOString(), },
    ],
    retentionSnapshots: [], deliveries: [], events: [], campaignActions: [],
  },);
  assert.ok(brief.metrics.hotLeads >= 1,);
  assert.ok(brief.priorities.some((p,) => p.type === 'revenue' || p.type === 'leads',),);
},);

test('Admin Brief: counts new leads correctly', () => {
  const today = new Date().toISOString().slice(0, 10,);
  const brief = adminIntel.generateAdminBrief({
    stores: [],
    leads: [
      { score: 50, status: 'new', createdAt: today + 'T10:00:00Z', },
      { score: 40, status: 'contacted', createdAt: today + 'T08:00:00Z', },
    ],
    retentionSnapshots: [], deliveries: [], events: [], campaignActions: [],
  },);
  assert.equal(brief.metrics.newLeadsToday, 2,);
},);

test('Admin Brief: calculates delivery rate', () => {
  const brief = adminIntel.generateAdminBrief({
    stores: [], leads: [], retentionSnapshots: [],
    deliveries: [
      { status: 'delivered', createdAt: new Date().toISOString(), },
      { status: 'delivered', createdAt: new Date().toISOString(), },
      { status: 'failed', createdAt: new Date().toISOString(), },
    ],
    events: [], campaignActions: [],
  },);
  assert.ok(brief.metrics.deliveryRate > 0,);
  assert.ok(brief.metrics.deliveryRate < 100,);
},);

// ─── Revenue Forecast ─────────────────────────────────────────────────────────

test('Revenue Forecast: projects with empty data', () => {
  const fc = adminIntel.generateRevenueForecast({ stores: [], leads: [], retentionSnapshots: [], },);
  assert.ok(fc,);
  assert.equal(fc.currentMRR, 0,);
  assert.equal(fc.currentARR, 0,);
  assert.ok(Array.isArray(fc.projections,),);
  assert.equal(fc.projections.length, 3,);
},);

test('Revenue Forecast: calculates churn loss from risk bands', () => {
  const fc = adminIntel.generateRevenueForecast({
    stores: [
      { storeId: 's1', mrr: 100, riskBand: 'critical', status: 'active', },
      { storeId: 's2', mrr: 200, riskBand: 'high', status: 'active', },
      { storeId: 's3', mrr: 300, riskBand: 'low', status: 'active', },
    ],
    leads: [], retentionSnapshots: [],
  },);
  assert.ok(fc.monthlyChurnLoss > 0,);
  assert.ok(fc.breakdown.churnByBand.critical.mrrAtRisk > 0,);
},);

test('Revenue Forecast: calculates pipeline gain by stage', () => {
  const fc = adminIntel.generateRevenueForecast({
    stores: [],
    leads: [
      { status: 'new', }, { status: 'new', }, { status: 'new', },
      { status: 'contacted', }, { status: 'contacted', },
      { status: 'qualified', },
      { status: 'proposal', },
    ],
    retentionSnapshots: [],
  },);
  assert.ok(fc.monthlyPipelineGain > 0,);
  assert.ok(fc.breakdown.pipelineByStage.new.leads === 3,);
  assert.ok(fc.breakdown.pipelineByStage.proposal.leads === 1,);
},);

test('Revenue Forecast: includes expansion revenue', () => {
  const fc = adminIntel.generateRevenueForecast({
    stores: [
      { storeId: 's1', mrr: 100, status: 'active', upsellOpportunities: ['premium_plan',], },
      { storeId: 's2', mrr: 200, status: 'active', upsellOpportunities: [], },
    ],
    leads: [], retentionSnapshots: [],
  },);
  assert.ok(fc.monthlyExpansionGain > 0,);
},);

test('Revenue Forecast: projections decrease in confidence over time', () => {
  const fc = adminIntel.generateRevenueForecast({
    stores: [{ storeId: 's1', mrr: 100, riskBand: 'low', status: 'active', },],
    leads: [{ status: 'new', },],
    retentionSnapshots: [],
  },);
  assert.ok(fc.projections[0].confidence > fc.projections[1].confidence,);
  assert.ok(fc.projections[1].confidence > fc.projections[2].confidence,);
},);

// ─── Lead Capture ─────────────────────────────────────────────────────────────

test('Lead Capture: creates new lead from email', () => {
  const result = adminIntel.captureLead({
    leads: [],
    input: { email: 'test@example.com', name: 'Test', source: 'landing', },
  },);
  assert.ok(result.created,);
  assert.ok(result.lead,);
  assert.equal(result.lead.email, 'test@example.com',);
  assert.equal(result.lead.source, 'landing',);
  assert.ok(result.lead.id.startsWith('lead_',),);
  assert.ok(result.lead.score >= 30,);
},);

test('Lead Capture: returns existing lead on duplicate email', () => {
  const existing = { id: 'lead_1', email: 'dup@example.com', score: 50, status: 'new', };
  const result = adminIntel.captureLead({
    leads: [existing,],
    input: { email: 'dup@example.com', source: 'audit', },
  },);
  assert.equal(result.created, false,);
  assert.ok(result.lead,);
  assert.equal(result.lead.email, 'dup@example.com',);
},);

test('Lead Capture: requires email', () => {
  const result = adminIntel.captureLead({
    leads: [],
    input: { name: 'No Email', },
  },);
  assert.ok(result.error,);
},);

test('Lead Capture: awards source bonus', () => {
  const audit = adminIntel.captureLead({ leads: [], input: { email: 'a@t.com', source: 'audit', }, },);
  const landing = adminIntel.captureLead({ leads: [], input: { email: 'b@t.com', source: 'landing', }, },);
  assert.ok(audit.lead.score > landing.lead.score,);
},);

test('Lead Capture: awards Shopify domain bonus', () => {
  const shopify = adminIntel.captureLead({
    leads: [],
    input: { email: 's@t.com', storeUrl: 'https://mystore.myshopify.com', source: 'audit', },
  },);
  const other = adminIntel.captureLead({
    leads: [],
    input: { email: 'o@t.com', storeUrl: 'https://mystore.com', source: 'audit', },
  },);
  assert.ok(shopify.lead.score > other.lead.score,);
},);

test('Lead Capture: multi-touch bonus on re-capture', () => {
  const existing = {
    id: 'lead_1', email: 'mt@t.com', score: 50, status: 'new', source: 'audit',
    touchpoints: [{ source: 'audit', at: new Date().toISOString(), },],
  };
  const result = adminIntel.captureLead({
    leads: [existing,],
    input: { email: 'mt@t.com', source: 'landing', },
  },);
  assert.equal(result.created, false,);
  assert.ok(existing.touchpoints.length >= 2,);
  assert.ok(existing.score >= 55,);
},);

test('Lead Capture: assigns correct grade', () => {
  const hot = adminIntel.captureLead({
    leads: [],
    input: { email: 'hot@t.com', source: 'referral', storeUrl: 'https://s.myshopify.com', },
  },);
  // Score: 30 base + 20 referral + 10 storeUrl + 10 shopify = 70 → grade B
  assert.equal(hot.lead.grade, 'B',);
  assert.ok(hot.lead.score >= 60,);
},);

// ─── Behavioral Lead Scoring ──────────────────────────────────────────────────

test('Behavioral Scoring: boosts score for multi-touch leads', () => {
  const leads = [{
    id: 'lead_1', email: 'mt@t.com', score: 40,
    touchpoints: [
      { source: 'audit', at: new Date().toISOString(), },
      { source: 'landing', at: new Date().toISOString(), },
      { source: 'pricing', at: new Date().toISOString(), },
    ],
  },];
  const scored = adminIntel.scoreLeadsBehavioral({ leads, events: [], auditResults: [], },);
  assert.ok(scored[0].newScore > 40,);
  assert.ok(scored[0].signals.includes('multi_touch',),);
},);

test('Behavioral Scoring: penalizes stale leads', () => {
  const staleDate = new Date(Date.now() - 45 * 86400000,).toISOString();
  const leads = [{
    id: 'lead_1', email: 'stale@t.com', score: 60,
    touchpoints: [{ source: 'audit', at: staleDate, },],
  },];
  const scored = adminIntel.scoreLeadsBehavioral({ leads, events: [], auditResults: [], },);
  assert.ok(scored[0].signals.includes('stale',),);
  assert.ok(scored[0].newScore < 60,);
},);

test('Behavioral Scoring: rewards recent activity', () => {
  const leads = [{
    id: 'lead_1', email: 'recent@t.com', score: 40,
    touchpoints: [{ source: 'audit', at: new Date().toISOString(), },],
  },];
  const scored = adminIntel.scoreLeadsBehavioral({ leads, events: [], auditResults: [], },);
  assert.ok(scored[0].signals.includes('recent_activity',),);
},);

// ─── Trial Expiry Detection ───────────────────────────────────────────────────

test('Trial Expiry: detects inactive stores', () => {
  const oldDate = new Date(Date.now() - 20 * 86400000,).toISOString();
  const result = adminIntel.detectTrialExpiry({
    stores: [{ storeId: 's1', storeUrl: 'https://s.com', status: 'active', },],
    events: [{ storeId: 's1', timestamp: oldDate, },],
  },);
  assert.ok(result.length >= 1,);
  assert.equal(result[0].storeId, 's1',);
  assert.ok(result[0].daysSinceActivity >= 14,);
},);

test('Trial Expiry: ignores recently active stores', () => {
  const result = adminIntel.detectTrialExpiry({
    stores: [{ storeId: 's1', status: 'active', },],
    events: [{ storeId: 's1', timestamp: new Date().toISOString(), },],
  },);
  assert.equal(result.length, 0,);
},);

// ─── Campaign Engine ──────────────────────────────────────────────────────────

test('Campaign: creates campaign with required fields', () => {
  const result = adminIntel.createCampaign({ campaignActions: [], }, {
    name: 'Test Campaign', type: 'win_back',
  },);
  assert.ok(result.campaign,);
  assert.equal(result.campaign.name, 'Test Campaign',);
  assert.equal(result.campaign.type, 'win_back',);
  assert.ok(result.campaign.id.startsWith('camp_',),);
},);

test('Campaign: requires name and type', () => {
  const noName = adminIntel.createCampaign({ campaignActions: [], }, { type: 'win_back', },);
  assert.ok(noName.error,);
  const noType = adminIntel.createCampaign({ campaignActions: [], }, { name: 'Test', },);
  assert.ok(noType.error,);
},);

test('Campaign Suggestions: suggests win-back for declining stores', () => {
  const suggestions = adminIntel.suggestCampaigns({
    stores: [
      { storeId: 's1', healthScore: 30, status: 'active', mrr: 100, },
    ],
    leads: [], retentionSnapshots: [],
  },);
  assert.ok(suggestions.some((s,) => s.type === 'win_back',),);
},);

test('Campaign Suggestions: suggests upsell for healthy stores', () => {
  const suggestions = adminIntel.suggestCampaigns({
    stores: [
      { storeId: 's1', healthScore: 80, status: 'active', upsellOpportunities: ['premium',], },
    ],
    leads: [], retentionSnapshots: [],
  },);
  assert.ok(suggestions.some((s,) => s.type === 'upsell',),);
},);

test('Campaign Suggestions: suggests onboarding for hot leads', () => {
  const suggestions = adminIntel.suggestCampaigns({
    stores: [],
    leads: [{ score: 85, status: 'new', },],
    retentionSnapshots: [],
  },);
  assert.ok(suggestions.some((s,) => s.type === 'onboarding',),);
},);

test('Campaign Suggestions: sorts by priority', () => {
  const suggestions = adminIntel.suggestCampaigns({
    stores: [
      { storeId: 's1', healthScore: 30, status: 'active', mrr: 100, },
      { storeId: 's2', healthScore: 80, status: 'active', upsellOpportunities: ['premium',], },
    ],
    leads: [{ score: 85, status: 'new', },],
    retentionSnapshots: [],
  },);
  if (suggestions.length >= 2) {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3, };
    assert.ok(priorityOrder[suggestions[0].priority] <= priorityOrder[suggestions[1].priority],);
  }
},);

// ─── Feature Adoption ─────────────────────────────────────────────────────────

test('Feature Adoption: analyzes adoption with empty data', () => {
  const result = adminIntel.analyzeFeatureAdoption({ stores: [], events: [], },);
  assert.ok(result,);
  assert.ok(result.adoption,);
  assert.equal(result.totalStores, 0,);
},);

test('Feature Adoption: tracks feature usage', () => {
  const result = adminIntel.analyzeFeatureAdoption({
    stores: [
      { storeId: 's1', status: 'active', healthScore: 80, },
      { storeId: 's2', status: 'active', healthScore: 60, },
    ],
    events: [
      { storeId: 's1', event: 'feature_used', data: { feature: 'live_orders', }, },
      { storeId: 's1', event: 'feature_used', data: { feature: 'inventory', }, },
      { storeId: 's2', event: 'feature_used', data: { feature: 'live_orders', }, },
    ],
  },);
  assert.ok(result.adoption.live_orders.activeUsers === 2,);
  assert.ok(result.adoption.inventory.activeUsers === 1,);
},);

test('Feature Adoption: identifies top features', () => {
  const result = adminIntel.analyzeFeatureAdoption({
    stores: [{ storeId: 's1', }, { storeId: 's2', }, { storeId: 's3', },],
    events: [
      { storeId: 's1', event: 'feature_used', data: { feature: 'live_orders', }, },
      { storeId: 's2', event: 'feature_used', data: { feature: 'live_orders', }, },
      { storeId: 's3', event: 'feature_used', data: { feature: 'live_orders', }, },
      { storeId: 's1', event: 'feature_used', data: { feature: 'seo', }, },
    ],
  },);
  assert.ok(result.topFeatures.length > 0,);
  assert.equal(result.topFeatures[0].name, 'live_orders',);
},);
