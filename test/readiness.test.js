'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const {
  classifyValue,
  assessIntegrations,
  buildReadinessReport,
  formatReport,
} = require('../src/config/readiness.js',);

// ─── classifyValue ──────────────────────────────────────────────────────────

test('readiness: an empty value is classified as empty', () => {
  assert.strictEqual(classifyValue('',).status, 'empty',);
  assert.strictEqual(classifyValue('   ',).status, 'empty',);
  assert.strictEqual(classifyValue(undefined,).status, 'empty',);
},);

test('readiness: the Railway placeholder host is detected', () => {
  const r = classifyValue('https://your-app.up.railway.app',);
  assert.strictEqual(r.status, 'placeholder',);
  assert.match(r.label, /Railway/i,);
},);

test('readiness: example.com is detected as a placeholder', () => {
  assert.strictEqual(classifyValue('https://example.com/app',).status, 'placeholder',);
  assert.strictEqual(classifyValue('https://api.example.org',).status, 'placeholder',);
},);

test('readiness: generic placeholder words are detected', () => {
  assert.strictEqual(classifyValue('https://your-domain.com',).status, 'placeholder',);
  assert.strictEqual(classifyValue('https://change-me.io',).status, 'placeholder',);
  assert.strictEqual(classifyValue('https://app.example.com',).status, 'placeholder',);
  assert.strictEqual(classifyValue('TODO',).status, 'placeholder',);
},);

test('readiness: REPLACE_WITH_* sentinel values are detected', () => {
  // Regression guard: `_` is a word character, so a naive trailing \b fails here.
  assert.strictEqual(classifyValue('REPLACE_WITH_PARTNER_DASHBOARD_CLIENT_ID',).status, 'placeholder',);
  assert.strictEqual(classifyValue('replace-with-your-key',).status, 'placeholder',);
  assert.strictEqual(classifyValue('your_client_secret',).status, 'placeholder',);
  assert.strictEqual(classifyValue('insert-your-token',).status, 'placeholder',);
},);

test('readiness: angle-bracket templates are detected', () => {
  assert.strictEqual(classifyValue('https://<your-host>',).status, 'placeholder',);
},);

test('readiness: local addresses are detected as local, not ok', () => {
  assert.strictEqual(classifyValue('http://localhost:4000',).status, 'local',);
  assert.strictEqual(classifyValue('http://127.0.0.1:4000',).status, 'local',);
  assert.strictEqual(classifyValue('http://0.0.0.0:4000',).status, 'local',);
},);

test('readiness: a real public URL is ok', () => {
  assert.strictEqual(classifyValue('https://storecops.com',).status, 'ok',);
  assert.strictEqual(classifyValue('https://app.acme.io',).status, 'ok',);
},);

test('readiness: a real domain containing "app" is not mistaken for a placeholder', () => {
  // Regression guard: the placeholder regexes must not be so greedy that they
  // reject legitimate hosts like these.
  assert.strictEqual(classifyValue('https://appstorecops.com',).status, 'ok',);
  assert.strictEqual(classifyValue('https://myappstore.com',).status, 'ok',);
  assert.strictEqual(classifyValue('https://todoist-integration.com',).status, 'ok',);
},);

// ─── assessIntegrations ─────────────────────────────────────────────────────

test('readiness: integrations with no credentials are reported missing', () => {
  const results = assessIntegrations({},);
  const shopify = results.find((r,) => r.name === 'Shopify',);
  const email = results.find((r,) => r.name === 'Email',);
  assert.strictEqual(shopify.status, 'missing',);
  assert.deepStrictEqual(shopify.missing.sort(), ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET',],);
  assert.strictEqual(email.status, 'missing',);
},);

test('readiness: email is ready when Resend is configured', () => {
  const results = assessIntegrations({ RESEND_API_KEY: 're_abc123', },);
  assert.strictEqual(results.find((r,) => r.name === 'Email',).status, 'ready',);
},);

test('readiness: email is ready when SMTP is fully configured', () => {
  const results = assessIntegrations({
    SMTP_HOST: 'smtp.acme.io',
    SMTP_USER: 'user',
    SMTP_PASS: 'pass',
  },);
  assert.strictEqual(results.find((r,) => r.name === 'Email',).status, 'ready',);
},);

test('readiness: email is missing when SMTP is only partially configured', () => {
  const results = assessIntegrations({ SMTP_HOST: 'smtp.acme.io', },);
  assert.strictEqual(results.find((r,) => r.name === 'Email',).status, 'missing',);
},);

test('readiness: WhatsApp needs both token and phone number id', () => {
  assert.strictEqual(
    assessIntegrations({ WHATSAPP_ACCESS_TOKEN: 'tok', },).find((r,) => r.name === 'WhatsApp',).status,
    'missing',
  );
  assert.strictEqual(
    assessIntegrations({
      WHATSAPP_ACCESS_TOKEN: 'tok',
      WHATSAPP_PHONE_NUMBER_ID: '123',
    },).find((r,) => r.name === 'WhatsApp',).status,
    'ready',
  );
},);

test('readiness: a console provider is reported as deliberately disabled', () => {
  const results = assessIntegrations({ EMAIL_PROVIDER: 'console', },);
  assert.strictEqual(results.find((r,) => r.name === 'Email',).status, 'disabled',);
},);

test('readiness: a placeholder credential does not count as configured', () => {
  const results = assessIntegrations({ RESEND_API_KEY: 'change-me', },);
  assert.strictEqual(results.find((r,) => r.name === 'Email',).status, 'missing',);
},);

// ─── buildReadinessReport ───────────────────────────────────────────────────

/** A minimally-valid production environment. */
function goodEnv(overrides = {},) {
  return {
    NODE_ENV: 'production',
    API_KEY: 'a'.repeat(64,),
    WEBHOOK_SECRET: 'b'.repeat(64,),
    TOKEN_ENCRYPTION_KEY: 'c'.repeat(64,),
    PUBLIC_URL: 'https://storecops.com',
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_real',
    EMAIL_UNSUBSCRIBE_SECRET: 'd'.repeat(32,),
    WHATSAPP_PROVIDER: 'meta',
    WHATSAPP_ACCESS_TOKEN: 'tok',
    WHATSAPP_PHONE_NUMBER_ID: '123',
    SHOPIFY_CLIENT_ID: 'cid',
    SHOPIFY_CLIENT_SECRET: 'csecret',
    ...overrides,
  };
}

test('readiness: a fully-configured production env has nothing blocking', () => {
  const report = buildReadinessReport(goodEnv(),);
  assert.deepStrictEqual(report.blocking, [],);
},);

test('readiness: the Railway placeholder PUBLIC_URL is blocking', () => {
  const report = buildReadinessReport(goodEnv({ PUBLIC_URL: 'https://your-app.up.railway.app', },),);
  const ids = report.blocking.map((b,) => b.id,);
  assert.ok(ids.includes('public-url-placeholder',), `expected public-url-placeholder, got ${ids.join(',',)}`,);
},);

test('readiness: an unset PUBLIC_URL is blocking', () => {
  const report = buildReadinessReport(goodEnv({ PUBLIC_URL: '', },),);
  assert.ok(report.blocking.some((b,) => b.id === 'public-url-empty',),);
},);

test('readiness: a localhost PUBLIC_URL is blocking in production', () => {
  const report = buildReadinessReport(goodEnv({ PUBLIC_URL: 'http://localhost:4000', },),);
  assert.ok(report.blocking.some((b,) => b.id === 'public-url-local',),);
},);

test('readiness: missing required secrets are blocking', () => {
  const env = goodEnv();
  delete env.API_KEY;
  delete env.WEBHOOK_SECRET;
  const report = buildReadinessReport(env,);
  const entry = report.blocking.find((b,) => b.id === 'missing-secrets',);
  assert.ok(entry,);
  assert.match(entry.message, /API_KEY/,);
  assert.match(entry.message, /WEBHOOK_SECRET/,);
},);

test('readiness: the dev-key sentinel is blocking in production', () => {
  const report = buildReadinessReport(goodEnv({ API_KEY: 'dev-key', },),);
  assert.ok(report.blocking.some((b,) => b.id === 'sentinel-API_KEY',),);
},);

test('readiness: missing delivery credentials warn that nothing can be sent', () => {
  const env = goodEnv();
  delete env.RESEND_API_KEY;
  delete env.WHATSAPP_ACCESS_TOKEN;
  delete env.WHATSAPP_PHONE_NUMBER_ID;
  const report = buildReadinessReport(env,);
  assert.deepStrictEqual(report.blocking, [],);
  // With no channel at all, the headline warning fires...
  assert.ok(report.warnings.some((w,) => w.id === 'no-delivery-channel',),);
  // ...and each inert channel is itemised as a note.
  const noteIds = report.notes.map((n,) => n.id,);
  assert.ok(noteIds.includes('integration-Email',),);
  assert.ok(noteIds.includes('integration-WhatsApp',),);
},);

test('readiness: one working channel downgrades the other to a note', () => {
  const env = goodEnv();
  delete env.WHATSAPP_ACCESS_TOKEN;
  delete env.WHATSAPP_PHONE_NUMBER_ID;
  const report = buildReadinessReport(env,);
  assert.ok(!report.warnings.some((w,) => w.id === 'no-delivery-channel',),);
  assert.ok(report.notes.some((n,) => n.id === 'integration-WhatsApp',),);
},);

test('readiness: a missing unsubscribe secret warns only when email can send', () => {
  const env = goodEnv();
  delete env.EMAIL_UNSUBSCRIBE_SECRET;
  assert.ok(
    buildReadinessReport(env,).warnings.some((w,) => w.id === 'integration-Email-unsubscribe',),
  );

  // If email itself is broken, the unsubscribe secret is moot — no double report.
  const noEmail = goodEnv();
  delete noEmail.EMAIL_UNSUBSCRIBE_SECRET;
  delete noEmail.RESEND_API_KEY;
  assert.ok(
    !buildReadinessReport(noEmail,).warnings.some((w,) => w.id === 'integration-Email-unsubscribe',),
  );
},);

test('readiness: Stripe and Razorpay absence is a note, not a warning', () => {
  const report = buildReadinessReport(goodEnv(),);
  assert.ok(!report.warnings.some((w,) => /Stripe|Razorpay/.test(w.id,),),);
  const noteIds = report.notes.map((n,) => n.id,);
  assert.ok(noteIds.includes('integration-Stripe',),);
  assert.ok(noteIds.includes('integration-Razorpay',),);
},);

test('readiness: missing Shopify credentials are warned about', () => {
  const env = goodEnv();
  delete env.SHOPIFY_CLIENT_ID;
  delete env.SHOPIFY_CLIENT_SECRET;
  const report = buildReadinessReport(env,);
  assert.ok(report.warnings.some((w,) => w.id === 'integration-Shopify',),);
},);

test('readiness: a console provider in production is flagged as a no-op', () => {
  const env = goodEnv({ EMAIL_PROVIDER: 'console', },);
  delete env.RESEND_API_KEY;
  const report = buildReadinessReport(env,);
  assert.ok(report.notes.some((n,) => n.id === 'integration-Email-disabled',),);
},);

test('readiness: development mode does not treat localhost as blocking', () => {
  const report = buildReadinessReport({ NODE_ENV: 'development', PUBLIC_URL: 'http://localhost:4000', },);
  assert.ok(!report.blocking.some((b,) => b.id === 'public-url-local',),);
},);

// ─── formatReport ───────────────────────────────────────────────────────────

test('readiness: the formatted report names every blocking item and its fix', () => {
  const report = buildReadinessReport(goodEnv({ PUBLIC_URL: 'https://your-app.up.railway.app', },),);
  const text = formatReport(report,);
  assert.match(text, /BLOCKING/,);
  assert.match(text, /your-app\.up\.railway\.app/,);
  assert.match(text, /->/,);
},);

test('readiness: a clean report says so', () => {
  const text = formatReport(buildReadinessReport(goodEnv(),),);
  assert.match(text, /All blocking and warning checks passed/,);
},);

test('readiness: the report lists integration status', () => {
  const text = formatReport(buildReadinessReport(goodEnv(),),);
  assert.match(text, /Shopify/,);
  assert.match(text, /ready/,);
},);
