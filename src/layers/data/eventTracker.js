"use strict";

/**
 * Layer 1 — Event Tracking.
 *
 * Server-side ingestion endpoint for the client SDK / webhooks. Validates
 * incoming events and appends them to the immutable event log, then
 * updates the unified customer profile.
 */

const EVENT_TYPES = new Set([
  "page_view",
  "product_view",
  "cart_updated",
  "cart_abandoned",
  "checkout_started",
  "checkout_completed",
  "purchase",
  "search",
  "email_opened",
  "email_clicked",
  "whatsapp_sent",
  "whatsapp_read",
  "whatsapp_replied",
  "push_sent",
  "push_opened",
  "competitor_view",
  "refund",
]);

function validateEvent(event) {
  const errors = [];

  if (!event || typeof event !== "object") {
    return ["Event payload must be an object."];
  }
  if (!event.event_type) errors.push("event_type is required.");
  else if (!EVENT_TYPES.has(event.event_type))
    errors.push(`Unknown event_type: ${event.event_type}`);

  if (!event.store_id) errors.push("store_id is required.");
  if (!event.customer_id && !event.email && !event.session_id)
    errors.push("At least one of customer_id, email or session_id is required.");

  if (event.total !== undefined && typeof event.total !== "number")
    errors.push("total must be a number.");

  return errors;
}

function createEventTracker({ store, customerProfiles, consentService }) {
  const listeners = [];

  return {
    EVENT_TYPES,

    /**
     * Register a downstream listener (e.g. the inventory ledger or the
     * live-order broadcaster). Listeners run after the event is logged
     * and the profile is updated.
     */
    onEvent(listener) {
      listeners.push(listener);
    },

    /**
     * Ingest a single event. High-priority events (checkout/purchase) are
     * flagged so downstream engines can act immediately.
     *
     * Consent-aware (Task 32): behavioral tracking events (page_view,
     * product_view, search) require analytics consent. If the customer
     * has not granted analytics consent, these events are rejected.
     * Transactional events (purchase, checkout_completed) are always
     * permitted as essential.
     */
    async track(rawEvent) {
      const errors = validateEvent(rawEvent);
      if (errors.length) {
        return { accepted: false, errors };
      }

      // ── Consent gate for behavioral tracking (Task 32) ──────────────
      if (consentService && rawEvent.store_id && (rawEvent.customer_id || rawEvent.email)) {
        const identity = rawEvent.customer_id || rawEvent.email;
        const check = await consentService.canTrackEvent(
          rawEvent.store_id,
          identity,
          rawEvent.event_type
        );
        if (!check.allowed) {
          return {
            accepted: false,
            errors: [`Event type "${rawEvent.event_type}" requires ${check.category} consent.`],
            consent_blocked: true,
          };
        }
      }

      // ── Minimized payload (Task 34) ─────────────────────────────────
      // Only keep fields needed for product intelligence/recovery.
      // Strip unnecessary metadata before persisting.
      const minimized = {
        event_type: rawEvent.event_type,
        store_id: rawEvent.store_id,
        customer_id: rawEvent.customer_id || null,
        email: rawEvent.email || null,
        phone: rawEvent.phone || null,
        session_id: rawEvent.session_id || null,
        total: rawEvent.total !== undefined ? rawEvent.total : undefined,
        items: rawEvent.items || undefined,
        product_id: rawEvent.product_id || undefined,
        timestamp: rawEvent.timestamp || new Date().toISOString(),
        source: rawEvent.source || undefined,
        external_order_id: rawEvent.external_order_id || undefined,
      };

      const event = {
        ...minimized,
        high_priority: ["checkout_started", "checkout_completed", "purchase", "cart_abandoned"].includes(
          rawEvent.event_type
        ),
      };

      const logged = await store.events.insert(event);

      // Keep the unified profile in sync with every observed activity.
      await customerProfiles.applyEvent(logged);

      for (const listener of listeners) {
        await listener(logged);
      }

      return { accepted: true, event_id: logged._id, high_priority: logged.high_priority };
    },

    /** Bulk ingest for webhook replays. */
    async trackBatch(events) {
      const results = [];
      for (const event of events) {
        results.push(await this.track(event));
      }
      return results;
    },
  };
}

module.exports = { createEventTracker, validateEvent, EVENT_TYPES };
