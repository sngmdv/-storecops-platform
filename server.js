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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[BOOT] Storecops Growth Platform live on port ${PORT}`);
  console.log("[BOOT] Layers: Data → Intelligence → Decision → Execution → Reporting → Growth Loop");
  const publicUrl = platform.config.publicUrl || `http://localhost:${PORT}`;
  console.log(`[BOOT] API: ${publicUrl}/api/v1 (X-API-Key required) | Health: /health`);
  console.log(`[BOOT] Dashboard: ${publicUrl}/app`);
  console.log(`[BOOT] Environment: ${platform.config.env} | Storage: ${platform.config.storage}`);
});

// Growth loop heartbeat: run a full automation cycle for the default
// store every 15 minutes. Multi-store deployments register more stores
// here or call POST /api/v1/growth-cycle/:store_id on demand.
const CYCLE_INTERVAL_MS = 15 * 60 * 1000;
setInterval(async () => {
  try {
    const cycle = await platform.runGrowthCycle(platform.config.defaultStoreId);
    console.log(
      `[GROWTH-CYCLE] store=${platform.config.defaultStoreId} queued=${cycle.scan.queued_actions.length} executed=${cycle.execution.delivered} conversions=${cycle.attribution.conversions}`
    );
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
