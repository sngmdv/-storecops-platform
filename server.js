"use strict";

/**
 * Storecops Growth Platform — bootstrap.
 *
 * Wires the six-layer platform, starts the HTTP API and the periodic
 * growth-cycle scheduler.
 */

// DEP-001: load environment configuration before ANY other module is required,
// because `src/config/config.js` reads process.env at import time and runs the
// production readiness gate there. `loadEnvironment` owns the precedence rule
// and reports which file it used; see src/config/loadEnvironment.js for why the
// previous "try .env.production, else .env" order was a defect rather than a
// preference — with both files present, .env was never read at all.
//
// This must stay above the requires below.
const { loadEnvironment, } = require("./src/config/loadEnvironment",);
loadEnvironment();

const { createPlatform } = require("./src/platform");
const { createApp } = require("./src/server/createApp");
const {
  parseDemoStores,
  hasRealCredentials,
  createGrowthCycleRunner,
} = require("./src/server/growthScheduler");
const { createLifecycle, installProcessHandlers } = require("./src/server/lifecycle");

const platform = createPlatform();
const app = createApp(platform);

const PORT = platform.config.port;

// OBS-001: capture the server handle and register process-level handlers. Both
// were missing, so SIGTERM (sent on every deploy) killed the process outright —
// losing anything queued but undelivered — and a crash produced a bare stack
// trace with no exit-code contract for the orchestrator.
const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[BOOT] Storecops Growth Platform live on port ${PORT}`);
  console.log("[BOOT] Layers: Data → Intelligence → Decision → Execution → Reporting → Growth Loop");
  const publicUrl = platform.config.publicUrl || `http://localhost:${PORT}`;
  console.log(`[BOOT] API: ${publicUrl}/api/v1 (X-API-Key required) | Health: /health`);
  console.log(`[BOOT] Dashboard: ${publicUrl}/app`);
  console.log(`[BOOT] Environment: ${platform.config.env} | Storage: ${platform.config.storage}`);
});

const lifecycle = createLifecycle({ server, store: platform.store, },);
installProcessHandlers({ lifecycle, },);

// Growth loop heartbeat: run a full automation cycle for every store that has
// data, every 60 minutes.
//
// The cycle is NOT withheld from connected stores. It was, until now: a guard
// written as `if (hasRealCredentials) continue` skipped it for exactly the
// connected, paying merchants, so rule evaluation, recovery-message queuing,
// the delivery drain and attribution never ran for them automatically.
//
// Demo data is auto-seeded ONLY for ids listed in DEMO_STORE_IDS, and never
// for a store that turns out to be connected to a real platform. Real
// merchants must never see fabricated orders mixed with their own data.
const CYCLE_INTERVAL_MS = 60 * 60 * 1000;
const DEMO_STORES = parseDemoStores();
const growthCycleRunner = createGrowthCycleRunner({ platform, demoStores: DEMO_STORES, },);
setInterval(() => growthCycleRunner.runOnce(), CYCLE_INTERVAL_MS).unref();

// Task ob4: Periodic store re-sync scheduler.
// Every 4 hours, attempt to re-pull products/orders for all connected stores.
// Stores with full credentials stored will re-sync; OAuth-only stores skip
// gracefully (they need re-authentication).
const RESYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const stores = await platform.integrations.listAllStores();
    let synced = 0;
    let skipped = 0;
    for (const store of stores) {
      if (store.status === "uninstalled") continue;
      const result = await platform.integrations.resyncStore(store.store_id);
      if (result.resynced) synced++;
      else skipped++;
    }
    if (stores.length > 0) {
      console.log(`[RESYNC] checked=${stores.length} synced=${synced} skipped=${skipped}`);
    }
  } catch (error) {
    console.error("[RESYNC] failed:", error.message);
  }
}, RESYNC_INTERVAL_MS).unref();

// External signal collector: fetch trending data every 2 hours.
const SIGNALS_INTERVAL_MS = 2 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const allStores = await platform.store.users.find({});
    const storeIds = [...new Set(allStores.map((u) => u.store_id).filter(Boolean))];
    for (const storeId of storeIds) {
      const hasReal = await hasRealCredentials(platform, storeId);
      if (!hasReal) continue; // only collect for stores with real data
      // Get product keywords from inventory
      const products = await platform.inventoryLedger.levels(storeId);
      const keywords = products.map((p) => p.product_id?.replace(/[-_]/g, " ")).filter(Boolean).slice(0, 5);
      if (keywords.length > 0) {
        const result = await platform.signalCollectors.collectAll(storeId, keywords);
        console.log(`[SIGNALS] store=${storeId} collected=${result.collected}`);
      }
    }
  } catch (error) {
    console.error("[SIGNALS] failed:", error.message);
  }
}, SIGNALS_INTERVAL_MS).unref();

// Data retention: enforce the windows in config.dataRetention (events,
// deliveries, consentRecords, monitoringEvents, sessions). This is opt-in —
// start() no-ops unless RETENTION_ENABLED=true. Deleting production data on a
// timer should be a deliberate operator decision, not a side effect of a config
// object existing. Previously these windows were defined and never read, so
// privacy.html promised retention the platform did not enforce.
platform.dataRetention.start();
