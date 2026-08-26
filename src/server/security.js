"use strict";

/**
 * Security & Administration (Category 10).
 *
 *   - Role-Based Access Control (10.1)
 *   - Immutable audit log       (10.2)
 *   - GDPR/CCPA data export     (10.3)
 *   - Webhook signature check   (10.4)
 *   - API rate limiting         (10.5)
 */

const crypto = require("crypto");

const ROLES = ["admin", "manager", "viewer"];

// What each role may do. Mutating = POST/PUT/DELETE on non-report routes.
const ROLE_PERMISSIONS = {
  admin: { read: true, mutate: true, administer: true },
  manager: { read: true, mutate: true, administer: false },
  viewer: { read: true, mutate: false, administer: false },
};

/** 10.2 — append-only audit log of administrative actions. */
function createAuditLog({ store }) {
  return {
    async record(actor, action, detail = {}) {
      return store.auditLog.insert({
        actor,
        action,
        detail,
        at: new Date().toISOString(),
      });
    },

    async entries(store_id = null, limit = 100) {
      const entries = await store.auditLog.find(
        store_id ? (entry) => entry.detail?.store_id === store_id : () => true
      );
      return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
    },
  };
}

/** 10.1 — RBAC over a tiny user directory. */
function createRbac({ store, auditLog }) {
  return {
    ROLES,

    /** Create a platform user: { email, role }. First user is always admin. */
    async createUser({ email, role = "viewer" }) {
      if (!email) throw new Error("email is required.");
      if (!ROLES.includes(role)) throw new Error(`role must be one of: ${ROLES.join(", ")}`);

      const existing = await store.users.findOne({ email });
      if (existing) throw new Error("User already exists.");

      const count = await store.users.count();
      const effectiveRole = count === 0 ? "admin" : role;
      const user = await store.users.insert({ email, role: effectiveRole, created_at: new Date().toISOString() });
      await auditLog.record(email, "user_created", { role: effectiveRole });
      return user;
    },

    async users() {
      return store.users.find({});
    },

    /**
     * Express middleware. The acting identity comes from the gateway
     * (req.authUser, set by API-key/bearer auth) or the X-User header.
     * When no users exist yet (fresh install), every caller is treated
     * as admin so bootstrapping works.
     */
    middleware(requiredPermission) {
      return async (req, res, next) => {
        const allUsers = await store.users.find({});
        if (allUsers.length === 0) return next(); // bootstrap mode

        const email = req.get("X-User") || req.authUser?.email;
        const user = email ? await store.users.findOne({ email }) : null;

        if (!user) {
          // Gateway-authenticated identity without a directory entry
          // (e.g. the master API key) — trust its role directly.
          if (req.authUser?.role && ROLE_PERMISSIONS[req.authUser.role]) {
            req.user = req.authUser;
            return next();
          }
          return res.status(403).json({ error: "Unknown user. Provide a valid X-User header." });
        }

        const permissions = ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS.viewer;
        if (!permissions[requiredPermission]) {
          await auditLog.record(email, "access_denied", {
            permission: requiredPermission,
            path: req.originalUrl,
          });
          return res.status(403).json({ error: `Role "${user.role}" cannot ${requiredPermission}.` });
        }

        req.user = user;
        next();
      };
    },
  };
}

/** 10.5 — sliding-window rate limiter per API key/IP. */
function createRateLimiter({ windowMs = 60000, max = 300, maxKeys = 10000 } = {}) {
  const hits = new Map();

  // Evict stale entries so one-off keys can't grow memory without bound.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of hits) {
      const fresh = timestamps.filter((at) => at > cutoff);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }, windowMs);
  if (typeof sweeper.unref === "function") sweeper.unref();

  return (req, res, next) => {
    const key = req.get("X-API-Key") || req.ip || "anonymous";
    const now = Date.now();

    // Hard cap on tracked keys: drop the oldest entry before adding one.
    if (hits.size >= maxKeys && !hits.has(key)) {
      hits.delete(hits.keys().next().value);
    }

    const windowStart = now - windowMs;
    const timestamps = (hits.get(key) || []).filter((at) => at > windowStart);
    timestamps.push(now);
    hits.set(key, timestamps);

    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(Math.max(0, max - timestamps.length)));

    if (timestamps.length > max) {
      return res.status(429).json({ error: "Rate limit exceeded. Slow down and retry." });
    }
    next();
  };
}

/** 10.4 — HMAC-SHA256 webhook signature verification. */
function signBody(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function webhookVerifier(secret, headerName = "x-storecops-signature") {
  return (req, res, next) => {
    if (!secret) return next(); // verification disabled

    const provided = req.get(headerName);
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    const expected = Buffer.from(signBody(secret, rawBody));
    const received = Buffer.from(provided || "");
    const valid =
      received.length === expected.length && crypto.timingSafeEqual(received, expected);
    if (!valid) {
      return res.status(401).json({ error: "Invalid webhook signature." });
    }
    next();
  };
}

/** 10.3 — GDPR/CCPA: export everything we hold about a customer. */
async function exportCustomerData({ store }, store_id, customer_id) {
  const [profile, events, deliveries] = await Promise.all([
    store.customers.findOne({ store_id, identity: customer_id }),
    store.events.find(
      (e) => e.store_id === store_id && (e.customer_id === customer_id || e.email === customer_id)
    ),
    store.deliveries.find((d) => d.store_id === store_id && d.customer_id === customer_id),
  ]);

  return {
    store_id,
    customer_id,
    exported_at: new Date().toISOString(),
    profile: profile || null,
    events,
    deliveries,
    total_records: events.length + deliveries.length + (profile ? 1 : 0),
  };
}

/** 10.3 — right to be forgotten: anonymize profile + scrub identifiers. */
async function deleteCustomerData({ store }, store_id, customer_id) {
  const profile = await store.customers.findOne({ store_id, identity: customer_id });

  const events = await store.events.find(
    (e) => e.store_id === store_id && (e.customer_id === customer_id || e.email === customer_id)
  );
  for (const event of events) {
    await store.events.update(event._id, { customer_id: "anon", email: null });
  }

  // Deliveries and queued actions also carry the identifier — scrub them too.
  const deliveries = await store.deliveries.find(
    (d) => d.store_id === store_id && d.customer_id === customer_id
  );
  for (const delivery of deliveries) {
    await store.deliveries.update(delivery._id, { customer_id: "anon" });
  }
  const actions = await store.actions.find(
    (a) => a.store_id === store_id && a.customer_id === customer_id
  );
  for (const action of actions) {
    await store.actions.update(action._id, { customer_id: "anon" });
  }

  let anonymized = null;
  if (profile) {
    anonymized = await store.customers.update(profile._id, {
      identity: `anon:${profile._id}`,
      email: null,
      viewed_products: [],
      channels_responded: [],
      gdpr_deleted: true,
    });
  }

  return {
    store_id,
    customer_id,
    anonymized: !!anonymized,
    events_scrubbed: events.length,
    deliveries_scrubbed: deliveries.length,
    actions_scrubbed: actions.length,
  };
}

module.exports = {
  ROLES,
  ROLE_PERMISSIONS,
  createAuditLog,
  createRbac,
  createRateLimiter,
  webhookVerifier,
  signBody,
  exportCustomerData,
  deleteCustomerData,
};
