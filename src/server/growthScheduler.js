'use strict';

/**
 * Growth-loop scheduler body.
 *
 * Extracted from `server.js` so the per-store decision is reachable from a
 * test. The bootstrap script calls `createPlatform()`, `createApp()` and
 * `app.listen()` at module scope, so nothing inside it can be exercised
 * without binding a port — which is how the defect documented below survived
 * review for six days.
 *
 * The decision for one store has two INDEPENDENT parts:
 *
 *   1. **Seeding** — fabricating a fortnight of activity so a brand-new
 *      install looks alive. This is the only step that must be withheld from
 *      a store connected to a real platform.
 *   2. **The cycle** — scan, execute, attribute. This is the growth loop's
 *      heartbeat, and it must run for every store that has data.
 *
 * Those two were conflated. The demo gate added in `d52cca35` ("demo gate
 * DB-001") was written as `if (hasRealCredentials) continue`, which skipped
 * the cycle as well as the seeding. The set it skipped is exactly the
 * connected, paying merchants — so rule evaluation, recovery-message queuing,
 * the delivery drain and attribution never ran automatically for a real
 * merchant. Its stated justification ("they re-sync separately") was also
 * wrong: the four-hourly re-sync only calls `integrations.resyncStore`, which
 * pulls catalogue/order data and never touches the automation loop.
 *
 * The only other caller of `runGrowthCycle` is the manual button in the
 * dashboard, so a merchant who never pressed it got no automation at all.
 */

const DEFAULT_DEMO_STORE_IDS = 'store_demo,demo_store';

/**
 * Parse the `DEMO_STORE_IDS` allowlist.
 *
 * Only ids listed here are ever seeded. Note the deliberate absence of a
 * `DEMO_MODE` escape hatch: `server.js` defined `isDemoEnabled()` and never
 * called it, so the documented "or when DEMO_MODE=true" behaviour did not
 * exist. It is not restored, because a single environment variable that
 * causes fabricated orders to appear in a real merchant's dashboard is the
 * same failure mode as DB-001. An operator who wants a demo store adds it to
 * `DEMO_STORE_IDS`.
 */
function parseDemoStores(raw = process.env.DEMO_STORE_IDS,) {
  return new Set(
    String(raw || DEFAULT_DEMO_STORE_IDS,)
      .split(',',)
      .map((s,) => s.trim(),)
      .filter(Boolean,),
  );
}

/** True when a stored connection record carries a usable token or key. */
function hasToken(record,) {
  return Boolean(
    record?.shopify?.access_token ||
      record?.woocommerce?.consumer_key ||
      record?.bigcommerce?.access_token,
  );
}

/**
 * Does this store have real integration credentials?
 *
 * Reads through the collection facade. `platform.store` exposes collections as
 * properties and has no `.get()`/`.findOne()`; the original version called
 * those, threw, and was swallowed by the surrounding `catch (_) {}`, so it
 * answered `false` for every store (audit DB-001). Do not "simplify" this back
 * to a facade-level lookup.
 */
async function hasRealCredentials(platform, storeId,) {
  try {
    const integration = await platform.store.integrations.findOne({ store_id: storeId, },);
    if (hasToken(integration,)) return true;
    // The connectors collection is optional — an older store may not have one.
    if (platform.store.connectors) {
      const connector = await platform.store.connectors.findOne({ store_id: storeId, },);
      if (hasToken(connector,)) return true;
    }
  } catch {}
  return false;
}

/**
 * Build the hourly sweep.
 *
 * @param {object} options
 * @param {object} options.platform      Assembled platform (needs `store`,
 *                                       `demoSeed`, `runGrowthCycle`).
 * @param {Set}    options.demoStores    Ids eligible for demo seeding.
 * @param {object} [options.log]         Logger (defaults to `console`).
 */
function createGrowthCycleRunner({ platform, demoStores, log = console, },) {
  async function runOnce() {
    const summary = {
      considered: 0,
      seeded: [],
      ran: [],
      skipped_no_data: [],
      errors: [],
    };

    let users;
    try {
      users = await platform.store.users.find({},);
    } catch (error) {
      log.error('[GROWTH-CYCLE] failed:', error.message,);
      summary.errors.push({ store_id: null, message: error.message, },);
      return summary;
    }

    const storeIds = [...new Set(users.map((u,) => u.store_id,).filter(Boolean,),),];

    for (const storeId of storeIds) {
      summary.considered += 1;
      try {
        const isDemoStore = demoStores.has(storeId,);

        // Seeding is withheld even from a listed demo store that turns out to
        // be connected: fabricating orders into a live merchant's dashboard is
        // unrecoverable trust damage, whereas a demo store that misses a seed
        // merely looks quiet. `demoSeed.seed` is itself idempotent, so this is
        // defence in depth rather than the only guard.
        const seedable = isDemoStore && !(await hasRealCredentials(platform, storeId,));
        if (seedable) {
          await platform.demoSeed.seed(storeId,);
          summary.seeded.push(storeId,);
        }

        // A store with no events has nothing to scan. Do not fabricate to fill
        // the gap — wait until real data arrives. Seeded stores are exempt:
        // they were just given events by the line above.
        if (!seedable) {
          const events = await platform.store.events.find({ store_id: storeId, },);
          if (events.length === 0) {
            summary.skipped_no_data.push(storeId,);
            continue;
          }
        }

        const cycle = await platform.runGrowthCycle(storeId,);
        summary.ran.push(storeId,);
        log.log(
          `[GROWTH-CYCLE] store=${storeId} queued=${cycle.scan.queued_actions.length} executed=${cycle.execution.delivered} conversions=${cycle.attribution.conversions}`,
        );
      } catch (error) {
        // Per-store isolation. A single try/catch around the whole loop means
        // one bad store aborts the sweep, silently starving every merchant
        // ordered after it — the same class of failure as the gate above.
        summary.errors.push({ store_id: storeId, message: error.message, },);
        log.error(`[GROWTH-CYCLE] store=${storeId} failed:`, error.message,);
      }
    }

    return summary;
  }

  return { runOnce, };
}

module.exports = { parseDemoStores, hasRealCredentials, createGrowthCycleRunner, };
