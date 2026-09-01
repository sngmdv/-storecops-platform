'use strict';

/**
 * Demo Seeder.
 *
 * Fills a store with a fortnight of believable activity so the web
 * app is alive the moment a client opens it: purchases, abandoned
 * carts, churn-risk customers, stock levels, competitor snapshots,
 * search-console rows, sentiment samples and trend signals.
 *
 * Idempotent: seeding a store that already has events is a no-op.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const CATALOG = [
  { id: 'smart-ring', price: 199, },
  { id: 'wireless-earbuds', price: 89, },
  { id: 'phone-case', price: 24, },
  { id: 'usb-cable', price: 12, },
  { id: 'power-bank', price: 45, },
  { id: 'smart-watch', price: 149, },
];

function at(daysAgo, hour, minute = 0,) {
  const d = new Date(Date.now() - daysAgo * DAY_MS,);
  d.setHours(hour, minute, 0, 0,);
  return d.toISOString();
}

function purchase(store_id, customer, email, daysAgo, hour, items,) {
  const total = items.reduce((sum, item,) => {
    const catalog = CATALOG.find((p,) => p.id === item.product_id,);
    return sum + (item.price ?? catalog.price) * item.quantity;
  }, 0,);
  return {
    store_id,
    event_type: 'purchase',
    customer_id: customer,
    email,
    timestamp: at(daysAgo, hour,),
    items,
    total,
  };
}

/** One buyer, one product, one unit — keeps the busy-fortnight loop readable. */
function quickBuy(store_id, customer, daysAgo, hour, product_id, quantity = 1,) {
  return purchase(store_id, customer, `${customer}@demo.shop`, daysAgo, hour, [
    { product_id, quantity, },
  ],);
}

function createDemoSeeder(platform,) {
  const {
    eventTracker,
    inventoryLedger,
    sentimentCollector,
    externalSignals,
    competitorIngestor,
    searchConsole,
    store,
  } = platform;

  async function seed(store_id = 'demo_store',) {
    const existing = await store.events.find((e,) => e.store_id === store_id,);
    if (existing.length > 0) {
      return { store_id, seeded: false, reason: 'Store already has data.', events: existing.length, };
    }

    // ── Two weeks of customer activity ───────────────────────────────
    const events = [
      // Loyal VIP-ish buyer
      purchase(store_id, 'anita', 'anita@demo.shop', 12, 10, [{ product_id: 'smart-watch', quantity: 1, },],),
      purchase(store_id, 'anita', 'anita@demo.shop', 5, 14, [{ product_id: 'wireless-earbuds', quantity: 1, },],),
      purchase(store_id, 'anita', 'anita@demo.shop', 1, 11, [{ product_id: 'smart-ring', quantity: 1, },],),
      // Repeat buyer
      purchase(store_id, 'vikram', 'vikram@demo.shop', 9, 16, [{ product_id: 'power-bank', quantity: 2, },],),
      purchase(store_id, 'vikram', 'vikram@demo.shop', 3, 12, [{ product_id: 'wireless-earbuds', quantity: 1, },],),
      // New buyers
      purchase(store_id, 'priya', 'priya@demo.shop', 2, 18, [{ product_id: 'smart-ring', quantity: 1, },],),
      purchase(store_id, 'rahul', 'rahul@demo.shop', 1, 15, [{ product_id: 'phone-case', quantity: 2, },],),
      // Very recent (live feed should show these)
      purchase(store_id, 'sara', 'sara@demo.shop', 0, new Date().getHours(), [
        { product_id: 'wireless-earbuds', quantity: 1, },
        { product_id: 'usb-cable', quantity: 1, },
      ],),

      // Cart abandoners (recovery targets)
      { store_id, event_type: 'product_view', customer_id: 'dev', email: 'dev@demo.shop', product_id: 'smart-ring', timestamp: at(1, 20,), },
      { store_id, event_type: 'cart_updated', customer_id: 'dev', email: 'dev@demo.shop', product_id: 'smart-ring', timestamp: at(1, 20, 5,), },
      { store_id, event_type: 'cart_abandoned', customer_id: 'dev', email: 'dev@demo.shop', product_id: 'smart-ring', timestamp: at(1, 20, 20,), },
      { store_id, event_type: 'product_view', customer_id: 'meera', email: 'meera@demo.shop', product_id: 'smart-watch', timestamp: at(0, 9,), },
      { store_id, event_type: 'cart_updated', customer_id: 'meera', email: 'meera@demo.shop', product_id: 'smart-watch', timestamp: at(0, 9, 10,), },
      { store_id, event_type: 'cart_abandoned', customer_id: 'meera', email: 'meera@demo.shop', product_id: 'smart-watch', timestamp: at(0, 9, 25,), },

      // Browse abandoner (never added to cart)
      { store_id, event_type: 'product_view', customer_id: 'guest-browse', session_id: 'sess-browse-1', product_id: 'power-bank', timestamp: at(0, 8,), },
      { store_id, event_type: 'product_view', customer_id: 'guest-browse', session_id: 'sess-browse-1', product_id: 'smart-watch', timestamp: at(0, 8, 15,), },
      { store_id, event_type: 'product_view', customer_id: 'guest-browse', session_id: 'sess-browse-1', product_id: 'smart-ring', timestamp: at(0, 8, 30,), },

      // Defection signal on a paying customer
      { store_id, event_type: 'competitor_view', customer_id: 'vikram', email: 'vikram@demo.shop', timestamp: at(0, 7,), },

      // Dormant buyer from 40 days ago (churn risk)
      purchase(store_id, 'old-buyer', 'old@demo.shop', 40, 12, [{ product_id: 'usb-cable', quantity: 1, },],),

      // Busy fortnight: earbuds fly off the shelf (fast mover),
      // smart rings stay hot (restock pressure), cables crawl (slow).
      quickBuy(store_id, 'buyer-01', 13, 10, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-02', 13, 15, 'smart-ring',),
      quickBuy(store_id, 'buyer-03', 12, 11, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-04', 12, 17, 'phone-case',),
      quickBuy(store_id, 'buyer-05', 11, 9, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-06', 11, 14, 'smart-ring',),
      quickBuy(store_id, 'buyer-07', 10, 12, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-08', 10, 18, 'usb-cable',),
      quickBuy(store_id, 'buyer-09', 9, 10, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-10', 9, 13, 'smart-ring',),
      quickBuy(store_id, 'buyer-11', 8, 11, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-12', 8, 16, 'phone-case',),
      quickBuy(store_id, 'buyer-13', 7, 9, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-14', 7, 15, 'smart-ring',),
      quickBuy(store_id, 'buyer-15', 6, 10, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-16', 6, 14, 'smart-watch',),
      quickBuy(store_id, 'buyer-17', 5, 12, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-18', 5, 17, 'smart-ring',),
      quickBuy(store_id, 'buyer-19', 4, 10, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-20', 4, 13, 'power-bank',),
      quickBuy(store_id, 'buyer-21', 3, 11, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-22', 3, 16, 'smart-ring',),
      quickBuy(store_id, 'buyer-23', 2, 9, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-24', 2, 14, 'phone-case',),
      quickBuy(store_id, 'buyer-25', 1, 10, 'wireless-earbuds', 2,),
      quickBuy(store_id, 'buyer-26', 1, 13, 'smart-ring',),

      // Email engagement to teach the send-time optimizer
      { store_id, event_type: 'email_opened', customer_id: 'anita', email: 'anita@demo.shop', timestamp: at(4, 9,), },
      { store_id, event_type: 'email_opened', customer_id: 'anita', email: 'anita@demo.shop', timestamp: at(3, 10,), },
      { store_id, event_type: 'email_opened', customer_id: 'vikram', email: 'vikram@demo.shop', timestamp: at(2, 19,), },
      { store_id, event_type: 'whatsapp_read', customer_id: 'priya', email: 'priya@demo.shop', timestamp: at(1, 20,), },
    ];

    // Derive a believable funnel: every buyer browsed first, a third
    // added to cart and started checkout before purchasing.
    const derived = [];
    for (const [index, event,] of events.entries()) {
      if (event.event_type !== 'purchase') continue;
      const browsedAt = new Date(new Date(event.timestamp,).getTime() - 2 * 60 * 60 * 1000,);
      const checkedOutAt = new Date(new Date(event.timestamp,).getTime() - 30 * 60 * 1000,);
      for (const item of event.items || []) {
        derived.push({
          store_id,
          event_type: 'product_view',
          customer_id: event.customer_id,
          email: event.email,
          product_id: item.product_id,
          timestamp: browsedAt.toISOString(),
        },);
        if (index % 3 === 0) {
          derived.push({
            store_id,
            event_type: 'cart_updated',
            customer_id: event.customer_id,
            email: event.email,
            product_id: item.product_id,
            timestamp: checkedOutAt.toISOString(),
          },);
          derived.push({
            store_id,
            event_type: 'checkout_started',
            customer_id: event.customer_id,
            email: event.email,
            product_id: item.product_id,
            timestamp: checkedOutAt.toISOString(),
          },);
        }
      }
    }
    events.push(...derived,);

    const tracked = await eventTracker.trackBatch(events,);

    // ── Current stock levels (set after events = today's truth) ─────
    await inventoryLedger.setStockBatch(store_id, [
      { product_id: 'smart-ring', stock: 2, lead_time_days: 7, },
      { product_id: 'wireless-earbuds', stock: 4, lead_time_days: 5, },
      { product_id: 'phone-case', stock: 120, lead_time_days: 10, },
      { product_id: 'usb-cable', stock: 60, lead_time_days: 7, },
      { product_id: 'power-bank', stock: 9, lead_time_days: 7, },
      { product_id: 'smart-watch', stock: 25, lead_time_days: 14, },
    ],);

    // ── Brand sentiment samples ──────────────────────────────────────
    const sentiment = [
      { store_id, source: 'review', text: 'The smart ring is amazing, battery lasts a full week. Love it!', author: 'anita', rating: 5, },
      { store_id, source: 'review', text: 'Great earbuds, crystal clear sound and fast delivery.', author: 'vikram', rating: 5, },
      { store_id, source: 'social', text: 'Phone case feels cheap, disappointed with the quality.', author: '@techfan', rating: 2, },
      { store_id, source: 'support', text: 'Support was helpful but shipping took too long.', author: 'rahul', rating: 3, },
      { store_id, source: 'review', text: 'Best gadget store, prices beat everyone else!', author: 'priya', rating: 5, },
    ];
    for (const sample of sentiment) await sentimentCollector.collect(sample,);

    // ── Trend signals ────────────────────────────────────────────────
    await externalSignals.ingestBatch([
      { store_id, source: 'google_trends', keyword: 'smart rings', score: 88, },
      { store_id, source: 'reddit', keyword: 'smart rings', score: 81, },
      { store_id, source: 'google_trends', keyword: 'wireless earbuds', score: 74, },
      { store_id, source: 'pinterest', keyword: 'minimal desk setup', score: 62, },
      { store_id, source: 'google_trends', keyword: 'usb c cables', score: 35, },
    ],);

    // ── Competitor snapshots (7 days apart → diffs light up) ─────────
    await competitorIngestor.ingestSnapshot({
      store_id,
      competitor: 'gadget-rival',
      captured_at: at(7, 6,),
      products: [
        { id: 'smart-ring', name: 'Rival Ring Pro', price: 219, in_stock: true, },
        { id: 'wireless-earbuds', name: 'Rival Buds X', price: 95, in_stock: true, },
        { id: 'smart-watch', name: 'Rival Watch S', price: 159, in_stock: true, },
      ],
    },);
    await competitorIngestor.ingestSnapshot({
      store_id,
      competitor: 'gadget-rival',
      captured_at: at(0, 6,),
      products: [
        { id: 'smart-ring', name: 'Rival Ring Pro', price: 189, in_stock: true, promotion: 'SAVE30 launch week', },
        { id: 'wireless-earbuds', name: 'Rival Buds X', price: 95, in_stock: false, },
        { id: 'smart-watch', name: 'Rival Watch S', price: 159, in_stock: true, },
      ],
    },);

    // ── Competitor ads ───────────────────────────────────────────────
    await platform.adIntelligence.ingest({
      store_id,
      ads: [
        { competitor: 'gadget-rival', platform: 'meta', creative_type: 'video', headline: 'Ring Pro — 30% off this week', cta: 'Shop Now', },
        { competitor: 'gadget-rival', platform: 'google', creative_type: 'static', headline: 'Best smart rings 2026', cta: 'Compare', },
        { competitor: 'mega-mart', platform: 'tiktok', creative_type: 'video', headline: 'Unboxing the viral smart ring', cta: 'Learn More', },
      ],
    },);

    // ── Search Console data ──────────────────────────────────────────
    await searchConsole.ingestPerformance({
      store_id,
      rows: [
        { query: 'buy smart ring online', page: '/smart-ring', impressions: 820, clicks: 11, position: 12, },
        { query: 'best wireless earbuds under 100', page: '/earbuds', impressions: 1450, clicks: 31, position: 8, },
        { query: 'smart watch with health tracking', page: '/smart-watch', impressions: 610, clicks: 9, position: 15, },
        { query: 'phone case', page: '/cases', impressions: 390, clicks: 24, position: 4, },
        { query: 'how to track sleep with a ring', page: '/blog/sleep', impressions: 270, clicks: 5, position: 18, },
      ],
    },);
    await searchConsole.ingestRankings({
      store_id,
      rankings: [
        { keyword: 'smart ring', brand: 'us', position: 12, },
        { keyword: 'smart ring', brand: 'gadget-rival', position: 3, },
        { keyword: 'wireless earbuds', brand: 'us', position: 8, },
        { keyword: 'wireless earbuds', brand: 'gadget-rival', position: 5, },
        { keyword: 'smart watch', brand: 'us', position: 15, },
        { keyword: 'smart watch', brand: 'mega-mart', position: 2, },
      ],
    },);

    const accepted = tracked.filter((r,) => r.accepted,).length;
    return { store_id, seeded: true, events: accepted, products: CATALOG.length, note: 'Demo data ready. Open the dashboard.', };
  }

  return { seed, CATALOG, };
}

module.exports = { createDemoSeeder, };
