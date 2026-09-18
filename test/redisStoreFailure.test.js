'use strict';

process.env.NODE_ENV = 'test';

/**
 * Redis storage failure contract.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * `redisStore.js` described itself as falling "back gracefully to in-memory if
 * Redis is unavailable", and on a failed connection it logged
 * `[Storage] Falling back to in-memory store`. It did **not** fall back: the
 * store returned was Redis-backed, and every write queued against a dead
 * connection. An operator reading that line would believe writes were being
 * kept in memory while they were in fact failing — the same family as the other
 * entries in the gaps ledger, a control that reports success it never verified.
 *
 * The two failures are genuinely different and must stay so:
 *
 *   - `ioredis` missing      -> `createRedisClient` returns null -> REAL fallback.
 *   - server unreachable     -> NO fallback. `ping()` does a real round-trip and
 *                               reports not-ok, so `/ready` answers 503. Falling
 *                               back here would accept writes a merchant believes
 *                               are durable and discard them on restart.
 *
 * Also pinned: the client carries an `error` listener. Without one, ioredis's
 * `silentEmit` prints the full stack trace on *every* reconnect attempt, and
 * `retryStrategy` repeats that every ~2s for as long as the outage lasts — so a
 * long outage floods the log with one identical trace. Measured on an
 * unreachable port over 4s: ~24 stderr lines before the listener existed, 3
 * after.
 *
 * The probe uses port 1 on loopback, which nothing listens on, so the failure is
 * an immediate ECONNREFUSED rather than a timeout.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs',);
const path = require('node:path',);

const redisStore = require('../src/storage/redisStore',);
const { createStore, COLLECTIONS, } = require('../src/storage/store',);

const UNREACHABLE = { host: '127.0.0.1', port: 1, keyPrefix: 'storecops-test:', };

/** Build a store against a port that refuses connections. */
function unreachableStore() {
  return redisStore.createStore({ redis: UNREACHABLE, sessionTtlDays: 7, },);
}

test('an unreachable Redis does NOT fall back to the in-memory adapter', async () => {
  const store = unreachableStore();
  try {
    assert.strictEqual(
      store._isRedis,
      true,
      'the store must stay Redis-backed — falling back would accept writes that '
        + 'are then lost on restart',
    );
    assert.ok(store._client, 'the Redis client must still be the backing connection',);

    // All collections still exist, so the failure surfaces as failing writes
    // rather than as `store.returns is undefined` TypeErrors.
    for (const name of COLLECTIONS) {
      assert.ok(store[name], `collection "${name}" must be present on the Redis store`,);
    }
  } finally {
    store._client.disconnect();
  }
});

test('ping() answers not_ok instead of throwing, so /ready can refuse traffic', async () => {
  const store = unreachableStore();
  try {
    const result = await store.ping();
    assert.strictEqual(result.ok, false, 'an unreachable Redis must not report ok',);
    assert.strictEqual(result.backend, 'redis', 'the backend is still redis — it did not fall back',);
    assert.ok(result.error, 'the reason must be reported for the response body',);
  } finally {
    store._client.disconnect();
  }
});

test('the Redis client carries an error listener, bounding the reconnect log', async () => {
  const store = unreachableStore();
  try {
    assert.ok(
      store._client.listenerCount('error',) > 0,
      'without an error listener ioredis logs a full stack trace on every reconnect '
        + 'attempt, which a long outage repeats every ~2s indefinitely',
    );
    assert.ok(
      store._client.listenerCount('ready',) > 0,
      'recovery must be reported too, otherwise the log only ever shows failures',
    );
  } finally {
    store._client.disconnect();
  }
});

test('control: the in-memory adapter is distinguishable, so the flag is not vacuous', () => {
  // If every adapter carried `_isRedis` (or none did), the assertion above would
  // pass without proving anything about which adapter came back.
  const memory = createStore();
  assert.notStrictEqual(memory._isRedis, true, 'the in-memory store must not claim to be Redis',);
  assert.strictEqual(memory._client, undefined, 'the in-memory store must expose no client',);
});

test('control: the source no longer claims a fallback it does not perform', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'storage', 'redisStore.js',), 'utf8',);
  assert.ok(
    !src.includes('[Storage] Falling back to in-memory store',),
    'the misleading connection-failure log line is back',
  );
  assert.ok(
    !src.includes('Falls back gracefully to in-memory if Redis is unavailable',),
    'the header must not claim unconditional fallback — only the missing-ioredis '
      + 'case falls back',
  );
});