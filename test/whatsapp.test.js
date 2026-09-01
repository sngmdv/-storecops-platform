'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('crypto',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);
const {
  createMetaWhatsAppProvider,
  verifyWebhookSignature,
  parseStatusUpdates,
  parseIncomingMessages,
  buildTemplatePayload,
  buildTextPayload,
  getTemplateName,
  DEFAULT_TEMPLATE_MAP,
} = require('../src/layers/execution/whatsappService',);
const { createProviderRegistry, } = require('../src/layers/execution/providers',);

const STORE = 'store_wa_test';

// ── Helper: mock fetch for Meta API calls ────────────────────────────
function mockFetch(responseBody, ok = true, status = 200,) {
  const calls = [];
  const fn = async (url, opts,) => {
    calls.push({ url, opts, },);
    return {
      ok,
      status,
      json: async () => responseBody,
    };
  };
  fn.calls = calls;
  return fn;
}

// ── Unit tests: payload builders ─────────────────────────────────────

test('buildTemplatePayload: creates correct Meta API payload for cart recovery', () => {
  const payload = buildTemplatePayload('+15551234567', 'recovery_message', 'test body', {
    name: 'Alice',
    discount: '10',
  },);

  assert.equal(payload.messaging_product, 'whatsapp',);
  assert.equal(payload.to, '+15551234567',);
  assert.equal(payload.type, 'template',);
  assert.equal(payload.template.name, 'cart_recovery',);
  assert.equal(payload.template.language.code, 'en_US',);
  assert.ok(payload.template.components.length > 0,);
  assert.equal(payload.template.components[0].type, 'body',);
  assert.equal(payload.template.components[0].parameters[0].text, 'Alice',);
  assert.equal(payload.template.components[0].parameters[1].text, '10',);
},);

test('buildTextPayload: creates correct free-form text payload', () => {
  const payload = buildTextPayload('+15551234567', 'Hello there!',);

  assert.equal(payload.messaging_product, 'whatsapp',);
  assert.equal(payload.to, '+15551234567',);
  assert.equal(payload.type, 'text',);
  assert.equal(payload.text.body, 'Hello there!',);
},);

test('getTemplateName: uses defaults and env overrides', () => {
  // Default mapping.
  assert.equal(getTemplateName('recovery_message',), 'cart_recovery',);
  assert.equal(getTemplateName('winback_offer',), 'winback_discount',);
  assert.equal(getTemplateName('vip_surprise',), 'vip_thankyou',);

  // Unknown type falls back to generic.
  assert.equal(getTemplateName('unknown_type',), 'generic_message',);

  // Env override.
  process.env.WHATSAPP_TEMPLATE_RECOVERY_MESSAGE = 'custom_cart_template';
  assert.equal(getTemplateName('recovery_message',), 'custom_cart_template',);
  delete process.env.WHATSAPP_TEMPLATE_RECOVERY_MESSAGE;
},);

// ── Unit tests: webhook parsing ──────────────────────────────────────

test('parseStatusUpdates: extracts delivery statuses from Meta webhook', () => {
  const webhookBody = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { display_phone_number: '+15559876543', },
              statuses: [
                {
                  id: 'wamid.abc123',
                  recipient_id: '+15551234567',
                  status: 'delivered',
                  timestamp: '1692000000',
                  errors: [],
                },
                {
                  id: 'wamid.def456',
                  recipient_id: '+15551234567',
                  status: 'read',
                  timestamp: '1692000060',
                  errors: [],
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const statuses = parseStatusUpdates(webhookBody,);
  assert.equal(statuses.length, 2,);
  assert.equal(statuses[0].message_id, 'wamid.abc123',);
  assert.equal(statuses[0].status, 'delivered',);
  assert.equal(statuses[0].phone, '+15559876543',);
  assert.equal(statuses[1].status, 'read',);
},);

test('parseStatusUpdates: handles failed status with errors', () => {
  const webhookBody = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: {},
              statuses: [
                {
                  id: 'wamid.fail789',
                  recipient_id: '+15551234567',
                  status: 'failed',
                  timestamp: '1692000120',
                  errors: [{ code: 131047, title: 'Unsupported message type', },],
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const statuses = parseStatusUpdates(webhookBody,);
  assert.equal(statuses.length, 1,);
  assert.equal(statuses[0].status, 'failed',);
  assert.equal(statuses[0].errors.length, 1,);
  assert.equal(statuses[0].errors[0].code, 131047,);
},);

test('parseIncomingMessages: extracts customer text replies', () => {
  const webhookBody = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messages: [
                {
                  id: 'wamid.incoming001',
                  from: '+15551234567',
                  type: 'text',
                  text: { body: 'Yes I want to order', },
                  timestamp: '1692001000',
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const messages = parseIncomingMessages(webhookBody,);
  assert.equal(messages.length, 1,);
  assert.equal(messages[0].from, '+15551234567',);
  assert.equal(messages[0].text, 'Yes I want to order',);
},);

test('parseIncomingMessages: ignores non-text messages (images, etc.)', () => {
  const webhookBody = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messages: [
                { id: 'wamid.img001', from: '+15551234567', type: 'image', image: {}, },
              ],
            },
          },
        ],
      },
    ],
  };

  const messages = parseIncomingMessages(webhookBody,);
  assert.equal(messages.length, 0,);
},);

test('parseStatusUpdates: returns empty for non-message fields', () => {
  const webhookBody = {
    entry: [
      {
        changes: [
          { field: 'account_review_update', value: {}, },
        ],
      },
    ],
  };

  assert.deepEqual(parseStatusUpdates(webhookBody,), [],);
  assert.deepEqual(parseIncomingMessages(webhookBody,), [],);
},);

// ── Unit tests: webhook signature verification ───────────────────────

test('verifyWebhookSignature: valid signature passes', () => {
  const secret = 'test_app_secret';
  const body = '{"entry":[]}';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret,).update(body,).digest('hex',);

  assert.equal(verifyWebhookSignature(body, expected, secret,), true,);
},);

test('verifyWebhookSignature: tampered signature fails', () => {
  const secret = 'test_app_secret';
  const body = '{"entry":[]}';
  const badSig = 'sha256=' + 'a'.repeat(64,);

  assert.equal(verifyWebhookSignature(body, badSig, secret,), false,);
},);

test('verifyWebhookSignature: missing params fail', () => {
  assert.equal(verifyWebhookSignature('', 'sha256=abc', 'secret',), false,);
  assert.equal(verifyWebhookSignature('body', '', 'secret',), false,);
  assert.equal(verifyWebhookSignature('body', 'sha256=abc', '',), false,);
},);

// ── Integration tests: Meta provider ─────────────────────────────────

test('Meta WhatsApp provider: sends template message via fetch', async () => {
  const provider = createMetaWhatsAppProvider({
    accessToken: 'test_token',
    phoneNumberId: 'test_phone_id',
    store: null,
  },);

  // Intercept fetch.
  const origFetch = globalThis.fetch;
  const mock = mockFetch({ messages: [{ id: 'wamid.sent001', },], },);
  globalThis.fetch = mock;

  try {
    const result = await provider.send({
      to: '+15551234567',
      body: 'Your cart is waiting!',
      meta: { action_type: 'recovery_message', params: { name: 'Alice', }, },
    },);

    assert.equal(result.delivered, true,);
    assert.equal(result.provider, 'meta:whatsapp',);
    assert.equal(result.message_id, 'wamid.sent001',);

    // Verify the fetch call was correct.
    assert.equal(mock.calls.length, 1,);
    const call = mock.calls[0];
    assert.ok(call.url.includes('test_phone_id/messages',),);
    assert.equal(call.opts.headers.Authorization, 'Bearer test_token',);
    const sentBody = JSON.parse(call.opts.body,);
    assert.equal(sentBody.type, 'template',);
    assert.equal(sentBody.template.name, 'cart_recovery',);
  } finally {
    globalThis.fetch = origFetch;
  }
},);

test('Meta WhatsApp provider: sends text message when use_text=true', async () => {
  const provider = createMetaWhatsAppProvider({
    accessToken: 'test_token',
    phoneNumberId: 'test_phone_id',
  },);

  const origFetch = globalThis.fetch;
  const mock = mockFetch({ messages: [{ id: 'wamid.text001', },], },);
  globalThis.fetch = mock;

  try {
    const result = await provider.send({
      to: '+15551234567',
      body: 'Quick reply within 24h window',
      meta: { use_text: true, },
    },);

    assert.equal(result.delivered, true,);
    const sentBody = JSON.parse(mock.calls[0].opts.body,);
    assert.equal(sentBody.type, 'text',);
    assert.equal(sentBody.text.body, 'Quick reply within 24h window',);
  } finally {
    globalThis.fetch = origFetch;
  }
},);

test('Meta WhatsApp provider: returns error when API call fails', async () => {
  const provider = createMetaWhatsAppProvider({
    accessToken: 'test_token',
    phoneNumberId: 'test_phone_id',
  },);

  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { error: { message: 'Invalid token', code: 190, }, },
    false,
    401,
  );

  try {
    const result = await provider.send({
      to: '+15551234567',
      body: 'test',
      meta: { use_text: true, },
    },);

    assert.equal(result.delivered, false,);
    assert.equal(result.error, 'Invalid token',);
    assert.equal(result.error_code, 190,);
  } finally {
    globalThis.fetch = origFetch;
  }
},);

test('Meta WhatsApp provider: resolves phone from customer profile', async () => {
  const platform = createPlatform();

  // Create a customer profile with a phone number.
  await platform.store.customers.insert({
    store_id: STORE,
    identity: 'customer_alice',
    email: 'alice@test.com',
    phone: '+15559876543',
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    sessions: 0,
    product_views: 0,
    cart_updates: 0,
    abandoned_carts: 0,
    checkouts_started: 0,
    purchases: 0,
    total_spent: 0,
    refunded: 0,
    viewed_products: [],
    channels_responded: [],
    last_purchase_at: null,
  },);

  const provider = createMetaWhatsAppProvider({
    accessToken: 'test_token',
    phoneNumberId: 'test_phone_id',
    store: platform.store,
  },);

  const origFetch = globalThis.fetch;
  const mock = mockFetch({ messages: [{ id: 'wamid.resolved001', },], },);
  globalThis.fetch = mock;

  try {
    // Send to customer identity — should resolve to phone from profile.
    const result = await provider.send({
      to: 'customer_alice',
      body: 'Your cart is waiting!',
      meta: { action_type: 'recovery_message', params: { name: 'Alice', }, },
    },);

    assert.equal(result.delivered, true,);
    assert.equal(result.to, '+15559876543',);

    const sentBody = JSON.parse(mock.calls[0].opts.body,);
    assert.equal(sentBody.to, '+15559876543',);
  } finally {
    globalThis.fetch = origFetch;
  }
},);

test('Meta WhatsApp provider: returns no_phone_number when customer has no phone', async () => {
  const platform = createPlatform();

  // Customer without phone.
  await platform.store.customers.insert({
    store_id: STORE,
    identity: 'customer_no_phone',
    email: 'nophone@test.com',
    phone: null,
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    sessions: 0,
    product_views: 0,
    cart_updates: 0,
    abandoned_carts: 0,
    checkouts_started: 0,
    purchases: 0,
    total_spent: 0,
    refunded: 0,
    viewed_products: [],
    channels_responded: [],
    last_purchase_at: null,
  },);

  const provider = createMetaWhatsAppProvider({
    accessToken: 'test_token',
    phoneNumberId: 'test_phone_id',
    store: platform.store,
  },);

  const result = await provider.send({
    to: 'customer_no_phone',
    body: 'test',
    meta: { use_text: true, },
  },);

  assert.equal(result.delivered, false,);
  assert.equal(result.error, 'no_phone_number',);
},);

test('Meta WhatsApp provider: throws on missing credentials', () => {
  assert.throws(
    () => createMetaWhatsAppProvider({ accessToken: '', phoneNumberId: 'x', },),
    /WHATSAPP_ACCESS_TOKEN/,
  );
  assert.throws(
    () => createMetaWhatsAppProvider({ accessToken: 'x', phoneNumberId: '', },),
    /WHATSAPP_PHONE_NUMBER_ID/,
  );
},);

// ── Provider registry integration ────────────────────────────────────

test('provider registry: meta mode falls back to console when credentials missing', () => {
  const config = {
    providers: { email: 'console', whatsapp: 'meta', push: 'console', },
  };

  // No WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID set.
  const registry = createProviderRegistry(config,);
  const wa = registry.get('whatsapp',);
  assert.ok(wa,);
  assert.equal(wa.provider, 'console:whatsapp',);
},);

test('provider registry: meta mode uses real provider when credentials present', () => {
  process.env.WHATSAPP_ACCESS_TOKEN = 'test_tok';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'test_pid';

  try {
    const config = {
      providers: { email: 'console', whatsapp: 'meta', push: 'console', },
    };
    const registry = createProviderRegistry(config,);
    const wa = registry.get('whatsapp',);
    assert.ok(wa,);
    assert.equal(wa.provider, 'meta:whatsapp',);
  } finally {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  }
},);

// ── WhatsApp webhook endpoint (HTTP integration) ─────────────────────

function bootServer() {
  const platform = createPlatform();
  const app = createApp(platform,);
  return new Promise((resolve,) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port, } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        platform,
        close: () => new Promise((done,) => server.close(done,),),
      },);
    },);
  },);
}

test('WhatsApp webhook: GET challenge verification succeeds with correct token', async () => {
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'my_verify_token';
  const { base, close, } = await bootServer();

  try {
    const res = await fetch(
      `${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=my_verify_token&hub.challenge=CHALLENGE_STRING`,
    );
    assert.equal(res.status, 200,);
    const text = await res.text();
    assert.equal(text, 'CHALLENGE_STRING',);
  } finally {
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    await close();
  }
},);

test('WhatsApp webhook: GET challenge verification fails with wrong token', async () => {
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'correct_token';
  const { base, close, } = await bootServer();

  try {
    const res = await fetch(
      `${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=CHALLENGE`,
    );
    assert.equal(res.status, 403,);
  } finally {
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    await close();
  }
},);

test('WhatsApp webhook: POST processes delivery status and records engagement', async () => {
  const { base, platform, close, } = await bootServer();

  // Seed a customer with a phone number.
  await platform.store.customers.insert({
    store_id: STORE,
    identity: 'wa_shopper',
    email: 'washopper@test.com',
    phone: '+15551112222',
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    sessions: 0,
    product_views: 0,
    cart_updates: 0,
    abandoned_carts: 0,
    checkouts_started: 0,
    purchases: 0,
    total_spent: 0,
    refunded: 0,
    viewed_products: [],
    channels_responded: [],
    last_purchase_at: null,
  },);

  const webhookBody = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { display_phone_number: '+15559876543', },
              statuses: [
                {
                  id: 'wamid.webhook001',
                  recipient_id: '+15551112222',
                  status: 'delivered',
                  timestamp: String(Math.floor(Date.now() / 1000,),),
                  errors: [],
                },
              ],
            },
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(`${base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', },
      body: JSON.stringify(webhookBody,),
    },);
    assert.equal(res.status, 200,);
    const data = await res.json();
    assert.equal(data.ok, true,);

    // Verify engagement event was recorded.
    const events = await platform.store.events.find({
      customer_id: 'wa_shopper',
      event_type: 'whatsapp_read',
    },);
    assert.ok(events.length >= 1, 'Should have recorded whatsapp_read event',);
  } finally {
    await close();
  }
},);

test('WhatsApp webhook: POST processes customer reply and records whatsapp_replied', async () => {
  const { base, platform, close, } = await bootServer();

  // Seed customer with phone.
  await platform.store.customers.insert({
    store_id: STORE,
    identity: 'wa_replier',
    email: 'replier@test.com',
    phone: '+15553334444',
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    sessions: 0,
    product_views: 0,
    cart_updates: 0,
    abandoned_carts: 0,
    checkouts_started: 0,
    purchases: 0,
    total_spent: 0,
    refunded: 0,
    viewed_products: [],
    channels_responded: [],
    last_purchase_at: null,
  },);

  const webhookBody = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messages: [
                {
                  id: 'wamid.reply001',
                  from: '+15553334444',
                  type: 'text',
                  text: { body: 'Yes, I want to complete my order', },
                  timestamp: String(Math.floor(Date.now() / 1000,),),
                },
              ],
            },
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(`${base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', },
      body: JSON.stringify(webhookBody,),
    },);
    assert.equal(res.status, 200,);

    // Verify reply event was recorded.
    const events = await platform.store.events.find({
      customer_id: 'wa_replier',
      event_type: 'whatsapp_replied',
    },);
    assert.ok(events.length >= 1, 'Should have recorded whatsapp_replied event',);
  } finally {
    await close();
  }
},);

test('WhatsApp webhook: POST with signature verification rejects tampered payloads', async () => {
  process.env.WHATSAPP_APP_SECRET = 'my_secret';
  const { base, close, } = await bootServer();

  const body = JSON.stringify({ entry: [], },);
  const badSig = 'sha256=' + 'b'.repeat(64,);

  try {
    const res = await fetch(`${base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': badSig,
      },
      body,
    },);
    assert.equal(res.status, 401,);
  } finally {
    delete process.env.WHATSAPP_APP_SECRET;
    await close();
  }
},);

// ── End-to-end: cart recovery via WhatsApp (full pipeline) ───────────

test('E2E: cart recovery via WhatsApp — full pipeline with mock Meta API', async () => {
  // Set env vars for the Meta provider credentials.
  process.env.WHATSAPP_ACCESS_TOKEN = 'test_e2e_token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'test_e2e_phone_id';

  // Pass config override — the config module is cached so env vars
  // set after require() have no effect on it.
  const platform = createPlatform({
    config: {
      env: 'test',
      apiKey: 'dev-key',
      storage: 'memory',
      providers: { email: 'console', whatsapp: 'meta', push: 'console', },
      intelligence: { churnInactiveDays: 30, forecastWindow: 7, },
      retention: { events: 365, deliveries: 180, consentRecords: 730, monitoringEvents: 90, sessions: 30, },
      security: { webhookSecret: '', rateLimitWindowMs: 60000, rateLimitMax: 300, maxRetries: 3, retryBaseDelayMs: 1000, },
      subscriptionCostMonthly: 49,
      redis: { url: '', host: '127.0.0.1', port: 6379, password: '', tls: false, keyPrefix: 'storecops:', },
    },
  },);

  // Subscribe the store to the "growth" plan (includes whatsapp_recovery).
  await platform.store.subscriptions.insert({
    shopInstallationId: STORE,
    planId: 'growth',
    status: 'active',
    shopifyChargeId: null,
    activated_at: new Date().toISOString(),
  },);

  // Seed a customer with phone number.
  await platform.store.customers.insert({
    store_id: STORE,
    identity: 'wa_e2e_shopper',
    email: 'e2e@test.com',
    phone: '+15557778888',
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    sessions: 1,
    product_views: 2,
    cart_updates: 1,
    abandoned_carts: 1,
    checkouts_started: 0,
    purchases: 0,
    total_spent: 0,
    refunded: 0,
    viewed_products: ['p1', 'p2',],
    channels_responded: [],
    last_purchase_at: null,
  },);

  // Give consent for recovery.
  await platform.consentService.setConsent(STORE, 'wa_e2e_shopper', {
    analytics: true,
    recovery: true,
    marketing: false,
  },);

  // Track a cart abandonment event.
  const tracked = await platform.trackAndReact({
    event_type: 'cart_abandoned',
    store_id: STORE,
    customer_id: 'wa_e2e_shopper',
    product_id: 'p1',
  },);
  assert.equal(tracked.accepted, true,);
  assert.equal(tracked.decision.actions.length, 1,);
  assert.equal(tracked.decision.actions[0].rule_id, 'cart_recovery',);

  // Mock the Meta API and force WhatsApp delivery.
  const origFetch = globalThis.fetch;
  const mock = mockFetch({ messages: [{ id: 'wamid.e2e001', },], },);
  globalThis.fetch = mock;

  try {
    // Force the action to use WhatsApp channel.
    const action = tracked.decision.actions[0];
    await platform.store.actions.update(action._id, { channel: 'whatsapp', },);

    const execution = await platform.executionService.processStore(STORE,);
    assert.equal(execution.processed, 1,);
    assert.equal(execution.failed, 0,);

    // Verify Meta API was called.
    assert.ok(mock.calls.length >= 1, 'Should have called Meta API',);
    const call = mock.calls[0];
    assert.ok(call.url.includes('/messages',),);
    const sentBody = JSON.parse(call.opts.body,);
    assert.equal(sentBody.to, '+15557778888',);
    assert.equal(sentBody.type, 'template',);
    assert.equal(sentBody.template.name, 'cart_recovery',);

    // Verify delivery was recorded.
    const deliveries = await platform.store.deliveries.find({
      store_id: STORE,
      customer_id: 'wa_e2e_shopper',
    },);
    assert.ok(deliveries.length >= 1,);
    assert.equal(deliveries[0].channel, 'whatsapp',);
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  }
},);

// ── Phone number persistence in customer profile ─────────────────────

test('customer profile: stores and updates phone number from events', async () => {
  const platform = createPlatform();

  // Track event with phone.
  await platform.eventTracker.track({
    event_type: 'product_view',
    store_id: STORE,
    customer_id: 'phone_customer',
    phone: '+15556667777',
    product_id: 'p1',
  },);

  const profile = await platform.store.customers.findOne({
    store_id: STORE,
    identity: 'phone_customer',
  },);
  assert.ok(profile, 'Profile should exist',);
  assert.equal(profile.phone, '+15556667777',);

  // Subsequent event without phone should preserve it.
  await platform.eventTracker.track({
    event_type: 'cart_updated',
    store_id: STORE,
    customer_id: 'phone_customer',
  },);

  const updated = await platform.store.customers.findOne({
    store_id: STORE,
    identity: 'phone_customer',
  },);
  assert.equal(updated.phone, '+15556667777',);
},);
