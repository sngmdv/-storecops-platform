'use strict';

/**
 * Per-account login throttle.
 *
 * The general API rate limiter caps requests per key/IP, which does nothing
 * against credential stuffing: an attacker with a botnet spreads one attempt
 * per account across thousands of IPs, and every request stays under the
 * per-IP ceiling. This adds the other half — a counter per *account*, so
 * guessing the same account repeatedly gets progressively slower regardless of
 * where the requests come from.
 *
 * Deliberate design choices:
 *
 *  - The lockout is NOT reported differently from a wrong password. Returning
 *    "account locked" tells an attacker the account exists, turning the
 *    throttle into an enumeration oracle. Callers get the same generic
 *    credential error; the refusal is recorded in the audit log instead.
 *  - The counter is keyed by normalized email, so `Bob@x.com` and `bob@x.com`
 *    share one budget.
 *  - The map is bounded. Without a cap, an attacker probing a million distinct
 *    addresses would grow this structure without limit — a memory-exhaustion
 *    lever handed over by the very control meant to stop them.
 *  - State is in-process. With more than one instance behind a load balancer
 *    each holds its own counter, so the effective limit multiplies by the
 *    instance count. Moving this to Redis is a deployment-time change; the
 *    interface is shaped so only this file needs to change.
 */

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;
/** Backoff doubles per failure past the threshold, capped here. */
const DEFAULT_MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;
/** Upper bound on tracked accounts; oldest-touched is evicted first. */
const DEFAULT_MAX_ENTRIES = 10000;

function normalizeKey(email,) {
  return String(email || '',).trim().toLowerCase();
}

/**
 * @param {object} [options]
 * @param {number} [options.maxAttempts] failures tolerated before locking
 * @param {number} [options.lockoutMs] base lockout once the threshold is hit
 * @param {number} [options.maxLockoutMs] ceiling for the doubling backoff
 * @param {number} [options.maxEntries] cap on tracked accounts
 * @param {() => number} [options.now] injectable clock (tests)
 */
function createLoginThrottle({
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  lockoutMs = DEFAULT_LOCKOUT_MS,
  maxLockoutMs = DEFAULT_MAX_LOCKOUT_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
} = {},) {
  /** @type {Map<string, {failures: number, lockedUntil: number, lastAt: number}>} */
  const entries = new Map();

  /** Evict the least-recently-touched record when the map is at capacity. */
  function evictIfNeeded() {
    if (entries.size <= maxEntries) return;
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, entry,] of entries) {
      if (entry.lastAt < oldestAt) {
        oldestAt = entry.lastAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) entries.delete(oldestKey,);
  }

  /** Read a live record, dropping it if its lockout has since expired. */
  function entryFor(key,) {
    const entry = entries.get(key,);
    if (!entry) return null;
    if (entry.lockedUntil && entry.lockedUntil <= now()) {
      entries.delete(key,);
      return null;
    }
    return entry;
  }

  /**
   * @returns {{locked: boolean, retryAfterMs: number, failures: number}}
   */
  function status(email,) {
    const key = normalizeKey(email,);
    if (!key) return { locked: false, retryAfterMs: 0, failures: 0, };

    const entry = entryFor(key,);
    if (!entry?.lockedUntil) {
      return { locked: false, retryAfterMs: 0, failures: entry?.failures || 0, };
    }
    return {
      locked: true,
      retryAfterMs: Math.max(0, entry.lockedUntil - now(),),
      failures: entry.failures,
    };
  }

  /**
   * Record a failed attempt and return the resulting state.
   * @returns {{locked: boolean, retryAfterMs: number, failures: number}}
   */
  function recordFailure(email,) {
    const key = normalizeKey(email,);
    if (!key) return { locked: false, retryAfterMs: 0, failures: 0, };

    const entry = entryFor(key,) || { failures: 0, lockedUntil: 0, lastAt: 0, };
    entry.failures += 1;
    entry.lastAt = now();

    if (entry.failures >= maxAttempts) {
      // First lockout is `lockoutMs`; each further failure doubles it, so a
      // sustained attack degrades to a day-long lock while a user who
      // mistyped twice is barely affected.
      const over = entry.failures - maxAttempts;
      const backoff = Math.min(lockoutMs * 2 ** over, maxLockoutMs,);
      entry.lockedUntil = now() + backoff;
    }

    entries.set(key, entry,);
    evictIfNeeded();
    return {
      locked: Boolean(entry.lockedUntil,),
      retryAfterMs: entry.lockedUntil ? Math.max(0, entry.lockedUntil - now(),) : 0,
      failures: entry.failures,
    };
  }

  /** Clear the counter — call on a successful login. */
  function recordSuccess(email,) {
    const key = normalizeKey(email,);
    if (key) entries.delete(key,);
  }

  /** Drop every record whose lockout has expired. */
  function prune() {
    const cutoff = now();
    for (const [key, entry,] of entries) {
      if (entry.lockedUntil && entry.lockedUntil <= cutoff) entries.delete(key,);
    }
  }

  return {
    status,
    recordFailure,
    recordSuccess,
    prune,
    /** Diagnostics only. */
    size: () => entries.size,
    options: { maxAttempts, lockoutMs, maxLockoutMs, maxEntries, },
  };
}

module.exports = {
  createLoginThrottle,
  normalizeKey,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_LOCKOUT_MS,
};
