"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");
const { createPlatform } = require("../src/platform");
const { createApp, apiKeyMiddleware } = require("../src/server/createApp");

const STORE = "store_api";

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

test("API: health is public and API key guards /api/v1", async () => {
  const { base, close } = await bootServer();

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    // env=test skips auth — verify the middleware directly instead.
    const platform = createPlatform({ config: { env: "production", apiKey: "secret", defaultStoreId: STORE, providers: { email: "console", whatsapp: "console" }, intelligence: { churnInactiveDays: 30, forecastWindow: 7 } } });
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

    guard({ get: () => undefined }, fakeRes, () => {});
    assert.equal(fakeRes.statusCode, 401);

    const nextCalled = { called: false };
    guard({ get: () => "secret" }, fakeRes, () => {
      nextCalled.called = true;
    });
    assert.equal(nextCalled.called, true);
  } finally {
    await close();
  }
});

test("API: full flow over HTTP — track, scan, execute, report", async () => {
  const { base, close } = await bootServer();

  try {
    const post = (path, body) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const get = (path) => fetch(`${base}${path}`);

    // Ingest behaviour.
    const view = await post("/api/v1/track", {
      event_type: "product_view",
      store_id: STORE,
      customer_id: "ana",
      product_id: "p1",
    });
    assert.equal(view.status, 200);

    const abandon = await post("/api/v1/track", {
      event_type: "cart_abandoned",
      store_id: STORE,
      customer_id: "ana",
    });
    const abandonBody = await abandon.json();
    assert.equal(abandonBody.high_priority, true);
    assert.equal(abandonBody.decision.actions.length, 1);

    // Invalid payloads are rejected with a 400.
    const bad = await post("/api/v1/track", { event_type: "nope" });
    assert.equal(bad.status, 400);

    // Execute the queued recovery action.
    const exec = await post(`/api/v1/execute/${STORE}`, {});
    const execBody = await exec.json();
    assert.equal(execBody.delivered, 1);

    // Intelligence endpoints respond.
    const churn = await get(`/api/v1/churn/${STORE}`);
    assert.equal(churn.status, 200);
    assert.ok(Array.isArray(await churn.json()));

    const rec = await get(`/api/v1/recommendations/${STORE}/ana`);
    assert.equal(rec.status, 200);

    // Growth cycle returns the full loop result.
    const cycle = await post(`/api/v1/growth-cycle/${STORE}`, {});
    assert.equal(cycle.status, 200);
    const cycleBody = await cycle.json();
    assert.ok(cycleBody.report);
    assert.ok(cycleBody.attribution);

    // Dashboard.
    const report = await get(`/api/v1/report/${STORE}`);
    const reportBody = await report.json();
    assert.equal(reportBody.funnel.abandoned, 1);
    assert.ok(reportBody.overview.actions_delivered >= 1);

    // Bot chat.
    const chat = await post("/api/v1/bot/chat", {
      store_id: STORE,
      customer_id: "ana",
      message: "Can you recommend something?",
    });
    const chatBody = await chat.json();
    assert.equal(chatBody.intent, "recommendation");
  } finally {
    await close();
  }
});
