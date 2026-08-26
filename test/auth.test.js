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

test("Auth service: signup provisions tenant, login verifies, secrets never leak", async () => {
  const { auth } = createPlatform();

  const created = await auth.signup({
    email: "Owner@Shop.com",
    password: "supersecret1",
    name: "Owner",
    storeName: "My Shop",
  });

  assert.equal(created.store_id, "my_shop");
  assert.ok(created.api_key.startsWith("sk_"), "tenant gets a private API key");
  assert.ok(created.token, "signup auto-logs-in");
  assert.ok(!created.user.password_hash, "hash stripped from payload");
  assert.ok(!created.user.salt, "salt stripped from payload");
  assert.equal(created.user.email, "owner@shop.com");

  await assert.rejects(
    () => auth.signup({ email: "owner@shop.com", password: "supersecret1" }),
    /already exists/
  );
  await assert.rejects(
    () => auth.signup({ email: "new@shop.com", password: "short" }),
    /at least 8/
  );
  await assert.rejects(
    () => auth.signup({ email: "not-an-email", password: "longenough1" }),
    /valid email/i
  );

  // Login round-trip.
  const session = await auth.login({ email: "owner@shop.com", password: "supersecret1" });
  assert.equal(session.store_id, "my_shop");
  const verified = await auth.verify(session.token);
  assert.equal(verified.user.email, "owner@shop.com");
  assert.equal(verified.store_id, "my_shop");

  // Wrong password + unknown user both rejected uniformly.
  await assert.rejects(
    () => auth.login({ email: "owner@shop.com", password: "wrongpass99" }),
    /Invalid email or password/
  );
  await assert.rejects(
    () => auth.login({ email: "ghost@shop.com", password: "whatever123" }),
    /Invalid email or password/
  );

  // Logout revokes the session.
  await auth.logout(session.token);
  assert.equal(await auth.verify(session.token), null);

  // API-key resolution for the gateway.
  const tenant = await auth.userByApiKey(created.api_key);
  assert.equal(tenant.email, "owner@shop.com");
  assert.ok(!tenant.password_hash);
  assert.equal(await auth.userByApiKey("sk_bogus"), null);
});

test("Auth HTTP: signup/login/logout endpoints behave", async () => {
  const { base, close } = await bootServer();

  try {
    // Signup → 201 with token + api_key.
    const created = await fetch(`${base}/api/v1/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "http@test.com", password: "password123", storeName: "HTTP Store" }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.store_id, "http_store");
    assert.ok(body.token && body.api_key);

    // Duplicate signup → 400.
    const dup = await fetch(`${base}/api/v1/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "http@test.com", password: "password123" }),
    });
    assert.equal(dup.status, 400);

    // Login with wrong password → 401.
    const bad = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "http@test.com", password: "nope-nope" }),
    });
    assert.equal(bad.status, 401);

    // /me with the bearer token → user info.
    const me = await fetch(`${base}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, "http@test.com");

    // Logout revokes: /me then fails.
    await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${body.token}` },
    });
    const after = await fetch(`${base}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    assert.equal(after.status, 401);
  } finally {
    await close();
  }
});
