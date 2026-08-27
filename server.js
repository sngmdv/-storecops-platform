"use strict";

/**
 * Storecops Growth Platform — bootstrap.
 *
 * Wires the six-layer platform, starts the HTTP API and the periodic
 * growth-cycle scheduler.
 */

const { createPlatform } = require("./src/platform");
const { createApp } = require("./src/server/createApp");

const platform = createPlatform();
const app = createApp(platform);

const PORT = platform.config.port;

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[BOOT] Storecops Growth Platform live on port ${PORT}`);
  console.log("[BOOT] Layers: Data → Intelligence → Decision → Execution → Reporting → Growth Loop");
  const publicUrl = platform.config.publicUrl || `http://localhost:${PORT}`;
  console.log(`[BOOT] API: ${publicUrl}/api/v1 (X-API-Key required) | Health: /health`);
  console.log(`[BOOT] Dashboard: ${publicUrl}/app`);
  console.log(`[BOOT] Environment: ${platform.config.env} | Storage: ${platform.config.storage}`);

  // ── Seed + simulate ALL stores without real credentials ─────────────
  try {
    const allStores = await platform.store.users.find({});
    const storeIds = [...new Set(allStores.map((u) => u.store_id).filter(Boolean))];
    let simulated = 0;

    for (const storeId of storeIds) {
      const hasReal = await hasRealCredentials(platform, storeId);
      if (!hasReal) {
        const seeded = await platform.demoSeed.seed(storeId);
        if (seeded.seeded) {
          console.log(`[BOOT] Seeded demo data for ${storeId}: ${seeded.events} events`);
        }
        if (!platform.demoSimulator.isRunning(storeId)) {
          platform.demoSimulator.start(storeId, 5000);
          simulated++;
        }
      }
    }

    // Always ensure the default store is covered
    const defaultId = platform.config.defaultStoreId;
    if (!storeIds.includes(defaultId)) {
      await platform.demoSeed.seed(defaultId);
      platform.demoSimulator.start(defaultId, 5000);
      simulated++;
    }

    console.log(`[BOOT] Demo simulator active for ${simulated} store(s) — live activity enabled`);
  } catch (err) {
    console.error("[BOOT] Simulator startup failed:", err.message);
  }
});

/** Check if a store has real integration credentials (Shopify/WooCommerce/BigCommerce). */
async function hasRealCredentials(platform, storeId) {
  try {
    const connectors = await platform.store.get("connectors") || {};
    if (connectors.shopify?.access_token || connectors.woocommerce?.consumer_key || connectors.bigcommerce?.access_token) {
      return true;
    }
    // Also check integrations collection
    const integration = await platform.store.findOne("integrations", { store_id: storeId });
    if (integration?.shopify?.access_token || integration?.woocommerce?.consumer_key || integration?.bigcommerce?.access_token) {
      return true;
    }
  } catch (_) {}
  return false;
}

// Growth loop heartbeat: run a full automation cycle for every
// active store every 15 minutes.
const CYCLE_INTERVAL_MS = 15 * 60 * 1000;
setInterval(async () => {
  try {
    const allStores = await platform.store.users.find({});
    const storeIds = [...new Set(allStores.map((u) => u.store_id).filter(Boolean))];
    for (const storeId of storeIds) {
      const hasReal = await hasRealCredentials(platform, storeId);
      if (hasReal) continue; // skip stores with real integrations (they re-sync separately)
      // Ensure demo data exists before running growth cycle
      await platform.demoSeed.seed(storeId);
      const cycle = await platform.runGrowthCycle(storeId);
      console.log(
        `[GROWTH-CYCLE] store=${storeId} queued=${cycle.scan.queued_actions.length} executed=${cycle.execution.delivered} conversions=${cycle.attribution.conversions}`
      );
    }
  } catch (error) {
    console.error("[GROWTH-CYCLE] failed:", error.message);
  }
}, CYCLE_INTERVAL_MS).unref();

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
