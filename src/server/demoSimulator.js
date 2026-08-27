"use strict";

/**
 * Demo Simulator — makes the platform feel alive.
 *
 * Generates realistic e-commerce events on a timer so the dashboard,
 * live orders, inventory, competitor radar, and automations have fresh
 * data to work with until real store credentials are connected.
 *
 * Runs automatically in demo mode (no real credentials). Produces:
 *   - Customer browsing → cart → purchase → churn cycles
 *   - Competitor price changes and stockouts
 *   - Trend signal fluctuations
 *   - Brand sentiment reviews
 *   - Stock level changes (decrement on sales, restock alerts)
 *
 * Every event flows through the real platform pipeline — eventTracker,
 * inventoryLedger, customerProfiles, orchestrator, live SSE broadcast.
 * No shortcuts, no separate data path.
 */

const DEMO_NAMES = [
  "aisha", "ben", "carla", "derek", "elena", "farid", "grace", "hassan",
  "iris", "james", "kira", "leo", "maya", "nate", "olivia", "pablo",
  "quinn", "rachel", "sam", "tina", "uma", "vincent", "wendy", "xavier",
  "yara", "zane", "aria", "bruce", "cleo", "dustin", "eva", "finn",
];

const PRODUCTS = [
  { id: "smart-ring", price: 199, weight: 0.18 },
  { id: "wireless-earbuds", price: 89, weight: 0.30 },
  { id: "phone-case", price: 24, weight: 0.22 },
  { id: "usb-cable", price: 12, weight: 0.15 },
  { id: "power-bank", price: 45, weight: 0.10 },
  { id: "smart-watch", price: 149, weight: 0.05 },
];

const COMPETITORS = ["gadget-rival", "mega-mart", "tech-outlet"];

const SENTIMENT_SAMPLES = [
  { source: "review", texts: [
    "Absolutely love this product! Exceeded my expectations.",
    "Good quality for the price. Would recommend.",
    "Fast shipping, product works as described.",
    "Amazing customer service, they resolved my issue quickly.",
    "Best purchase I've made this year!",
  ], rating: () => 4 + Math.floor(Math.random() * 2) },
  { source: "social", texts: [
    "Just got my order from this store — impressed!",
    "Anyone else tried their smart ring? Worth every penny.",
    "Customer support was super responsive today.",
    "The earbuds sound incredible for the price.",
    "Waiting for my order... tracking says tomorrow!",
  ], rating: () => 3 + Math.floor(Math.random() * 3) },
  { source: "support", texts: [
    "Had a minor issue with my order, resolved in minutes.",
    "Shipping was a bit slow but product is great.",
    "Return process was smooth and hassle-free.",
    "Would be nice to have more color options.",
    "Solid products, will order again.",
  ], rating: () => 3 + Math.floor(Math.random() * 2) },
];

const TREND_KEYWORDS = [
  { keyword: "smart rings", base: 85 },
  { keyword: "wireless earbuds", base: 72 },
  { keyword: "usb c cables", base: 35 },
  { keyword: "minimal desk setup", base: 60 },
  { keyword: "smart watch health", base: 78 },
  { keyword: "portable charger", base: 55 },
  { keyword: "phone accessories 2026", base: 42 },
  { keyword: "best gadgets under 100", base: 68 },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function chance(pct) { return Math.random() * 100 < pct; }

function createDemoSimulator(platform) {
  const {
    eventTracker,
    inventoryLedger,
    customerProfiles,
    sentimentCollector,
    externalSignals,
    competitorIngestor,
    competitorIntelligence,
    live,
    store,
  } = platform;

  const timers = [];
  const runningStores = new Set();
  let eventCount = 0;
  const tickCounts = new Map();

  // ── Weighted random product selection ──────────────────────────────
  function pickProduct() {
    const totalWeight = PRODUCTS.reduce((s, p) => s + p.weight, 0);
    let r = Math.random() * totalWeight;
    for (const p of PRODUCTS) {
      r -= p.weight;
      if (r <= 0) return p;
    }
    return PRODUCTS[0];
  }

  // ── Simulate a single customer browsing session ────────────────────
  async function simulateBrowse(store_id) {
    const name = pick(DEMO_NAMES);
    const views = rand(1, 4);
    const products = [];
    for (let i = 0; i < views; i++) {
      const p = pickProduct();
      products.push(p);
      await eventTracker.track({
        store_id,
        event_type: "product_view",
        customer_id: name,
        email: `${name}@demo.shop`,
        product_id: p.id,
        timestamp: new Date().toISOString(),
      });
      eventCount++;
    }
    return { name, products };
  }

  // ── Simulate cart activity ─────────────────────────────────────────
  async function simulateCart(store_id, name, products) {
    if (!products || products.length === 0) return null;
    const product = pick(products);
    const qty = chance(30) ? rand(2, 3) : 1;

    await eventTracker.track({
      store_id,
      event_type: "cart_updated",
      customer_id: name,
      email: `${name}@demo.shop`,
      product_id: product.id,
      quantity: qty,
      timestamp: new Date().toISOString(),
    });
    eventCount++;

    return { product, qty };
  }

  // ── Simulate a purchase ────────────────────────────────────────────
  async function simulatePurchase(store_id, name, cart) {
    const items = cart
      ? [{ product_id: cart.product.id, quantity: cart.qty }]
      : [{ product_id: pickProduct().id, quantity: 1 }];
    const total = items.reduce((sum, it) => {
      const p = PRODUCTS.find((x) => x.id === it.product_id);
      return sum + (p ? p.price : 50) * it.quantity;
    }, 0);

    // Checkout started
    await eventTracker.track({
      store_id,
      event_type: "checkout_started",
      customer_id: name,
      email: `${name}@demo.shop`,
      product_id: items[0].product_id,
      timestamp: new Date().toISOString(),
    });
    eventCount++;

    // Purchase
    await eventTracker.track({
      store_id,
      event_type: "purchase",
      customer_id: name,
      email: `${name}@demo.shop`,
      items,
      total,
      timestamp: new Date().toISOString(),
    });
    eventCount++;

    return { name, items, total };
  }

  // ── Simulate cart abandonment ──────────────────────────────────────
  async function simulateAbandonment(store_id, name, cart) {
    if (!cart) return;
    await eventTracker.track({
      store_id,
      event_type: "cart_abandoned",
      customer_id: name,
      email: `${name}@demo.shop`,
      product_id: cart.product.id,
      timestamp: new Date().toISOString(),
    });
    eventCount++;
  }

  // ── Simulate competitor price change ───────────────────────────────
  async function simulateCompetitorShift(store_id) {
    const competitor = pick(COMPETITORS);
    const product = pick(PRODUCTS);
    const basePrice = product.price;
    const delta = chance(60)
      ? -Math.round(basePrice * (0.05 + Math.random() * 0.15)) // 5-20% drop (60%)
      : Math.round(basePrice * (0.03 + Math.random() * 0.10)); // 3-10% increase (40%)
    const newPrice = Math.max(basePrice * 0.5, basePrice + delta);
    const inStock = chance(15) ? false : true; // 15% chance of stockout
    const promotion = chance(25) ? `SALE${rand(10, 50)} limited time` : undefined;

    await competitorIngestor.ingestSnapshot({
      store_id,
      competitor,
      captured_at: new Date().toISOString(),
      products: [
        { id: product.id, name: `${competitor} ${product.id}`, price: newPrice, in_stock: inStock, promotion },
      ],
    });
    eventCount++;
  }

  // ── Simulate trend fluctuation ─────────────────────────────────────
  async function simulateTrends(store_id) {
    const numSignals = rand(2, 5);
    const signals = [];
    for (let i = 0; i < numSignals; i++) {
      const t = pick(TREND_KEYWORDS);
      const fluctuation = rand(-12, 12);
      signals.push({
        store_id,
        source: pick(["google_trends", "reddit", "pinterest"]),
        keyword: t.keyword,
        score: Math.max(5, Math.min(100, t.base + fluctuation)),
      });
    }
    await externalSignals.ingestBatch(signals);
    eventCount += signals.length;
  }

  // ── Simulate sentiment ─────────────────────────────────────────────
  async function simulateSentiment(store_id) {
    const sample = pick(SENTIMENT_SAMPLES);
    const text = pick(sample.texts);
    await sentimentCollector.collect({
      store_id,
      source: sample.source,
      text,
      author: `@${pick(DEMO_NAMES)}`,
      rating: sample.rating(),
    });
    eventCount++;
  }

  // ── Simulate email/WhatsApp engagement ─────────────────────────────
  async function simulateEngagement(store_id) {
    const name = pick(DEMO_NAMES);
    const type = pick(["email_opened", "email_clicked", "whatsapp_read"]);
    await eventTracker.track({
      store_id,
      event_type: type,
      customer_id: name,
      email: `${name}@demo.shop`,
      timestamp: new Date().toISOString(),
    });
    eventCount++;
  }

  // ── Simulate a competitor ad update ────────────────────────────────
  async function simulateAdUpdate(store_id) {
    try {
      await platform.adIntelligence.ingest({
        store_id,
        ads: [
          {
            competitor: pick(COMPETITORS),
            platform: pick(["meta", "google", "tiktok"]),
            creative_type: pick(["video", "static", "carousel"]),
            headline: pick([
              "Limited time offer — up to 25% off",
              "New arrivals just dropped",
              "Best sellers from $9.99",
              "Free shipping on orders over $50",
              "Flash sale ends tonight",
            ]),
            cta: pick(["Shop Now", "Learn More", "Get Offer", "Buy Today"]),
          },
        ],
      });
      eventCount++;
    } catch (_) { /* ad intelligence is best-effort */ }
  }

  // ── Main tick: run one simulation cycle ────────────────────────────
  async function tick(store_id) {
    const tickCount = (tickCounts.get(store_id) || 0) + 1;
    tickCounts.set(store_id, tickCount);
    const actions = [];

    // Always: 1-3 browse sessions (the foundation of the funnel)
    const browseCount = rand(1, 3);
    for (let i = 0; i < browseCount; i++) {
      const { name, products } = await simulateBrowse(store_id);

      // 60% chance to add to cart
      if (chance(60)) {
        const cart = await simulateCart(store_id, name, products);

        if (cart) {
          // 40% purchase, 25% abandon, 35% just leave
          const outcome = Math.random();
          if (outcome < 0.40) {
            const purchase = await simulatePurchase(store_id, name, cart);
            actions.push({ type: "purchase", ...purchase });
          } else if (outcome < 0.65) {
            await simulateAbandonment(store_id, name, cart);
            actions.push({ type: "abandonment", name });
          }
        }
      }
    }

    // Every 3rd tick: competitor activity
    if (tickCount % 3 === 0) {
      await simulateCompetitorShift(store_id);
      actions.push({ type: "competitor" });
    }

    // Every 4th tick: trend fluctuation
    if (tickCount % 4 === 0) {
      await simulateTrends(store_id);
      actions.push({ type: "trends" });
    }

    // Every 2nd tick: sentiment
    if (tickCount % 2 === 0) {
      await simulateSentiment(store_id);
      actions.push({ type: "sentiment" });
    }

    // Every 5th tick: engagement events
    if (tickCount % 5 === 0) {
      await simulateEngagement(store_id);
      actions.push({ type: "engagement" });
    }

    // Every 6th tick: competitor ad update
    if (tickCount % 6 === 0) {
      await simulateAdUpdate(store_id);
      actions.push({ type: "ads" });
    }

    return { tick: tickCount, actions, eventCount };
  }

  // ── Start the simulation loop ──────────────────────────────────────
  function start(store_id, intervalMs = 5000) {
    if (runningStores.has(store_id)) return;
    runningStores.add(store_id);

    console.log(`[SIM] Simulator started for ${store_id} — events every ${(intervalMs / 1000).toFixed(0)}s`);

    // First tick immediately
    tick(store_id).catch((err) => console.error(`[SIM] tick error (${store_id}):`, err.message));

    // Then on interval
    const timer = setInterval(async () => {
      try {
        await tick(store_id);
      } catch (err) {
        console.error(`[SIM] tick error (${store_id}):`, err.message);
      }
    }, intervalMs);
    timers.push(timer);

    // Separate slower timers for background activity
    const trendTimer = setInterval(async () => {
      try { await simulateTrends(store_id); } catch (_) {}
    }, 120_000);
    timers.push(trendTimer);

    const sentimentTimer = setInterval(async () => {
      try { await simulateSentiment(store_id); } catch (_) {}
    }, 30_000);
    timers.push(sentimentTimer);

    const competitorTimer = setInterval(async () => {
      try { await simulateCompetitorShift(store_id); } catch (_) {}
    }, 45_000);
    timers.push(competitorTimer);

    const adTimer = setInterval(async () => {
      try { await simulateAdUpdate(store_id); } catch (_) {}
    }, 90_000);
    timers.push(adTimer);
  }

  // ── Stop all timers ────────────────────────────────────────────────
  function stop() {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    runningStores.clear();
    console.log(`[SIM] Stopped. Total events generated: ${eventCount}`);
  }

  // ── Run a single tick on demand ────────────────────────────────────
  async function tickOnce(store_id) {
    return tick(store_id);
  }

  return {
    start,
    stop,
    tickOnce,
    isRunning: (store_id) => store_id ? runningStores.has(store_id) : runningStores.size > 0,
    eventCount: () => eventCount,
    runningStores: () => [...runningStores],
  };
}

module.exports = { createDemoSimulator };
