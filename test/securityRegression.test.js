"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { createPlatform } = require("../src/platform");
const { createApp, apiKeyMiddleware } = require("../src/server/createApp");
const { signBody } = require("../src/server/security");

const STORE_A = "store_alpha";
const STORE_B = "store_beta";

/** Boot the app on an ephemeral port and return base URL + closer. */
function bootServer(configOverrides) {
  const platform = createPlatform(configOverrides);
  const app = createApp(platform);

  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        platform,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("security regression: tenant isolation — store A cannot read store B data", async () => {
  const platform = createPlatform();

  // Seed events for two different stores.
  await platform.eventTracker.track({
    event_type: "product_view",
    store_id: STORE_A,
    customer_id: "alice",
    product_id: "p1",
  });
  await platform.eventTracker.track({
    event_type: "product_view",
    store_id: STORE_B,
    customer_id: "bob",
    product_id: "p2",
  });

  // Each store's events should be isolated.
  const eventsA = await platform.store.events.find({ store_id: STORE_A });
  const eventsB = await platform.store.events.find({ store_id: STORE_B });

  assert.ok(eventsA.every((e) => e.store_id === STORE_A));
  assert.ok(eventsB.every((e) => e.store_id === STORE_B));
  assert.ok(!eventsA.some((e) => e.customer_id === "bob"));
  assert.ok(!eventsB.some((e) => e.customer_id === "alice"));
});

test("security regression: API key guard rejects missing and wrong keys", async () => {
  const platform = createPlatform({
    config: {
      env: "production",
      apiKey: "real-secret-key",
      defaultStoreId: STORE_A,
      providers: { email: "console", whatsapp: "console" },
      intelligence: { churnInactiveDays: 30, forecastWindow: 7 },
    },
  });
  const guard = apiKeyMiddleware(platform);

  const fakeRes = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
    },
  };

  // No key → 401.
  guard({ get: () => undefined }, fakeRes, () => {});
  assert.equal(fakeRes.statusCode, 401);

  // Wrong key → 401.
  guard({ get: () => "wrong-key" }, fakeRes, () => {});
  assert.equal(fakeRes.statusCode, 401);

  // Correct key → passes.
  let passed = false;
  guard({ get: () => "real-secret-key" }, fakeRes, () => {
    passed = true;
  });
  assert.equal(passed, true);
});

test("security regression: HMAC webhook verification rejects tampered payloads", async () => {
  const secret = "test-webhook-secret";
  const { base, close } = await bootServer({
    config: {
      env: "test",
      apiKey: "dev-key",
      defaultStoreId: STORE_A,
      providers: { email: "console", whatsapp: "console" },
      intelligence: { churnInactiveDays: 30, forecastWindow: 7 },
      security: { webhookSecret: secret },
    },
  });

  try {
    const payload = JSON.stringify({ myshopify_domain: "test.myshopify.com" });
    const validSig = signBody(secret, payload);

    // Valid signature → 200.
    const valid = await fetch(`${base}/webhooks/shopify/app-uninstalled`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-storecops-signature": validSig,
      },
      body: payload,
    });
    assert.equal(valid.status, 200);

    // Tampered body with original signature → 401.
    const tampered = JSON.stringify({ myshopify_domain: "evil.myshopify.com" });
    const invalid = await fetch(`${base}/webhooks/shopify/app-uninstalled`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-storecops-signature": validSig, // sig for original, not tampered
      },
      body: tampered,
    });
    assert.equal(invalid.status, 401);

    // Missing signature → 401.
    const noSig = await fetch(`${base}/webhooks/shopify/app-uninstalled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(noSig.status, 401);
  } finally {
    await close();
  }
});

test("security regression: PII masking — email logs never contain raw addresses", async () => {
  // Verify the maskEmail function from providers.js masks correctly.
  const { createConsoleProvider } = require("../src/layers/execution/providers");
  const provider = createConsoleProvider("test");

  // Capture console output.
  const originalLog = console.log;
  let captured = "";
  console.log = (msg) => {
    captured += msg;
  };

  try {
    await provider.send({
      to: "john.doe@example.com",
      subject: "Test subject",
      body: "Test body content",
    });

    // The log should NOT contain the raw email.
    assert.ok(!captured.includes("john.doe@example.com"), "raw email must not appear in logs");
    // The log SHOULD contain a masked version.
    assert.ok(captured.includes("j***@e***"), "masked email should appear in logs");
  } finally {
    console.log = originalLog;
  }
});

test("security regression: rate limiter blocks excessive requests", async () => {
  const { createRateLimiter } = require("../src/server/security");
  const limiter = createRateLimiter({ windowMs: 60000, max: 5 });

  let blocked = false;
  for (let i = 0; i < 10; i++) {
    const fakeReq = { get: () => "test-key", ip: "1.2.3.4" };
    const fakeRes = {
      statusCode: null,
      body: null,
      headers: {},
      set(k, v) {
        this.headers[k] = v;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
      },
    };

    let passed = false;
    limiter(fakeReq, fakeRes, () => {
      passed = true;
    });

    if (!passed) {
      blocked = true;
      assert.equal(fakeRes.statusCode, 429);
      break;
    }
  }

  assert.ok(blocked, "rate limiter must block after max requests");
});

test("security regression: secrets never appear in signup response", async () => {
  const { auth } = createPlatform();

  const result = await auth.signup({
    email: "secret@test.com",
    password: "securepass1",
    name: "Secret Tester",
    storeName: "Secret Store",
  });

  // The response must never contain password_hash or salt.
  assert.ok(!result.user.password_hash, "password_hash must not leak");
  assert.ok(!result.user.salt, "salt must not leak");

  // API key should be present (needed for the tenant).
  assert.ok(result.api_key.startsWith("sk_"), "api_key should be issued");
});
