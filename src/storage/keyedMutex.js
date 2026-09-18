'use strict';

/**
 * A keyed async mutex — serialize read-modify-write sequences per key.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several services do a read-modify-write across an `await`:
 *
 *     const entry = await store.inventory.findOne({ store_id, product_id });
 *     if (!entry) await store.inventory.insert({ ..., stock: 0 });
 *     await store.inventory.update(entry._id, { stock: entry.stock - qty });
 *
 * Between the read and the write the event loop is free to run other work, so
 * two concurrent sales of the same product both read `stock = 5`, both compute
 * `4`, and both write `4` — one sale is silently lost. Worse, if neither finds
 * an entry they both insert, producing two inventory rows for one product.
 *
 * WHY A MUTEX RATHER THAN A SQL TRANSACTION
 * -----------------------------------------
 * The store is pluggable (`store.js` in-memory, `sqliteStore.js`,
 * `redisStore.js`) and its interface is async with no transaction primitive.
 * A `BEGIN`/`COMMIT` fix would only work on the SQLite adapter and would be
 * wrong for the other two, so it would fix the smallest deployment and leave
 * the others broken. Serializing at the service layer is adapter-independent:
 * it holds for all three, and it holds for any adapter added later.
 *
 * SCOPE AND LIMITS
 * ----------------
 * This serializes within ONE process. Two app instances sharing a database can
 * still interleave, because each has its own mutex. That is a real limit and it
 * is stated rather than hidden; a genuinely multi-writer deployment needs the
 * database to enforce it (a conditional update, or a unique constraint on
 * `(store_id, product_id)`).
 *
 * The map is bounded by the number of keys currently in flight: an entry is
 * removed as soon as its chain drains, so it cannot grow without limit.
 */

function createKeyedMutex() {
  /** key -> promise that settles when the last queued holder releases. */
  const tails = new Map();

  return {
    /**
     * Run `fn` with exclusive access to `key`. Returns whatever `fn` returns,
     * and propagates its rejection after releasing the key.
     */
    async run(key, fn,) {
      const previous = tails.get(key,) || Promise.resolve();

      let release;
      const held = new Promise((resolve,) => { release = resolve; },);

      // The tail must never reject: if it did, every later waiter would
      // inherit the rejection instead of simply waiting its turn.
      const tail = previous.then(() => held, () => held,);
      tails.set(key, tail,);

      await previous.catch(() => {},);

      try {
        return await fn();
      } finally {
        release();
        // Only the last holder clears the key, so a waiter that queued while
        // we ran is not orphaned.
        if (tails.get(key,) === tail) tails.delete(key,);
      }
    },

    /** Number of keys with work in flight — for tests and diagnostics. */
    size() {
      return tails.size;
    },
  };
}

module.exports = { createKeyedMutex, };
