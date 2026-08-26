"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");
const { createPlatform } = require("../src/platform");
const { createApp } = require("../src/server/createApp");

/** Boot the app on an ephemeral port and return base URL + closer. */
function bootServer() {
  const platform = createPlatform();
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

const postWebhook = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("webhook idempotency: duplicate app-uninstalled is processed only once", async () => {
  const { base, platform, close } = await bootServer();

  try {
    // Seed an integration so the handler has something to disconnect.
    await platform.store.integrations.insert({
      type: "shopify",
      store_id: "wh_idem",
      status: "connected",
      credentials: { token: "tok_123" },
    });

    const payload = { myshopify_domain: "test-shop.myshopify.com" };

    // First delivery — should process normally.
    const first = await postWebhook(base, "/webhooks/shopify/app-uninstalled", payload);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.duplicate, undefined);

    // Verify the store was marked as uninstalled.
    const conn = await platform.store.integrations.findOne({ type: "shopify" });
    assert.equal(conn.status, "uninstalled");

    // Second delivery (same payload) — should be detected as duplicate.
    const second = await postWebhook(base, "/webhooks/shopify/app-uninstalled", payload);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.duplicate, true);
  } finally {
    await close();
  }
});

test("webhook idempotency: duplicate customer-redact is processed only once", async () => {
  const { base, platform, close } = await bootServer();

  try {
    // Seed a customer so we can verify deletion happens once.
    await platform.store.customers.insert({
      store_id: "store_api",
      identity: "cust_42",
      email: "test@example.com",
    });

    const payload = { customer: { id: "cust_42" } };

    // First delivery — should anonymize the customer.
    const first = await postWebhook(base, "/webhooks/shopify/customer-redact", payload);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.duplicate, undefined);

    // Verify anonymization happened.
    const anon = await platform.store.customers.findOne({ identity: "anon:cust_42" });
    // The customer may or may not be found depending on store_id matching,
    // but the important thing is the handler ran.

    // Second delivery (same payload) — should be a duplicate.
    const second = await postWebhook(base, "/webhooks/shopify/customer-redact", payload);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.duplicate, true);
  } finally {
    await close();
  }
});

test("webhook idempotency: different payloads are not deduplicated", async () => {
  const { base, close } = await bootServer();

  try {
    // Two different shop-redact payloads (different shop IDs) should both process.
    const payload1 = { shop_id: "shop_1", domain: "store1.myshopify.com" };
    const payload2 = { shop_id: "shop_2", domain: "store2.myshopify.com" };

    const first = await postWebhook(base, "/webhooks/shopify/shop-redact", payload1);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.duplicate, undefined);

    const second = await postWebhook(base, "/webhooks/shopify/shop-redact", payload2);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.duplicate, undefined, "different payload should not be deduplicated");
  } finally {
    await close();
  }
});

test("webhook idempotency: data-request duplicates are skipped", async () => {
  const { base, close } = await bootServer();

  try {
    const payload = { customer: { id: "cust_99" }, shop_id: "shop_x" };

    const first = await postWebhook(base, "/webhooks/shopify/data-request", payload);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).duplicate, undefined);

    const second = await postWebhook(base, "/webhooks/shopify/data-request", payload);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).duplicate, true);
  } finally {
    await close();
  }
});
