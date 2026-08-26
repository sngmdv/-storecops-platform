"use strict";

/**
 * Activity Log — enhanced audit trail for all platform actions.
 *
 * Every mutation (create, update, delete, login, export, config change)
 * is recorded with actor, action, target, IP, user-agent, and diff.
 * Supports filtering, search, and export for compliance.
 *
 * This is distinct from the low-level auditLog in security.js —
 * activityLog captures business-level events with richer context.
 */

const crypto = require("crypto");

const ACTION_TYPES = [
  // Auth
  "login", "logout", "signup", "login_failed", "2fa_enabled", "2fa_disabled",
  // Store
  "store_connected", "store_disconnected", "store_updated",
  // Billing
  "plan_changed", "subscription_created", "subscription_cancelled", "payment_received", "refund_issued",
  // SEO
  "seo_audit_run", "seo_fix_applied", "seo_fix_reverted",
  // Campaigns
  "campaign_created", "campaign_sent", "campaign_paused",
  // Data
  "data_exported", "data_deleted", "customer_redacted",
  // Settings
  "settings_updated", "api_key_rotated", "webhook_configured",
  // Admin
  "admin_action", "user_role_changed", "feature_toggled",
  // Integration
  "integration_connected", "integration_disconnected",
];

function createActivityLog({ store }) {
  return {
    ACTION_TYPES,

    /**
     * Record an activity entry.
     * @param {object} params
     * @param {string} params.store_id — tenant
     * @param {string} params.actor    — who performed the action (email or system)
     * @param {string} params.action   — from ACTION_TYPES
     * @param {string} [params.target] — what was affected (resource ID, email, etc.)
     * @param {object} [params.detail] — structured data about the action
     * @param {object} [params.diff]   — before/after for config changes
     * @param {string} [params.ip]     — client IP
     * @param {string} [params.ua]     — user-agent
     */
    async record({ store_id, actor, action, target, detail, diff, ip, ua }) {
      if (!store_id) throw new Error("store_id is required");
      if (!actor) throw new Error("actor is required");
      if (!action) throw new Error("action is required");

      return store.activityLogs.insert({
        store_id,
        actor,
        action,
        target: target || null,
        detail: detail || {},
        diff: diff || null,
        ip: ip || null,
        ua: ua ? ua.slice(0, 200) : null,
        at: new Date().toISOString(),
      });
    },

    /**
     * Record activity from an Express request (auto-extracts IP, UA, actor).
     */
    async recordFromRequest(req, { store_id, action, target, detail, diff }) {
      const actor = req.authUser?.email || req.user?.email || "unknown";
      return this.record({
        store_id,
        actor,
        action,
        target,
        detail,
        diff,
        ip: req.ip || req.socket?.remoteAddress,
        ua: req.get("User-Agent"),
      });
    },

    /**
     * Query activity log with filters.
     */
    async query(store_id, { actor, action, target, since, until, limit = 100 } = {}) {
      const filter = (entry) => {
        if (entry.store_id !== store_id) return false;
        if (actor && entry.actor !== actor) return false;
        if (action && entry.action !== action) return false;
        if (target && entry.target !== target) return false;
        if (since && entry.at < since) return false;
        if (until && entry.at > until) return false;
        return true;
      };

      const entries = await store.activityLogs.find(filter);
      entries.sort((a, b) => b.at.localeCompare(a.at));
      return entries.slice(0, limit);
    },

    /**
     * Get recent activity for a store (dashboard widget).
     */
    async recent(store_id, limit = 10) {
      const entries = await store.activityLogs.find((e) => e.store_id === store_id);
      entries.sort((a, b) => b.at.localeCompare(a.at));
      return entries.slice(0, limit);
    },

    /**
     * Activity summary: counts by action type over a period.
     */
    async summary(store_id, { since, days = 30 } = {}) {
      const cutoff = since || new Date(Date.now() - days * 86400000).toISOString();
      const entries = await store.activityLogs.find((e) =>
        e.store_id === store_id && e.at >= cutoff
      );

      const byAction = {};
      const byActor = {};
      for (const entry of entries) {
        byAction[entry.action] = (byAction[entry.action] || 0) + 1;
        byActor[entry.actor] = (byActor[entry.actor] || 0) + 1;
      }

      return {
        period: { since: cutoff, days },
        total_events: entries.length,
        by_action: byAction,
        by_actor: byActor,
        top_actions: Object.entries(byAction)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([action, count]) => ({ action, count })),
      };
    },

    /**
     * Export activity log for a store (GDPR compliance / admin audit).
     */
    async export(store_id, { since, until } = {}) {
      const filter = (e) => {
        if (e.store_id !== store_id) return false;
        if (since && e.at < since) return false;
        if (until && e.at > until) return false;
        return true;
      };

      const entries = await store.activityLogs.find(filter);
      entries.sort((a, b) => a.at.localeCompare(b.at));

      return {
        store_id,
        exported_at: new Date().toISOString(),
        total_entries: entries.length,
        entries,
      };
    },
  };
}

module.exports = { createActivityLog, ACTION_TYPES };
