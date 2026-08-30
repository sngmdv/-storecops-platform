"use strict";

const crypto = require("crypto");

/**
 * Pluggable storage layer.
 *
 * The platform ships with an in-memory store so it boots anywhere with
 * zero infrastructure. Collections expose a small async CRUD surface that
 * a Mongo/Postgres adapter can implement identically later.
 */

const COLLECTION_CAPS = {
  events: 3000,
  actions: 1000,
  deliveries: 1000,
  competitorSnapshots: 200,
  externalSignals: 500,
  sentimentSamples: 200,
  competitorAds: 100,
  monitoringEvents: 300,
  notifications: 400,
  activityLogs: 500,
  retargetingAudiences: 100,
  attributions: 50,
  reports: 50,
  seoAudits: 100,
  siteAudits: 200,
  campaignActions: 200,
  supportTickets: 300,
  featureUsage: 500,
  marketingSpend: 200,
};

function createCollection(name) {
  const records = new Map();
  const cap = COLLECTION_CAPS[name] || 0;

  function evict() {
    if (cap <= 0 || records.size <= cap) return;
    const excess = records.size - cap;
    let deleted = 0;
    for (const key of records.keys()) {
      if (deleted >= excess) break;
      records.delete(key);
      deleted++;
    }
  }

  return {
    name,

    async insert(doc) {
      const record = {
        _id: doc._id || crypto.randomUUID(),
        createdAt: doc.createdAt || new Date().toISOString(),
        ...doc,
      };
      records.set(record._id, record);
      evict();
      return record;
    },

    async findById(id) {
      return records.get(id) || null;
    },

    async find(filter = {}) {
      if (typeof filter === "function") {
        const result = [];
        for (const record of records.values()) {
          if (filter(record)) result.push(record);
        }
        return result;
      }

      const filterKeys = Object.entries(filter);
      const result = [];
      for (const record of records.values()) {
        if (filterKeys.every(([key, value]) => record[key] === value)) {
          result.push(record);
        }
      }
      return result;
    },

    async findOne(filter = {}) {
      if (typeof filter === "function") {
        for (const record of records.values()) {
          if (filter(record)) return record;
        }
        return null;
      }
      const filterKeys = Object.entries(filter);
      for (const record of records.values()) {
        if (filterKeys.every(([key, value]) => record[key] === value)) return record;
      }
      return null;
    },

    async update(id, patch) {
      const existing = records.get(id);
      if (!existing) return null;

      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      records.set(id, updated);
      return updated;
    },

    async count() {
      return records.size;
    },

    async clear() {
      records.clear();
    },
  };
}

/**
 * Every collection the platform uses, in one place — both the
 * in-memory store and the SQLite adapter build these identically.
 */
const COLLECTIONS = [
  // Layer 1: Data Foundation
  "events", // append-only event log
  "customers", // unified customer profiles
  "competitorSnapshots",
  "externalSignals",
  "sentimentSamples",
  "inventory", // live stock ledger
  "searchConsole", // GSC/SEO performance data
  "competitorAds", // ad-library snapshots
  "trackedCompetitors", // competitor configs (URLs, page IDs, scrape status)

  // Layer 2: Intelligence
  "seoAudits",
  "seoOptimizations", // generated SEO + AI fix packages
  "trendReports",
  "forecasts",

  // Layer 3: Decision
  "rules",
  "actions",
  "campaigns", // generated campaign drafts

  // Layer 4: Execution
  "deliveries",
  "purchaseOrders", // supplier POs
  "retargetingAudiences",

  // Layer 5: Reporting
  "attributions",
  "reports",

  // Security & Administration
  "users", // RBAC accounts (signup users land here too)
  "auditLog", // immutable admin actions
  "sessions", // bearer-token login sessions

  // Store connections & public site audits
  "integrations", // connected stores (Shopify/Woo/webhook/CSV)
  "siteAudits", // free no-signup store audit reports

  // One-click platform connect (OAuth)
  "connectors", // platform app credentials (client id/secret)
  "oauthStates", // in-flight OAuth handshakes (CSRF state)
  "pendingConnections", // authorized stores waiting for signup to finish

  // Consent & Messaging Compliance (Tasks 30-40)
  "consentRecords", // customer consent categories per installation
  "channelSuppressions", // per-channel opt-out (WhatsApp, email, push)
  "emailSuppressions", // global do-not-send email list

  // Billing & Entitlements (Tasks 41-45)
  "subscriptions", // Shopify Billing subscription records

  // Monitoring & Alerting (Task 65)
  "monitoringEvents", // webhook/worker/token/message failure events

  // Secret Rotation (Task 27)
  "secretLedger", // fingerprint-only secret lifecycle tracking

  // Deep Audit & PDF Reports
  "deepAudits", // comprehensive multi-page store audits
  "reportRequests", // PDF report generation & delivery tracking

  // Retention Engine
  "retentionSnapshots", // historical retention metric snapshots

  // Revenue Intelligence & Lead Management
  "leads", // captured leads from audits, landing pages, etc.

  // Admin Intelligence
  "campaignActions", // admin campaign/outreach tracking

  // Payment & Billing
  "invoices", // generated invoices with GST
  "payments", // webhook payment events

  // Notification Center
  "notifications", // in-app merchant notifications

  // Two-Factor Authentication
  "twoFactorSecrets", // TOTP secrets per user

  // Activity Log (enhanced audit trail)
  "activityLogs", // business-level activity entries

  // Webhook Retry Queue
  "webhookQueue", // outbound webhook delivery queue

  // Onboarding
  "onboardingStates", // per-store onboarding progress

  // Support Tickets
  "supportTickets", // customer support tickets

  // Marketing & CAC Tracking
  "marketingSpend", // marketing spend records

  // Feature Adoption
  "featureUsage", // per-store feature usage tracking
];

/**
 * Database facade: one collection per domain concept across all layers.
 */
function createStore() {
  const store = {};
  for (const name of COLLECTIONS) store[name] = createCollection(name);
  return store;
}

module.exports = { createStore, createCollection, COLLECTIONS };
