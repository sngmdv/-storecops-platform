'use strict';

/**
 * Redis-backed storage adapter.
 *
 * Falls back gracefully to in-memory if Redis is unavailable.
 * Uses Redis HASH for collections, supporting the same CRUD surface
 * as the in-memory and SQLite stores.
 *
 * Environment variables:
 *   REDIS_URL        - Full Redis URL (redis://user:pass@host:port/db)
 *   REDIS_HOST       - Redis host (default: 127.0.0.1)
 *   REDIS_PORT       - Redis port (default: 6379)
 *   REDIS_PASSWORD   - Redis password
 *   REDIS_TLS        - Enable TLS (default: false)
 *   REDIS_KEY_PREFIX - Key prefix (default: storecops:)
 */

const crypto = require('crypto',);
const { COLLECTIONS, } = require('./store',);

// Try to load ioredis; fall back gracefully if not installed
let Redis;
try {
  Redis = require('ioredis',);
} catch {
  Redis = null;
}

function createRedisClient(config,) {
  if (!Redis) {
    console.warn('[Redis] ioredis not installed — falling back to in-memory store',);
    return null;
  }

  const redisConfig = config.redis || {};
  
  // Build connection options
  const opts = {
    host: redisConfig.host || '127.0.0.1',
    port: redisConfig.port || 6379,
    password: redisConfig.password || undefined,
    keyPrefix: redisConfig.keyPrefix || 'storecops:',
    retryStrategy(times,) {
      const delay = Math.min(times * 50, 2000,);
      return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  };

  // Use URL if provided (overrides individual options)
  if (redisConfig.url) {
    return new Redis(redisConfig.url, {
      ...opts,
      tls: redisConfig.tls ? {} : undefined,
    },);
  }

  if (redisConfig.tls) {
    opts.tls = {};
  }

  return new Redis(opts,);
}

function createCollection(name, client, prefix, { sessionTtlSeconds, } = {},) {
  const keyFor = (id,) => `${prefix}${name}:${id}`;
  const indexKey = () => `${prefix}${name}:_index`;

  return {
    name,

    async insert(doc,) {
      const record = {
        _id: doc._id || crypto.randomUUID(),
        createdAt: doc.createdAt || new Date().toISOString(),
        ...doc,
      };

      try {
        const serialized = JSON.stringify(record,);
        const pipeline = client.pipeline();
        
        // Store the record
        pipeline.hset(keyFor(record._id,), 'data', serialized,);
        
        // Add to index
        pipeline.sadd(indexKey(), record._id,);
        
        // Session rows get a Redis TTL so abandoned sessions are reclaimed.
        // The value MUST come from the app's own `SESSION_TTL_DAYS`: this was
        // hardcoded to 30 days while `sessions.expires_at` was written from a
        // 7-day config, so every session row outlived the expiry the rest of
        // the system believed in by 23 days.
        if (name === 'sessions' && sessionTtlSeconds > 0) {
          pipeline.expire(keyFor(record._id,), sessionTtlSeconds,);
        }
        
        await pipeline.exec();
        return record;
      } catch (err) {
        console.error(`[Redis] insert error for ${name}:`, err.message,);
        throw err;
      }
    },

    async findById(id,) {
      try {
        const data = await client.hget(keyFor(id,), 'data',);
        return data ? JSON.parse(data,) : null;
      } catch (err) {
        console.error(`[Redis] findById error for ${name}:`, err.message,);
        return null;
      }
    },

    async find(filter = {},) {
      try {
        const ids = await client.smembers(indexKey(),);
        if (ids.length === 0) return [];

        // Fetch all records in pipeline
        const pipeline = client.pipeline();
        for (const id of ids) {
          pipeline.hget(keyFor(id,), 'data',);
        }
        const results = await pipeline.exec();
        
        const records = results
          .map(([err, data,],) => {
            if (err || !data) return null;
            try {
              return JSON.parse(data,);
            } catch {
              return null;
            }
          },)
          .filter(Boolean,);

        if (typeof filter === 'function') {
          return records.filter(filter,);
        }

        return records.filter((record,) =>
          Object.entries(filter,).every(([key, value,],) => record[key] === value,),
        );
      } catch (err) {
        console.error(`[Redis] find error for ${name}:`, err.message,);
        return [];
      }
    },

    async findOne(filter = {},) {
      const matches = await this.find(filter,);
      return matches[0] || null;
    },

    async update(id, patch,) {
      try {
        const existing = await this.findById(id,);
        if (!existing) return null;

        const updated = { ...existing, ...patch, updatedAt: new Date().toISOString(), };
        await client.hset(keyFor(id,), 'data', JSON.stringify(updated,),);
        return updated;
      } catch (err) {
        console.error(`[Redis] update error for ${name}:`, err.message,);
        return null;
      }
    },

    async updateMany(filter, patch,) {
      const matches = await this.find(filter,);
      const results = [];
      for (const doc of matches) {
        const updated = { ...doc, ...patch, updatedAt: new Date().toISOString(), };
        await client.hset(keyFor(doc._id,), 'data', JSON.stringify(updated,),);
        results.push(updated,);
      }
      return results;
    },

    async delete(id,) {
      try {
        const pipeline = client.pipeline();
        pipeline.del(keyFor(id,),);
        pipeline.srem(indexKey(), id,);
        await pipeline.exec();
        return true;
      } catch (err) {
        console.error(`[Redis] delete error for ${name}:`, err.message,);
        return false;
      }
    },

    async deleteMany(filter,) {
      const matches = await this.find(filter,);
      if (matches.length === 0) return 0;

      const pipeline = client.pipeline();
      for (const doc of matches) {
        pipeline.del(keyFor(doc._id,),);
        pipeline.srem(indexKey(), doc._id,);
      }
      await pipeline.exec();
      return matches.length;
    },

    async count(filter,) {
      try {
        if (!filter || Object.keys(filter,).length === 0) return await client.scard(indexKey(),);
        // Filtered counts fall back to reading the matches. The SQLite adapter
        // pushes the filter into SQL; this adapter must not answer with the
        // unfiltered cardinality or the three stores disagree silently.
        return (await this.find(filter,)).length;
      } catch (err) {
        console.error(`[Redis] count error for ${name}:`, err.message,);
        return 0;
      }
    },

    async clear() {
      try {
        const ids = await client.smembers(indexKey(),);
        if (ids.length === 0) return;

        const pipeline = client.pipeline();
        for (const id of ids) {
          pipeline.del(keyFor(id,),);
        }
        pipeline.del(indexKey(),);
        await pipeline.exec();
      } catch (err) {
        console.error(`[Redis] clear error for ${name}:`, err.message,);
      }
    },
  };
}

// ─── Collections list ─────────────────────────────────────────────────────
//
// Derived from `store.js`, NOT maintained here.
//
// This file used to carry its own copy under a comment that said "same as
// store.js" — which is exactly the drift risk, and it had drifted in both
// directions: six real collections were missing (supportTickets, marketingSpend,
// featureUsage, returns, returnAuditLog, passwordResets) and four collections
// that exist nowhere in the schema were present (referrals, referralCredits,
// affiliateLinks, trials).
//
// The consequence was not cosmetic. `privacy.js` skips a collection it cannot
// find (`if (!collection) continue`), so under `STORAGE=redis` a shop/redact
// silently left six collections un-purged, and password reset threw on
// `store.passwordResets.insert`. A missing collection degrades quietly rather
// than loudly.
//
// `sqliteStore.js` already imports this list from `store.js`; this now matches.

/**
 * Create a Redis-backed store.
 * Falls back to in-memory if Redis is unavailable.
 */
function createStore(config,) {
  const prefix = config?.redis?.keyPrefix || 'storecops:';
  const client = createRedisClient(config,);

  if (!client) {
    // Fall back to in-memory store
    const { createStore: createMemoryStore, } = require('./store',);
    console.log('[Storage] Using in-memory store (Redis unavailable)',);
    return createMemoryStore();
  }

  // Connect to Redis
  client.connect().then(() => {
    console.log(`[Storage] Connected to Redis at ${config.redis?.host || '127.0.0.1'}:${config.redis?.port || 6379}`,);
  },).catch((err,) => {
    console.error('[Storage] Redis connection failed:', err.message,);
    console.log('[Storage] Falling back to in-memory store',);
  },);

  // Sessions are the only collection with a storage-level TTL, and it is
  // derived from the same config the app writes `expires_at` from.
  const sessionTtlDays = Number(config?.sessionTtlDays || 7,);
  const sessionTtlSeconds = sessionTtlDays * 86400;

  const store = {};
  for (const name of COLLECTIONS) {
    store[name] = createCollection(name, client, prefix, { sessionTtlSeconds, },);
  }

  // Expose client for health checks and cleanup
  store._client = client;
  store._isRedis = true;

  /**
   * Readiness probe (DEP-003). `ioredis` connects lazily and retries in the
   * background, so a store can exist and answer CRUD calls from its own queue
   * while the connection is in fact down. Only an actual round-trip to the
   * server distinguishes "connected" from "configured".
   *
   * Never throws — the failure reason belongs in the response body.
   */
  store.ping = async () => {
    try {
      const pong = await client.ping();
      return { ok: pong === 'PONG', backend: 'redis', };
    } catch (err) {
      return { ok: false, backend: 'redis', error: err.message, };
    }
  };

  /**
   * Graceful shutdown (OBS-001). `ioredis` holds an open socket and retries in
   * the background, so without an explicit `quit()` the process cannot exit on
   * its own and the orchestrator is forced to SIGKILL it. `quit()` is preferred
   * over `disconnect()` because it lets in-flight commands finish.
   *
   * Never throws — a store that is already down must not block shutdown.
   */
  store.close = async () => {
    try {
      await client.quit();
      return { ok: true, backend: 'redis', };
    } catch (err) {
      return { ok: false, backend: 'redis', error: err.message, };
    }
  };

  return store;
}

module.exports = { createStore, createCollection, COLLECTIONS, };
