"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");
const { createPlatform } = require("../src/platform");

const STORE = "store_test";
const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

test("Layer 1: invalid events are rejected", async () => {
  const platform = createPlatform();

  const missing = await platform.eventTracker.track({ event_type: "page_view" });
  assert.equal(missing.accepted, false);

  const unknown = await platform.eventTracker.track({
    event_type: "explode",
    store_id: STORE,
    customer_id: "c1",
  });
  assert.equal(unknown.accepted, false);
});

test("Layer 1: events build a unified profile across identifiers", async () => {
  const platform = createPlatform();

  await platform.eventTracker.track({
    event_type: "product_view",
    store_id: STORE,
    session_id: "s1",
    product_id: "p1",
  });
  // Same person now identified by email on the same session — the
  // anonymous session profile must merge and upgrade.
  await platform.eventTracker.track({
    event_type: "purchase",
    store_id: STORE,
    email: "ana@example.com",
    session_id: "s1",
    total: 120,
  });

  const profiles = (await platform.customerProfiles.list(STORE)).filter(
    (p) => !p.merged_into
  );
  assert.equal(profiles.length, 1, "identities merge into one profile");
  assert.equal(profiles[0].identity, "ana@example.com");
  assert.equal(profiles[0].total_spent, 120);
  assert.deepEqual(profiles[0].viewed_products, ["p1"]);
});

test("Layer 2: churn scoring flags inactive abandoners and protects loyal buyers", async () => {
  const platform = createPlatform();

  // Risky customer: abandoned cart, gone for a long time.
  await platform.eventTracker.track({
    event_type: "cart_abandoned",
    store_id: STORE,
    customer_id: "risky",
    timestamp: hoursAgo(24 * 45),
  });
  // Loyal customer with recent activity.
  await platform.eventTracker.track({
    event_type: "purchase",
    store_id: STORE,
    customer_id: "loyal",
    total: 50,
  });
  for (let i = 0; i < 2; i++) {
    await platform.eventTracker.track({
      event_type: "purchase",
      store_id: STORE,
      customer_id: "loyal",
      total: 30,
    });
  }

  const risky = await platform.churnScoring.scoreCustomer(STORE, "risky");
  const loyal = await platform.churnScoring.scoreCustomer(STORE, "loyal");

  assert.ok(risky.churn_score > loyal.churn_score);
  assert.ok(["HIGH", "CRITICAL"].includes(risky.risk_band));
});

test("Layer 2: recommendations use co-views then fall back to popularity", async () => {
  const platform = createPlatform();

  // Shopper "a" only views p1; "b" co-views p1 + p2, giving the matrix
  // a p1 → p2 edge that "a" has not seen yet.
  await platform.eventTracker.track({
    event_type: "product_view",
    store_id: STORE,
    customer_id: "a",
    product_id: "p1",
  });
  for (const product of ["p1", "p2"]) {
    await platform.eventTracker.track({
      event_type: "product_view",
      store_id: STORE,
      customer_id: "b",
      product_id: product,
    });
  }
  // Third shopper only views p3 (popularity filler).
  await platform.eventTracker.track({
    event_type: "product_view",
    store_id: STORE,
    customer_id: "c",
    product_id: "p3",
  });

  const result = await platform.recommendationEngine.recommend(STORE, "a", 5);
  assert.equal(result.strategy, "collaborative");
  assert.ok(result.recommendations.some((r) => r.product_id === "p2"));
});

test("Layer 2: competitor intel detects price drops and promotions", async () => {
  const platform = createPlatform();

  await platform.competitorIngestor.ingestSnapshot({
    store_id: STORE,
    competitor: "rival",
    products: [{ id: "x1", name: "Widget", price: 100, in_stock: true }],
  });
  await platform.competitorIngestor.ingestSnapshot({
    store_id: STORE,
    competitor: "rival",
    products: [{ id: "x1", name: "Widget", price: 80, in_stock: false }],
  });

  const analysis = await platform.competitorIntelligence.analyzeStore(STORE);
  const rival = analysis.competitors.find((c) => c.competitor === "rival");

  assert.equal(rival.status, "ANALYZED");
  assert.equal(rival.changes.price_drops.length, 1);
  assert.equal(rival.changes.possible_promotions.length, 1);
  assert.equal(rival.changes.stockouts.length, 1);
  assert.ok(analysis.high_priority_alerts.length > 0);
});

test("Layer 2: sentiment analysis scores positive and negative mentions", async () => {
  const platform = createPlatform();

  await platform.sentimentCollector.collect({ store_id: STORE, source: "review", text: "Amazing quality, love it!" });
  await platform.sentimentCollector.collect({ store_id: STORE, source: "review", text: "Terrible product, want a refund." });
  await platform.sentimentCollector.collect({ store_id: STORE, source: "review", text: "Absolutely awful, never again.", rating: 1 });

  const result = await platform.brandSentiment.analyze(STORE);
  assert.equal(result.sample_count, 3);
  assert.ok(result.health_score < 0, "negatives outweigh the single positive");
  assert.ok(result.top_themes.length > 0);
});

test("Layer 2: demand forecast produces future projections", async () => {
  const platform = createPlatform();

  for (let day = 10; day >= 1; day--) {
    await platform.eventTracker.track({
      event_type: "purchase",
      store_id: STORE,
      customer_id: `buyer${day}`,
      items: [{ product_id: "p1", quantity: 11 - day }],
      timestamp: hoursAgo(day * 24),
    });
  }

  const forecast = await platform.demandForecastEngine.forecast({
    store_id: STORE,
    product_id: "p1",
    horizonDays: 7,
  });

  assert.equal(forecast.projections.length, 7);
  assert.ok(forecast.slope > 0, "increasing series yields positive slope");
  assert.ok(forecast.total_forecast > 0);
});

test("Layer 2: SEO audit passes a well-formed page and fails a bare one", () => {
  const platform = createPlatform();

  const good = platform.seoAuditEngine.auditHtml(
    `<html><head><title>Buy running shoes online at the best prices today</title>
     <meta name="description" content="Shop our full range of running shoes with free shipping and easy returns on every order you place." />
     <meta name="viewport" content="width=device-width" />
     <link rel="canonical" href="https://example.com/shoes" /></head>
     <body><h1>Running shoes</h1></body></html>`,
    "https://example.com/shoes"
  );
  assert.ok(good.score >= 80);

  const bad = platform.seoAuditEngine.auditHtml("<html><body>hi</body></html>", "http://example.com");
  assert.ok(bad.score <= 20);
});

test("Layer 2: inventory intelligence flags stockout risk", async () => {
  const platform = createPlatform();

  // Sell 30 units over the window.
  for (let i = 0; i < 10; i++) {
    await platform.eventTracker.track({
      event_type: "purchase",
      store_id: STORE,
      customer_id: `b${i}`,
      items: [{ product_id: "hot", quantity: 3 }],
    });
  }

  const report = await platform.inventoryIntelligence.analyze(STORE, [
    { product_id: "hot", stock: 5, lead_time_days: 7 },
    { product_id: "cold", stock: 100, lead_time_days: 7 },
  ]);

  const hot = report.products.find((p) => p.product_id === "hot");
  const cold = report.products.find((p) => p.product_id === "cold");

  assert.equal(hot.status, "STOCKOUT_RISK");
  assert.ok(hot.suggested_reorder_qty > 0);
  assert.equal(cold.status, "NO_DEMAND");
});
