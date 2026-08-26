"use strict";

/**
 * Full Store Data Export — GDPR compliance & merchant data portability.
 *
 * Exports ALL data for a connected store: customers, events, orders,
 * campaigns, SEO audits, competitor snapshots, invoices, consent records.
 * Returns a structured JSON bundle suitable for download or email delivery.
 *
 * Also supports selective export (just customers, just events, etc.)
 * and anonymized export (PII masked for internal analysis).
 */

const crypto = require("crypto");

/** Mask PII fields in a record. */
function maskPII(record, fields = ["email", "phone", "identity", "name", "address"]) {
  const masked = { ...record };
  for (const field of fields) {
    if (masked[field] && typeof masked[field] === "string") {
      if (field === "email") {
        const [local, domain] = masked[field].split("@");
        masked[field] = `${local.charAt(0)}***@${domain?.charAt(0) || "*"}***`;
      } else if (field === "phone") {
        masked[field] = masked[field].slice(0, 3) + "***" + masked[field].slice(-2);
      } else {
        masked[field] = masked[field].slice(0, 2) + "***";
      }
    }
  }
  return masked;
}

function createDataExportService({ store }) {
  return {
    /**
     * Export all data for a store. Returns a comprehensive JSON bundle.
     * @param {string} store_id
     * @param {object} [options]
     * @param {boolean} [options.anonymize] — mask PII in the export
     * @param {string[]} [options.collections] — limit to specific collections
     * @param {string} [options.since] — ISO date filter
     */
    async exportStoreData(store_id, { anonymize = false, collections = null, since = null } = {}) {
      if (!store_id) throw new Error("store_id is required");

      const allCollections = {
        customers: () => store.customers.find({ store_id }),
        events: () => store.events.find((e) => e.store_id === store_id && (!since || e.timestamp >= since)),
        deliveries: () => store.deliveries.find((d) => d.store_id === store_id && (!since || d.createdAt >= since)),
        campaigns: () => store.campaigns.find({ store_id }),
        seoAudits: () => store.seoAudits.find({ store_id }),
        seoOptimizations: () => store.seoOptimizations.find({ store_id }),
        competitorSnapshots: () => store.competitorSnapshots.find({ store_id }),
        inventory: () => store.inventory.find({ store_id }),
        consentRecords: () => store.consentRecords.find({ store_id }),
        subscriptions: () => store.subscriptions.find({ store_id }),
        invoices: () => store.invoices.find({ store_id }),
        payments: () => store.payments.find({ store_id }),
        integrations: () => store.integrations.find({ store_id }),
        reports: () => store.reports.find({ store_id }),
        attributions: () => store.attributions.find({ store_id }),
        retentionSnapshots: () => store.retentionSnapshots.find({ store_id }),
      };

      const selected = collections
        ? Object.fromEntries(Object.entries(allCollections).filter(([k]) => collections.includes(k)))
        : allCollections;

      const bundle = {
        store_id,
        exported_at: new Date().toISOString(),
        format_version: "1.0",
        collections: {},
      };

      let totalRecords = 0;
      for (const [name, fetchFn] of Object.entries(selected)) {
        let records = await fetchFn();
        if (anonymize) {
          records = records.map((r) => maskPII(r));
        }
        bundle.collections[name] = records;
        totalRecords += records.length;
      }

      bundle.total_records = totalRecords;
      bundle.total_collections = Object.keys(bundle.collections).length;

      // Track the export in activity log.
      await store.activityLogs?.insert({
        store_id,
        actor: "system",
        action: "data_exported",
        target: store_id,
        detail: { total_records: totalRecords, anonymized: anonymize, collections: Object.keys(selected) },
        at: new Date().toISOString(),
      });

      return bundle;
    },

    /**
     * Generate a summary of what data exists for a store (pre-export preview).
     */
    async previewStoreData(store_id) {
      if (!store_id) throw new Error("store_id is required");

      const counts = {};
      const collectionNames = [
        "customers", "events", "deliveries", "campaigns", "seoAudits",
        "competitorSnapshots", "inventory", "consentRecords", "subscriptions",
        "invoices", "payments", "integrations", "reports",
      ];

      for (const name of collectionNames) {
        const collection = store[name];
        if (collection) {
          const records = await collection.find(
            name === "events" ? (e) => e.store_id === store_id :
            name === "deliveries" ? (d) => d.store_id === store_id :
            { store_id }
          );
          counts[name] = records.length;
        }
      }

      return {
        store_id,
        preview_at: new Date().toISOString(),
        collection_counts: counts,
        total_records: Object.values(counts).reduce((sum, c) => sum + c, 0),
      };
    },

    /**
     * Export a single customer's data (GDPR Article 20 — data portability).
     */
    async exportCustomerData(store_id, customer_id) {
      if (!store_id || !customer_id) throw new Error("store_id and customer_id are required");

      const [profile, events, deliveries, consentRecords] = await Promise.all([
        store.customers.findOne({ store_id, identity: customer_id }),
        store.events.find((e) => e.store_id === store_id && (e.customer_id === customer_id || e.email === customer_id)),
        store.deliveries.find((d) => d.store_id === store_id && d.customer_id === customer_id),
        store.consentRecords.find((c) => c.store_id === store_id && c.customer_id === customer_id),
      ]);

      return {
        store_id,
        customer_id,
        exported_at: new Date().toISOString(),
        profile: profile || null,
        events,
        deliveries,
        consent_records: consentRecords,
        total_records: events.length + deliveries.length + consentRecords.length + (profile ? 1 : 0),
      };
    },

    /**
     * Generate a downloadable JSON file content (for API response).
     */
    async generateExportFile(store_id, options = {}) {
      const bundle = await this.exportStoreData(store_id, options);
      const json = JSON.stringify(bundle, null, 2);
      const filename = `storecops-export-${store_id}-${Date.now()}.json`;

      return {
        filename,
        content: json,
        size_bytes: Buffer.byteLength(json),
        content_type: "application/json",
      };
    },
  };
}

module.exports = { createDataExportService, maskPII };
