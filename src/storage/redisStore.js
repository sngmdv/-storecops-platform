"use strict";

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

const crypto = require("crypto");

// Try to load ioredis; fall back gracefully if not installed
let Redis;
try {
  Redis = require("ioredis");
} catch {
  Redis = null;
}

const DAY_MS = 86400000;

function createRedisClient(config) {
  if (!Redis) {
    console.warn("[Redis] ioredis not installed — falling back to in-memory store");
    return null;
  }

  const redisConfig = config.redis || {};
  
  // Build connection options
  const opts = {
    host: redisConfig.host || "127.0.0.1",
    port: redisConfig.port || 6379,
    password: redisConfig.password || undefined,
    keyPrefix: redisConfig.keyPrefix || "storecops:",
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
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
    });
  }

  if (redisConfig.tls) {
    opts.tls = {};
  }

  return new Redis(opts);
}

function createCollection(name, client, prefix) {
  const keyFor = (id) => `${prefix}${name}:${id}`;
  const indexKey = () => `${prefix}${name}:_index`;
  const ttlKey = () => `${prefix}${name}:_ttl`;

  return {
    name,

    async insert(doc) {
      const record = {
        _id: doc._id || crypto.randomUUID(),
        createdAt: doc.createdAt || new Date().toISOString(),
        ...doc,
      };

      try {
        const serialized = JSON.stringify(record);
        const pipeline = client.pipeline();
        
        // Store the record
        pipeline.hset(keyFor(record._id), "data", serialized);
        
        // Add to index
        pipeline.sadd(indexKey(), record._id);
        
        // Set TTL if configured (default 30 days for sessions)
        if (name === "sessions") {
          pipeline.expire(keyFor(record._id), 30 * 86400);
        }
        
        await pipeline.exec();
        return record;
      } catch (err) {
        console.error(`[Redis] insert error for ${name}:`, err.message);
        throw err;
      }
    },

    async findById(id) {
      try {
        const data = await client.hget(keyFor(id), "data");
        return data ? JSON.parse(data) : null;
      } catch (err) {
        console.error(`[Redis] findById error for ${name}:`, err.message);
        return null;
      }
    },

    async find(filter = {}) {
      try {
        const ids = await client.smembers(indexKey());
        if (ids.length === 0) return [];

        // Fetch all records in pipeline
        const pipeline = client.pipeline();
        for (const id of ids) {
          pipeline.hget(keyFor(id), "data");
        }
        const results = await pipeline.exec();
        
        const records = results
          .map(([err, data]) => {
            if (err || !data) return null;
            try {
              return JSON.parse(data);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        if (typeof filter === "function") {
          return records.filter(filter);
        }

        return records.filter((record) =>
          Object.entries(filter).every(([key, value]) => record[key] === value)
        );
      } catch (err) {
        console.error(`[Redis] find error for ${name}:`, err.message);
        return [];
      }
    },

    async findOne(filter = {}) {
      const matches = await this.find(filter);
      return matches[0] || null;
    },

    async update(id, patch) {
      try {
        const existing = await this.findById(id);
        if (!existing) return null;

        const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
        await client.hset(keyFor(id), "data", JSON.stringify(updated));
        return updated;
      } catch (err) {
        console.error(`[Redis] update error for ${name}:`, err.message);
        return null;
      }
    },

    async count() {
      try {
        return await client.scard(indexKey());
      } catch (err) {
        console.error(`[Redis] count error for ${name}:`, err.message);
        return 0;
      }
    },

    async clear() {
      try {
        const ids = await client.smembers(indexKey());
        if (ids.length === 0) return;

        const pipeline = client.pipeline();
        for (const id of ids) {
          pipeline.del(keyFor(id));
        }
        pipeline.del(indexKey());
        await pipeline.exec();
      } catch (err) {
        console.error(`[Redis] clear error for ${name}:`, err.message);
      }
    },
  };
}

// ─── Collections list (same as store.js) ──────────────────────────────────

const COLLECTIONS = [
  // Layer 1: Data Foundation
  "events", "customers", "competitorSnapshots", "externalSignals",
  "sentimentSamples", "inventory", "searchConsole", "competitorAds",
  "trackedCompetitors",
  // Layer 2: Intelligence
  "seoAudits", "seoOptimizations", "trendReports", "forecasts",
  // Layer 3: Decision
  "rules", "actions", "campaigns",
  // Layer 4: Execution
  "deliveries", "purchaseOrders", "retargetingAudiences",
  // Layer 5: Reporting
  "attributions", "reports",
  // Security & Administration
  "users", "auditLog", "sessions",
  // Store connections & public site audits
  "integrations", "siteAudits",
  // One-click platform connect (OAuth)
  "connectors", "oauthStates", "pendingConnections",
  // Consent & Messaging Compliance
  "consentRecords", "channelSuppressions", "emailSuppressions",
  // Billing & Entitlements
  "subscriptions",
  // Monitoring & Alerting
  "monitoringEvents",
  // Secret Rotation
  "secretLedger",
  // Deep Audit & PDF Reports
  "deepAudits", "reportRequests",
  // Retention Engine
  "retentionSnapshots",
  // Revenue Intelligence & Lead Management
  "leads",
  // Admin Intelligence
  "campaignActions",
  // Payment & Billing
  "invoices", "payments",
  // Notification Center
  "notifications",
  // Two-Factor Authentication
  "twoFactorSecrets",
  // Activity Log
  "activityLogs",
  // Webhook Retry Queue
  "webhookQueue",
  // Onboarding
  "onboardingStates",
  // Referrals (new)
  "referrals", "referralCredits", "affiliateLinks",
  // Trials (new)
  "trials",
];

/**
 * Create a Redis-backed store.
 * Falls back to in-memory if Redis is unavailable.
 */
function createStore(config) {
  const prefix = config?.redis?.keyPrefix || "storecops:";
  const client = createRedisClient(config);

  if (!client) {
    // Fall back to in-memory store
    const { createStore: createMemoryStore } = require("./store");
    console.log("[Storage] Using in-memory store (Redis unavailable)");
    return createMemoryStore();
  }

  // Connect to Redis
  client.connect().then(() => {
    console.log(`[Storage] Connected to Redis at ${config.redis?.host || "127.0.0.1"}:${config.redis?.port || 6379}`);
  }).catch((err) => {
    console.error(`[Storage] Redis connection failed:`, err.message);
    console.log("[Storage] Falling back to in-memory store");
  });

  const store = {};
  for (const name of COLLECTIONS) {
    store[name] = createCollection(name, client, prefix);
  }

  // Expose client for health checks and cleanup
  store._client = client;
  store._isRedis = true;

  return store;
}

module.exports = { createStore, createCollection, COLLECTIONS };
