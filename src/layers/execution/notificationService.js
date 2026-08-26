"use strict";

/**
 * Notification Center — in-app alerts for merchants.
 *
 * Every actionable event (new order, churn warning, low stock, billing
 * expiry, SEO fix applied, competitor price change) creates a notification
 * that appears in the merchant's bell-icon feed.
 *
 * Severity levels: info, success, warning, critical.
 * Categories: order, inventory, billing, seo, competitor, retention, system.
 */

const crypto = require("crypto");

const SEVERITY = ["info", "success", "warning", "critical"];
const CATEGORIES = [
  "order", "inventory", "billing", "seo", "competitor",
  "retention", "system", "campaign", "payment", "onboarding",
];

/** Default limits per severity to prevent feed flooding. */
const MAX_PER_SEVERITY = { info: 100, success: 50, warning: 50, critical: 200 };

function createNotificationService({ store }) {
  return {
    SEVERITY,
    CATEGORIES,

    /**
     * Push a notification for a store (or global admin).
     * @param {object} params
     * @param {string} params.store_id  — tenant (or "__admin__" for platform-wide)
     * @param {string} params.title     — short headline
     * @param {string} [params.message] — detail text
     * @param {string} [params.severity] — info|success|warning|critical
     * @param {string} [params.category] — order|inventory|billing|...
     * @param {string} [params.action_url] — deep link to the relevant page
     * @param {object} [params.metadata] — extra structured data
     */
    async push({ store_id, title, message, severity = "info", category = "system", action_url, metadata } = {}) {
      if (!store_id) throw new Error("store_id is required");
      if (!title) throw new Error("title is required");
      if (!SEVERITY.includes(severity)) severity = "info";
      if (!CATEGORIES.includes(category)) category = "system";

      // Enforce per-severity cap to prevent unbounded growth.
      const max = MAX_PER_SEVERITY[severity] || 100;
      const existing = await store.notifications.find((n) =>
        n.store_id === store_id && n.severity === severity && !n.read_at
      );
      if (existing.length >= max) {
        // Prune oldest unread of this severity.
        const oldest = existing.sort((a, b) => a.created_at.localeCompare(b.created_at));
        const toPrune = oldest.slice(0, Math.ceil(max * 0.2));
        for (const item of toPrune) {
          await store.notifications.update(item._id, { read_at: new Date().toISOString(), pruned: true });
        }
      }

      const notification = await store.notifications.insert({
        store_id,
        title,
        message: message || "",
        severity,
        category,
        action_url: action_url || null,
        metadata: metadata || {},
        read_at: null,
        created_at: new Date().toISOString(),
      });

      return notification;
    },

    /**
     * Fetch notifications for a store, newest first.
     * Supports optional filters: severity, category, unreadOnly.
     */
    async list(store_id, { severity, category, unreadOnly = false, limit = 50 } = {}) {
      const filter = (n) => {
        if (n.store_id !== store_id) return false;
        if (severity && n.severity !== severity) return false;
        if (category && n.category !== category) return false;
        if (unreadOnly && n.read_at) return false;
        return true;
      };

      const items = await store.notifications.find(filter);
      items.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return items.slice(0, limit);
    },

    /** Mark one or all notifications as read. */
    async markRead(store_id, notification_id = null) {
      if (notification_id) {
        const item = await store.notifications.findById(notification_id);
        if (item && item.store_id === store_id) {
          return store.notifications.update(notification_id, { read_at: new Date().toISOString() });
        }
        return null;
      }
      // Mark all unread as read for this store.
      const unread = await store.notifications.find((n) =>
        n.store_id === store_id && !n.read_at
      );
      for (const item of unread) {
        await store.notifications.update(item._id, { read_at: new Date().toISOString() });
      }
      return { marked: unread.length };
    },

    /** Unread count for badge display. */
    async unreadCount(store_id) {
      const unread = await store.notifications.find((n) =>
        n.store_id === store_id && !n.read_at
      );
      return unread.length;
    },

    /** Summary by severity for the notification bell. */
    async summary(store_id) {
      const all = await store.notifications.find((n) =>
        n.store_id === store_id && !n.read_at
      );
      const bySeverity = {};
      for (const s of SEVERITY) bySeverity[s] = 0;
      for (const n of all) bySeverity[n.severity] = (bySeverity[n.severity] || 0) + 1;

      return {
        total_unread: all.length,
        by_severity: bySeverity,
        has_critical: bySeverity.critical > 0,
        has_warning: bySeverity.warning > 0,
      };
    },

    /**
     * Auto-generate notifications from common platform events.
     * Called by the growth cycle, webhooks, billing, etc.
     */
    async notifyFromEvent(event) {
      const { store_id, event_type, data = {} } = event;
      if (!store_id) return null;

      const eventNotifications = {
        purchase: { title: "New order received", severity: "success", category: "order", message: `Order total: ${data.total || "N/A"}` },
        cart_abandoned: { title: "Cart abandoned", severity: "warning", category: "order", message: `Customer ${data.customer_id || "unknown"} left items in cart` },
        stockout_risk: { title: "Stockout risk detected", severity: "warning", category: "inventory", message: `${data.product_title || "Product"} may run out soon` },
        churn_risk_high: { title: "High churn risk customer", severity: "warning", category: "retention", message: `Customer ${data.customer_id || "unknown"} showing defection signals` },
        competitor_price_drop: { title: "Competitor price drop", severity: "info", category: "competitor", message: `${data.competitor || "Competitor"} lowered prices` },
        seo_fix_applied: { title: "SEO fix applied", severity: "success", category: "seo", message: data.fix_type || "Optimization applied" },
        billing_expiring: { title: "Subscription expiring", severity: "critical", category: "billing", message: "Your plan renewal is due soon" },
        payment_failed: { title: "Payment failed", severity: "critical", category: "payment", message: "Please update your payment method" },
        onboarding_complete: { title: "Setup complete!", severity: "success", category: "onboarding", message: "Your store is fully configured" },
      };

      const template = eventNotifications[event_type];
      if (!template) return null;

      return this.push({
        store_id,
        ...template,
        action_url: data.action_url || null,
        metadata: data,
      });
    },
  };
}

module.exports = { createNotificationService, SEVERITY, CATEGORIES };
