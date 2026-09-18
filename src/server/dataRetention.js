'use strict';

/**
 * Data-retention enforcement.
 *
 * WHY THIS EXISTS
 * ---------------
 * `config.retention` defined five retention windows (events 365d, deliveries
 * 180d, consentRecords 730d, monitoringEvents 90d, sessions 30d) and *nothing
 * read it*. `grep -rn retention src/` returned only `retentionEngine` and
 * `retentionSnapshots` — the customer-retention product, unrelated to this
 * policy. So privacy.html promised retention limits the platform did not
 * enforce, which is a compliance claim with no implementation behind it.
 *
 * NAMING
 * ------
 * This module is `dataRetention`. `retentionEngine`
 * (src/layers/intelligence/retentionEngine.js) is the customer-retention product
 * feature — churn scoring, health scores, interventions. The two names collided,
 * which is part of how the policy went unenforced for so long. The config key was
 * renamed to `dataRetention` for the same reason.
 *
 * SAFETY
 * ------
 * Deleting production data on a timer is dangerous, so:
 *   - It is opt-in (`RETENTION_ENABLED=true`). Default is off.
 *   - `runOnce({ dryRun: true })` reports what would go without deleting.
 *   - A row with no parseable timestamp is never deleted — we only remove data
 *     we can actually date.
 *   - A non-positive window disables that collection rather than deleting all.
 *   - Only the five policy collections are ever touched; nothing here can reach
 *     financial records, opt-out lists or the audit log.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One entry per enforced collection. `timestampFields` is a preference order —
 * the first field present and parseable on a row wins, because the collections
 * were written at different times and do not agree on a field name.
 *
 * These four are exactly the fixed windows published in public/privacy.html §4
 * (events 365, deliveries 180, sessions 30, monitoring events 90).
 */
const POLICIES = [
  { collection: 'events', windowKey: 'events', timestampFields: ['timestamp', 'created_at', 'createdAt',], },
  { collection: 'deliveries', windowKey: 'deliveries', timestampFields: ['delivered_at', 'created_at', 'createdAt',], },
  { collection: 'monitoringEvents', windowKey: 'monitoringEvents', timestampFields: ['timestamp', 'created_at', 'createdAt',], },
  { collection: 'sessions', windowKey: 'sessions', timestampFields: ['created_at', 'createdAt', 'issued_at',], },
];

/**
 * Deliberately NOT swept automatically.
 *
 * public/privacy.html §4 says consent records are "Retained indefinitely (or
 * until revocation + 2 years for audit)" — note that even the parenthetical is
 * measured from *revocation*, not from creation, which is not something a
 * timestamp sweep can evaluate. The config window (`consentRecords: 730`) would
 * have deleted them 2 years after creation regardless of revocation state.
 *
 * More fundamentally: a consent record is the evidence that we had permission to
 * contact someone. Deleting it on a timer destroys the proof we would need in a
 * dispute, and there is no upside — the data is a boolean and a timestamp, not
 * a growing pile of PII. So it is held unless an operator explicitly opts in.
 */
const HELD_COLLECTIONS = {
  consentRecords: {
    collection: 'consentRecords',
    windowKey: 'consentRecords',
    timestampFields: ['recorded_at', 'created_at', 'createdAt',],
  },
};

/**
 * Epoch milliseconds for a row, or null when it cannot be dated.
 * Returning null is important: an undateable row must be skipped, never deleted.
 */
function resolveTimestamp(row, fields,) {
  if (!row || typeof row !== 'object') return null;
  for (const field of fields) {
    const value = row[field];
    if (value === undefined || value === null) continue;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value,);
    if (Number.isFinite(ms,)) return ms;
  }
  return null;
}

/**
 * Create the retention job.
 *
 * The job is created but never started here — `createPlatform` is called by every
 * test, and an auto-starting interval would both leak timers and risk deleting
 * test data. server.js starts it explicitly.
 */
function createDataRetentionJob({ store, config, logger = console, now = () => Date.now(), },) {
  const settings = config?.dataRetention || {};
  let timer = null;

  /**
   * Collections with a usable window, resolved per run so env changes apply.
   * Held collections join the sweep only under an explicit opt-in.
   */
  function activePolicies() {
    const candidates = settings.enforceConsent === true
      ? [...POLICIES, ...Object.values(HELD_COLLECTIONS,),]
      : POLICIES;

    return candidates.map((policy,) => ({
      ...policy,
      days: Number(settings[policy.windowKey],),
    }),).filter((policy,) => Number.isFinite(policy.days,) && policy.days > 0,);
  }
  /**
   * Enforce every window once.
   * With `dryRun` nothing is deleted and `matched` reports the count instead.
   */
  async function runOnce({ dryRun = false, } = {},) {
    const startedAt = new Date(now(),).toISOString();
    const report = {
      started_at: startedAt,
      dry_run: dryRun,
      enabled: settings.enabled === true,
      collections: {},
      total_deleted: 0,
      total_matched: 0,
      skipped: [],
    };

    for (const policy of activePolicies()) {
      const collection = store[policy.collection];
      if (!collection || typeof collection.find !== 'function') {
        report.skipped.push({ collection: policy.collection, reason: 'collection not available', },);
        continue;
      }

      const cutoff = now() - policy.days * DAY_MS;
      const isExpired = (row,) => {
        const ms = resolveTimestamp(row, policy.timestampFields,);
        return ms !== null && ms < cutoff;
      };

      try {
        if (dryRun) {
          const matched = await collection.find(isExpired,);
          report.collections[policy.collection] = {
            window_days: policy.days,
            cutoff: new Date(cutoff,).toISOString(),
            matched: matched.length,
            deleted: 0,
          };
          report.total_matched += matched.length;
        } else {
          const deleted = await collection.deleteMany(isExpired,);
          report.collections[policy.collection] = {
            window_days: policy.days,
            cutoff: new Date(cutoff,).toISOString(),
            deleted,
          };
          report.total_deleted += deleted;
        }
      } catch (error) {
        // One collection failing must not stop the others, and must be visible.
        report.skipped.push({ collection: policy.collection, reason: error.message, },);
      }
    }

    const windowless = POLICIES.filter(
      (policy,) => !activePolicies().some((active,) => active.collection === policy.collection,),
    ).map((policy,) => policy.collection,);
    if (windowless.length > 0) {
      report.skipped.push({ collection: windowless, reason: 'no positive retention window configured', },);
    }

    // Make the hold visible in every report — a collection that is quietly never
    // swept is exactly how the original defect went unnoticed.
    if (settings.enforceConsent !== true) {
      report.skipped.push({
        collection: Object.keys(HELD_COLLECTIONS,),
        reason: 'held by policy — privacy.html retains consent records indefinitely; set RETENTION_ENFORCE_CONSENT=true to include',
      },);
    }

    report.finished_at = new Date(now(),).toISOString();
    return report;
  }

  /** Start the periodic sweep. No-op unless retention is enabled. */
  function start() {
    if (settings.enabled !== true) {
      logger.log('[RETENTION] disabled — set RETENTION_ENABLED=true to enforce the policy',);
      return false;
    }
    if (timer) return true;

    const hours = Number(settings.intervalHours,) > 0 ? Number(settings.intervalHours,) : 24;
    timer = setInterval(async () => {
      try {
        const report = await runOnce();
        if (report.total_deleted > 0) {
          logger.log(
            `[RETENTION] deleted ${report.total_deleted} expired row(s): ` +
              Object.entries(report.collections,)
                .map(([name, info,],) => `${name}=${info.deleted}`,)
                .join(' ',),
          );
        }
      } catch (error) {
        logger.error('[RETENTION] sweep failed:', error.message,);
      }
    }, hours * 60 * 60 * 1000,);

    // Never hold the process open.
    if (typeof timer.unref === 'function') timer.unref();
    logger.log(`[RETENTION] enabled — enforcing every ${hours}h`,);
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer,);
    timer = null;
    return true;
  }

  return { runOnce, start, stop, policies: POLICIES, };
}

module.exports = { createDataRetentionJob, resolveTimestamp, POLICIES, HELD_COLLECTIONS, DAY_MS, };
