"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { createSqliteStore } = require("../src/storage/sqliteStore");
const { createPlatform } = require("../src/platform");

function tempDb(name) {
  return path.join(os.tmpdir(), `storecops-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(file) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(file + suffix);
    } catch {
      /* already gone */
    }
  }
}

test("SQLite store: full CRUD roundtrip with both filter styles", async () => {
  const file = tempDb("crud");
  try {
    const store = createSqliteStore(file);

    const ev = await store.events.insert({ store_id: "s1", event_type: "purchase", total: 42 });
    assert.ok(ev._id, "insert assigns _id");
    assert.ok(ev.createdAt, "insert assigns createdAt");
    await store.events.insert({ store_id: "s2", event_type: "product_view" });

    // Plain-object filter: exact field equality.
    const s1 = await store.events.find({ store_id: "s1" });
    assert.equal(s1.length, 1);

    // Function filter, as used by GDPR + reporting code paths.
    const purchases = await store.events.find((e) => e.event_type === "purchase");
    assert.equal(purchases.length, 1);

    // Update merges the patch and bumps updatedAt.
    const updated = await store.events.update(ev._id, { total: 99 });
    assert.equal(updated.total, 99);
    assert.ok(updated.updatedAt);
    assert.equal((await store.events.findById(ev._id)).total, 99);

    assert.equal(await store.events.count(), 2);
    assert.equal(await store.events.update("missing-id", { total: 1 }), null);

    await store.events.clear();
    assert.equal(await store.events.count(), 0);
    store.close();
  } finally {
    cleanup(file);
  }
});

test("SQLite store: data survives close + reopen", async () => {
  const file = tempDb("reopen");
  try {
    let store = createSqliteStore(file);
    const doc = await store.customers.insert({ store_id: "s1", identity: "alice", total_spent: 120 });
    store.close();

    store = createSqliteStore(file);
    const found = await store.customers.findById(doc._id);
    assert.equal(found.identity, "alice");
    assert.equal(found.total_spent, 120);
    store.close();
  } finally {
    cleanup(file);
  }
});

test("Platform: tracked data survives a full server restart on SQLite", async () => {
  const file = tempDb("platform");
  const baseConfig = require("../src/config/config");
  const cfg = { ...baseConfig, storage: "sqlite", sqlitePath: file };

  try {
    // First "boot": ingest an order.
    let platform = createPlatform({ config: cfg });
    const tracked = await platform.eventTracker.track({
      store_id: "persist_shop",
      event_type: "purchase",
      customer_id: "c1",
      email: "c1@persist.shop",
      total: 50,
      items: [{ product_id: "p1", quantity: 1, price: 50 }],
    });
    assert.equal(tracked.accepted, true);
    platform.store.close();

    // Second "boot": the order is still there.
    platform = createPlatform({ config: cfg });
    const events = await platform.store.events.find({ store_id: "persist_shop" });
    assert.equal(events.length, 1);
    assert.equal(events[0].total, 50);
    platform.store.close();
  } finally {
    cleanup(file);
  }
});
