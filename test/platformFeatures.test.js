'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const { createStore, } = require('../src/storage/store',);
const { createNotificationService, } = require('../src/layers/execution/notificationService',);
const { createTwoFactorAuth, generateTOTP, base32Encode, base32Decode, } = require('../src/server/twoFactorAuth',);
const { createActivityLog, } = require('../src/server/activityLog',);
const { createDataExportService, maskPII, } = require('../src/server/dataExport',);
const { createOnboardingService, STEPS, } = require('../src/server/onboardingService',);
const { createWebhookRetryQueue, RETRY_SCHEDULE_MS, MAX_RETRIES, } = require('../src/server/webhookRetryQueue',);
const { createTieredRateLimiter, PLAN_LIMITS, } = require('../src/server/tieredRateLimiter',);
const { createEmailTemplates, layout, button, infoBox, } = require('../src/layers/execution/emailTemplates',);

// ─── Helper: build a platform-like object with a real store ────────────
function buildPlatform() {
  const store = createStore();
  const notificationService = createNotificationService({ store, },);
  return { store, notificationService, };
}

// ═══════════════════════════════════════════════════════════════════════
// NOTIFICATION CENTER
// ═══════════════════════════════════════════════════════════════════════

test('Notification: push creates a notification', async () => {
  const { store, notificationService, } = buildPlatform();
  const n = await notificationService.push({ store_id: 's1', title: 'Test alert', severity: 'info', category: 'system', },);
  assert.ok(n._id,);
  assert.equal(n.title, 'Test alert',);
  assert.equal(n.severity, 'info',);
  assert.equal(n.read_at, null,);
},);

test('Notification: push requires store_id and title', async () => {
  const { notificationService, } = buildPlatform();
  await assert.rejects(() => notificationService.push({ title: 'no store', },), /store_id/,);
  await assert.rejects(() => notificationService.push({ store_id: 's1', },), /title/,);
},);

test('Notification: list returns notifications for a store', async () => {
  const { store, notificationService, } = buildPlatform();
  await notificationService.push({ store_id: 's1', title: 'A', },);
  await notificationService.push({ store_id: 's1', title: 'B', },);
  await notificationService.push({ store_id: 's2', title: 'C', },);
  const list = await notificationService.list('s1',);
  assert.equal(list.length, 2,);
  // Both have same timestamp; sort is stable, so both are returned.
  const titles = list.map((n,) => n.title,).sort();
  assert.deepEqual(titles, ['A', 'B',],);
},);

test('Notification: list supports severity filter', async () => {
  const { store, notificationService, } = buildPlatform();
  await notificationService.push({ store_id: 's1', title: 'Info', severity: 'info', },);
  await notificationService.push({ store_id: 's1', title: 'Critical', severity: 'critical', },);
  const list = await notificationService.list('s1', { severity: 'critical', },);
  assert.equal(list.length, 1,);
  assert.equal(list[0].severity, 'critical',);
},);

test('Notification: markRead marks all as read', async () => {
  const { store, notificationService, } = buildPlatform();
  await notificationService.push({ store_id: 's1', title: 'A', },);
  await notificationService.push({ store_id: 's1', title: 'B', },);
  const result = await notificationService.markRead('s1',);
  assert.equal(result.marked, 2,);
  const count = await notificationService.unreadCount('s1',);
  assert.equal(count, 0,);
},);

test('Notification: markRead marks single notification', async () => {
  const { store, notificationService, } = buildPlatform();
  const n1 = await notificationService.push({ store_id: 's1', title: 'A', },);
  await notificationService.push({ store_id: 's1', title: 'B', },);
  await notificationService.markRead('s1', n1._id,);
  const count = await notificationService.unreadCount('s1',);
  assert.equal(count, 1,);
},);

test('Notification: summary returns severity breakdown', async () => {
  const { store, notificationService, } = buildPlatform();
  await notificationService.push({ store_id: 's1', title: 'A', severity: 'warning', },);
  await notificationService.push({ store_id: 's1', title: 'B', severity: 'critical', },);
  await notificationService.push({ store_id: 's1', title: 'C', severity: 'info', },);
  const summary = await notificationService.summary('s1',);
  assert.equal(summary.total_unread, 3,);
  assert.equal(summary.by_severity.critical, 1,);
  assert.equal(summary.has_critical, true,);
},);

test('Notification: notifyFromEvent creates notification for known events', async () => {
  const { store, notificationService, } = buildPlatform();
  const n = await notificationService.notifyFromEvent({ store_id: 's1', event_type: 'purchase', data: { total: 99.99, }, },);
  assert.ok(n,);
  assert.equal(n.severity, 'success',);
  assert.equal(n.category, 'order',);
},);

test('Notification: notifyFromEvent returns null for unknown events', async () => {
  const { notificationService, } = buildPlatform();
  const n = await notificationService.notifyFromEvent({ store_id: 's1', event_type: 'unknown_event', },);
  assert.equal(n, null,);
},);

// ═══════════════════════════════════════════════════════════════════════
// TWO-FACTOR AUTH
// ═══════════════════════════════════════════════════════════════════════

test('2FA: enable generates secret and URI', async () => {
  const { store, } = buildPlatform();
  const tfa = createTwoFactorAuth({ store, },);
  const result = await tfa.enable('user1', { email: 'test@example.com', },);
  assert.ok(result.secret,);
  assert.ok(result.uri.includes('otpauth://totp',),);
  assert.ok(result.uri.includes('Storecops',),);
},);

test('2FA: isEnabled returns false initially', async () => {
  const { store, } = buildPlatform();
  const tfa = createTwoFactorAuth({ store, },);
  const enabled = await tfa.isEnabled('user1',);
  assert.equal(enabled, false,);
},);

test('2FA: isEnabled returns true after enable', async () => {
  const { store, } = buildPlatform();
  const tfa = createTwoFactorAuth({ store, },);
  await tfa.enable('user1', { email: 'test@example.com', },);
  const enabled = await tfa.isEnabled('user1',);
  assert.equal(enabled, true,);
},);

test('2FA: verify rejects missing params', async () => {
  const { store, } = buildPlatform();
  const tfa = createTwoFactorAuth({ store, },);
  const result = await tfa.verify(null, '123456',);
  assert.equal(result.valid, false,);
},);

test('2FA: verify rejects when not enabled', async () => {
  const { store, } = buildPlatform();
  const tfa = createTwoFactorAuth({ store, },);
  const result = await tfa.verify('user1', '123456',);
  assert.equal(result.valid, false,);
  assert.ok(result.reason.includes('not enabled',),);
},);

test('2FA: status returns enabled state', async () => {
  const { store, } = buildPlatform();
  const tfa = createTwoFactorAuth({ store, },);
  await tfa.enable('user1', { email: 'test@example.com', },);
  const status = await tfa.status('user1',);
  assert.equal(status.enabled, true,);
  assert.ok(status.backup_codes_remaining > 0,);
},);

test('2FA: disable turns off 2FA', async () => {
  const { store, } = buildPlatform();
  const tfa = createTwoFactorAuth({ store, },);
  await tfa.enable('user1', { email: 'test@example.com', },);
  const result = await tfa.disable('user1',);
  assert.equal(result.ok, true,);
  const enabled = await tfa.isEnabled('user1',);
  assert.equal(enabled, false,);
},);

test('2FA: base32 encode/decode roundtrip', () => {
  const original = Buffer.from('Hello World 12345',);
  const encoded = base32Encode(original,);
  const decoded = base32Decode(encoded,);
  assert.deepEqual(Buffer.from(decoded,), original,);
},);

test('2FA: generateTOTP produces 6-digit code', () => {
  const secret = Buffer.alloc(20,);
  const code = generateTOTP(secret, 1,);
  assert.equal(code.length, 6,);
  assert.ok(/^\d{6}$/.test(code,),);
},);

// ═══════════════════════════════════════════════════════════════════════
// ACTIVITY LOG
// ═══════════════════════════════════════════════════════════════════════

test('ActivityLog: record creates an entry', async () => {
  const { store, } = buildPlatform();
  const log = createActivityLog({ store, },);
  const entry = await log.record({ store_id: 's1', actor: 'user@test.com', action: 'login', },);
  assert.ok(entry._id,);
  assert.equal(entry.action, 'login',);
  assert.equal(entry.actor, 'user@test.com',);
},);

test('ActivityLog: record requires store_id, actor, action', async () => {
  const { store, } = buildPlatform();
  const log = createActivityLog({ store, },);
  await assert.rejects(() => log.record({ actor: 'a', action: 'b', },), /store_id/,);
  await assert.rejects(() => log.record({ store_id: 's1', action: 'b', },), /actor/,);
  await assert.rejects(() => log.record({ store_id: 's1', actor: 'a', },), /action/,);
},);

test('ActivityLog: query filters by store_id', async () => {
  const { store, } = buildPlatform();
  const log = createActivityLog({ store, },);
  await log.record({ store_id: 's1', actor: 'a', action: 'login', },);
  await log.record({ store_id: 's2', actor: 'b', action: 'login', },);
  const entries = await log.query('s1',);
  assert.equal(entries.length, 1,);
  assert.equal(entries[0].store_id, 's1',);
},);

test('ActivityLog: query filters by action type', async () => {
  const { store, } = buildPlatform();
  const log = createActivityLog({ store, },);
  await log.record({ store_id: 's1', actor: 'a', action: 'login', },);
  await log.record({ store_id: 's1', actor: 'a', action: 'signup', },);
  const entries = await log.query('s1', { action: 'signup', },);
  assert.equal(entries.length, 1,);
},);

test('ActivityLog: recent returns latest entries', async () => {
  const { store, } = buildPlatform();
  const log = createActivityLog({ store, },);
  for (let i = 0; i < 15; i++) {
    await log.record({ store_id: 's1', actor: 'a', action: `action_${i}`, },);
  }
  const recent = await log.recent('s1', 5,);
  assert.equal(recent.length, 5,);
},);

test('ActivityLog: summary counts by action', async () => {
  const { store, } = buildPlatform();
  const log = createActivityLog({ store, },);
  await log.record({ store_id: 's1', actor: 'a', action: 'login', },);
  await log.record({ store_id: 's1', actor: 'a', action: 'login', },);
  await log.record({ store_id: 's1', actor: 'a', action: 'signup', },);
  const summary = await log.summary('s1',);
  assert.equal(summary.total_events, 3,);
  assert.equal(summary.by_action.login, 2,);
  assert.equal(summary.by_action.signup, 1,);
},);

test('ActivityLog: export returns all entries', async () => {
  const { store, } = buildPlatform();
  const log = createActivityLog({ store, },);
  await log.record({ store_id: 's1', actor: 'a', action: 'login', },);
  await log.record({ store_id: 's1', actor: 'a', action: 'signup', },);
  const exported = await log.export('s1',);
  assert.equal(exported.total_entries, 2,);
  assert.ok(exported.exported_at,);
},);

// ═══════════════════════════════════════════════════════════════════════
// DATA EXPORT
// ═══════════════════════════════════════════════════════════════════════

test('DataExport: exportStoreData returns bundle', async () => {
  const { store, } = buildPlatform();
  const exporter = createDataExportService({ store, },);
  await store.customers.insert({ store_id: 's1', identity: 'c1', email: 'test@test.com', },);
  const bundle = await exporter.exportStoreData('s1',);
  assert.ok(bundle.store_id, 's1',);
  assert.ok(bundle.exported_at,);
  assert.equal(bundle.collections.customers.length, 1,);
  assert.ok(bundle.total_records >= 1,);
},);

test('DataExport: exportStoreData requires store_id', async () => {
  const { store, } = buildPlatform();
  const exporter = createDataExportService({ store, },);
  await assert.rejects(() => exporter.exportStoreData(), /store_id/,);
},);

test('DataExport: anonymize masks PII', async () => {
  const { store, } = buildPlatform();
  const exporter = createDataExportService({ store, },);
  await store.customers.insert({ store_id: 's1', identity: 'c1', email: 'real@email.com', phone: '+1234567890', },);
  const bundle = await exporter.exportStoreData('s1', { anonymize: true, },);
  const customer = bundle.collections.customers[0];
  assert.ok(!customer.email.includes('real',),);
  assert.ok(customer.email.includes('***',),);
},);

test('DataExport: selective export limits collections', async () => {
  const { store, } = buildPlatform();
  const exporter = createDataExportService({ store, },);
  await store.customers.insert({ store_id: 's1', identity: 'c1', },);
  await store.events.insert({ store_id: 's1', event_type: 'purchase', },);
  const bundle = await exporter.exportStoreData('s1', { collections: ['customers',], },);
  assert.ok(bundle.collections.customers,);
  assert.equal(bundle.collections.events, undefined,);
},);

test('DataExport: previewStoreData returns counts', async () => {
  const { store, } = buildPlatform();
  const exporter = createDataExportService({ store, },);
  await store.customers.insert({ store_id: 's1', identity: 'c1', },);
  await store.events.insert({ store_id: 's1', event_type: 'purchase', },);
  const preview = await exporter.previewStoreData('s1',);
  assert.equal(preview.collection_counts.customers, 1,);
  assert.ok(preview.total_records >= 1,);
},);

test('DataExport: exportCustomerData returns single customer data', async () => {
  const { store, } = buildPlatform();
  const exporter = createDataExportService({ store, },);
  await store.customers.insert({ store_id: 's1', identity: 'c1', email: 'test@test.com', },);
  await store.events.insert({ store_id: 's1', customer_id: 'c1', event_type: 'purchase', },);
  const data = await exporter.exportCustomerData('s1', 'c1',);
  assert.ok(data.profile,);
  assert.equal(data.events.length, 1,);
},);

test('DataExport: generateExportFile returns file content', async () => {
  const { store, } = buildPlatform();
  const exporter = createDataExportService({ store, },);
  const file = await exporter.generateExportFile('s1',);
  assert.ok(file.filename.includes('storecops-export',),);
  assert.ok(file.size_bytes > 0,);
  assert.equal(file.content_type, 'application/json',);
},);

test('maskPII: masks email correctly', () => {
  const masked = maskPII({ email: 'john@example.com', name: 'John', },);
  assert.ok(masked.email.includes('j***@e***',),);
},);

test('maskPII: masks phone correctly', () => {
  const masked = maskPII({ phone: '+1234567890', },);
  assert.ok(masked.phone.includes('***',),);
  assert.ok(!masked.phone.includes('4567',),);
},);

// ═══════════════════════════════════════════════════════════════════════
// ONBOARDING WIZARD
// ═══════════════════════════════════════════════════════════════════════

test('Onboarding: getState initializes fresh state', async () => {
  const { store, } = buildPlatform();
  const onboarding = createOnboardingService({ store, },);
  const state = await onboarding.getState('s1',);
  assert.ok(state,);
  assert.equal(state.store_id, 's1',);
  assert.equal(state.completed, false,);
  assert.equal(state.current_step, 'welcome',);
  assert.ok(state.steps.welcome,);
},);

test('Onboarding: completeStep marks step done', async () => {
  const { store, } = buildPlatform();
  const onboarding = createOnboardingService({ store, },);
  const state = await onboarding.completeStep('s1', 'welcome',);
  assert.equal(state.steps.welcome.completed, true,);
  assert.ok(state.completion_pct > 0,);
},);

test('Onboarding: completeStep advances to next step', async () => {
  const { store, } = buildPlatform();
  const onboarding = createOnboardingService({ store, },);
  await onboarding.completeStep('s1', 'welcome',);
  const state = await onboarding.getState('s1',);
  assert.equal(state.current_step, 'connect_store',);
},);

test('Onboarding: skipStep skips a step', async () => {
  const { store, } = buildPlatform();
  const onboarding = createOnboardingService({ store, },);
  const state = await onboarding.skipStep('s1', 'welcome',);
  assert.equal(state.steps.welcome.skipped, true,);
},);

test('Onboarding: getNextAction returns current step', async () => {
  const { store, } = buildPlatform();
  const onboarding = createOnboardingService({ store, },);
  const next = await onboarding.getNextAction('s1',);
  assert.equal(next.action, 'welcome',);
  assert.ok(next.title,);
  assert.ok(next.total_steps > 0,);
},);

test('Onboarding: completing all steps marks complete', async () => {
  const { store, } = buildPlatform();
  const onboarding = createOnboardingService({ store, },);
  for (const step of STEPS) {
    await onboarding.completeStep('s1', step.id,);
  }
  const state = await onboarding.getState('s1',);
  assert.equal(state.completed, true,);
  assert.equal(state.completion_pct, 100,);
},);

test('Onboarding: getAnalytics returns summary', async () => {
  const { store, } = buildPlatform();
  const onboarding = createOnboardingService({ store, },);
  await onboarding.completeStep('s1', 'welcome',);
  await onboarding.completeStep('s2', 'welcome',);
  const analytics = await onboarding.getAnalytics();
  assert.equal(analytics.total_stores, 2,);
  assert.ok(analytics.step_completion.welcome.completed >= 2,);
},);

test('Onboarding: completeStep rejects unknown step', async () => {
  const { store, } = buildPlatform();
  const onboarding = createOnboardingService({ store, },);
  await assert.rejects(() => onboarding.completeStep('s1', 'nonexistent',), /Unknown step/,);
},);

// ═══════════════════════════════════════════════════════════════════════
// WEBHOOK RETRY QUEUE
// ═══════════════════════════════════════════════════════════════════════

test('WebhookQueue: enqueue creates a pending entry', async () => {
  const { store, notificationService, } = buildPlatform();
  const queue = createWebhookRetryQueue({ store, notificationService, },);
  const result = await queue.enqueue({
    store_id: 's1',
    url: 'https://httpbin.org/status/404',
    payload: { test: true, },
  },);
  assert.ok(result.enqueued,);
  assert.ok(result.id,);
},);

test('WebhookQueue: enqueue requires url and payload', async () => {
  const { store, notificationService, } = buildPlatform();
  const queue = createWebhookRetryQueue({ store, notificationService, },);
  await assert.rejects(() => queue.enqueue({ payload: {}, },), /url/,);
  await assert.rejects(() => queue.enqueue({ url: 'https://x.com', },), /payload/,);
},);

test('WebhookQueue: status returns queue summary', async () => {
  const { store, notificationService, } = buildPlatform();
  const queue = createWebhookRetryQueue({ store, notificationService, },);
  await queue.enqueue({ store_id: 's1', url: 'https://httpbin.org/status/500', payload: { a: 1, }, },);
  const status = await queue.status();
  assert.ok(status.total >= 1,);
  assert.ok('pending' in status,);
  assert.ok('delivered' in status,);
  assert.ok('dead_letter' in status,);
},);

test('WebhookQueue: RETRY_SCHEDULE_MS has correct length', () => {
  assert.equal(RETRY_SCHEDULE_MS.length, MAX_RETRIES,);
  assert.equal(RETRY_SCHEDULE_MS[0], 0,); // immediate first attempt
},);

test('WebhookQueue: cleanup returns cleared count', async () => {
  const { store, notificationService, } = buildPlatform();
  const queue = createWebhookRetryQueue({ store, notificationService, },);
  const result = await queue.cleanup(0,); // cleanup everything older than 0 days
  assert.ok('cleared' in result,);
},);

// ═══════════════════════════════════════════════════════════════════════
// TIERED RATE LIMITER
// ═══════════════════════════════════════════════════════════════════════

test('TieredRateLimiter: PLAN_LIMITS has all tiers', () => {
  assert.ok(PLAN_LIMITS.free,);
  assert.ok(PLAN_LIMITS.starter,);
  assert.ok(PLAN_LIMITS.growth,);
  assert.ok(PLAN_LIMITS.premium,);
  assert.ok(PLAN_LIMITS.admin,);
  assert.ok(PLAN_LIMITS.free.rpm < PLAN_LIMITS.premium.rpm,);
},);

test('TieredRateLimiter: getUsage returns usage info', () => {
  const { store, } = buildPlatform();
  const limiter = createTieredRateLimiter({ store, },);
  const req = { authUser: { email: 'test@test.com', plan: 'growth', }, get: () => null, ip: '1.2.3.4', };
  const usage = limiter.getUsage(req,);
  assert.ok(usage.per_minute,);
  assert.ok(usage.daily,);
  assert.equal(usage.plan, 'growth',);
  assert.equal(usage.per_minute.limit, PLAN_LIMITS.growth.rpm,);
},);

test('TieredRateLimiter: middleware passes under limit', () => {
  const { store, } = buildPlatform();
  const limiter = createTieredRateLimiter({ store, },);
  const headers = {};
  const req = { authUser: { email: 'test@test.com', plan: 'free', }, get: () => null, ip: '1.2.3.4', };
  const res = { set: (k, v,) => { headers[k] = v; }, };
  let nextCalled = false;
  limiter.middleware(req, res, () => { nextCalled = true; },);
  assert.equal(nextCalled, true,);
  assert.ok(headers['X-RateLimit-Plan'],);
},);

test('TieredRateLimiter: admin gets highest limits', () => {
  const { store, } = buildPlatform();
  const limiter = createTieredRateLimiter({ store, },);
  const req = { authUser: { email: 'master@platform', role: 'admin', }, get: () => null, ip: '1.2.3.4', };
  const usage = limiter.getUsage(req,);
  assert.equal(usage.per_minute.limit, PLAN_LIMITS.admin.rpm,);
},);

// ═══════════════════════════════════════════════════════════════════════
// EMAIL TEMPLATES
// ═══════════════════════════════════════════════════════════════════════

test('EmailTemplates: welcome generates HTML', () => {
  const templates = createEmailTemplates({ config: { publicUrl: 'https://app.storecops.com', }, },);
  const html = templates.welcome({ name: 'John', storeName: 'Test Store', },);
  assert.ok(html.includes('Welcome to Storecops',),);
  assert.ok(html.includes('John',),);
  assert.ok(html.includes('Test Store',),);
  assert.ok(html.includes('<!DOCTYPE html>',),);
},);

test('EmailTemplates: invoice includes amount and plan', () => {
  const templates = createEmailTemplates({ config: { publicUrl: 'https://app.storecops.com', }, },);
  const html = templates.invoice({ customerName: 'Jane', invoiceNumber: '1234', amount: 49, currency: 'usd', planName: 'Growth', },);
  assert.ok(html.includes('$49.00',),);
  assert.ok(html.includes('Growth',),);
  assert.ok(html.includes('#1234',),);
},);

test('EmailTemplates: invoice handles INR currency', () => {
  const templates = createEmailTemplates({ config: { publicUrl: 'https://app.storecops.com', }, },);
  const html = templates.invoice({ amount: 4199, currency: 'inr', planName: 'Growth INR', },);
  assert.ok(html.includes('₹4199.00',),);
},);

test('EmailTemplates: trialExpiry shows urgency', () => {
  const templates = createEmailTemplates({ config: { publicUrl: 'https://app.storecops.com', }, },);
  const html = templates.trialExpiry({ name: 'Alex', storeName: 'My Store', daysLeft: 1, },);
  assert.ok(html.includes('today',),);
  assert.ok(html.includes('Upgrade Now',),);
},);

test('EmailTemplates: subscriptionRenewal includes next billing date', () => {
  const templates = createEmailTemplates({ config: { publicUrl: 'https://app.storecops.com', }, },);
  const html = templates.subscriptionRenewal({ name: 'Bob', planName: 'Premium', amount: 99, nextBillingDate: '2026-09-15', },);
  assert.ok(html.includes('Premium',),);
  assert.ok(html.includes('2026-09-15',),);
},);

test('EmailTemplates: planChange shows from/to plans', () => {
  const templates = createEmailTemplates({ config: { publicUrl: 'https://app.storecops.com', }, },);
  const html = templates.planChange({ name: 'Eve', fromPlan: 'Free', toPlan: 'Growth', },);
  assert.ok(html.includes('Free',),);
  assert.ok(html.includes('Growth',),);
},);

test('EmailTemplates: seoReport includes score', () => {
  const templates = createEmailTemplates({ config: { publicUrl: 'https://app.storecops.com', }, },);
  const html = templates.seoReport({ storeUrl: 'https://mystore.com', score: 72, grade: 'B', },);
  assert.ok(html.includes('72',),);
  assert.ok(html.includes('B',),);
},);

test('EmailTemplates: passwordReset includes reset link', () => {
  const templates = createEmailTemplates({ config: { publicUrl: 'https://app.storecops.com', }, },);
  const html = templates.passwordReset({ name: 'Sam', resetUrl: 'https://app.storecops.com/reset?token=abc', },);
  assert.ok(html.includes('Reset Your Password',),);
  assert.ok(html.includes('reset?token=abc',),);
},);

test('EmailTemplates: twoFactorEnabled confirms 2FA', () => {
  const templates = createEmailTemplates({ config: { publicUrl: 'https://app.storecops.com', }, },);
  const html = templates.twoFactorEnabled({ name: 'Kim', },);
  assert.ok(html.includes('Two-Factor Authentication',),);
  assert.ok(html.includes('Kim',),);
},);

test('EmailTemplates: dataExportReady includes record count', () => {
  const templates = createEmailTemplates({ config: { publicUrl: 'https://app.storecops.com', }, },);
  const html = templates.dataExportReady({ name: 'Pat', storeName: 'My Shop', recordCount: 150, },);
  assert.ok(html.includes('150',),);
  assert.ok(html.includes('Download Export',),);
},);

test('EmailTemplates: layout includes brand header', () => {
  const html = layout('Test Title', '<p>Content</p>',);
  assert.ok(html.includes('Test Title',),);
  assert.ok(html.includes('Storecops Growth Platform',),);
  assert.ok(html.includes('<!DOCTYPE html>',),);
},);

test('EmailTemplates: button generates clickable link', () => {
  const html = button('Click Me', 'https://example.com',);
  assert.ok(html.includes('Click Me',),);
  assert.ok(html.includes('https://example.com',),);
},);

test('EmailTemplates: infoBox generates styled box', () => {
  const html = infoBox('Important info',);
  assert.ok(html.includes('Important info',),);
  assert.ok(html.includes('border-left',),);
},);
