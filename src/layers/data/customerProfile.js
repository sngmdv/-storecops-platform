"use strict";

/**
 * Layer 1 — Unified Customer Profile.
 *
 * Merges activity across identifiers (customer_id, email, session_id)
 * into a single profile per store, and derives the behavioural
 * aggregates every intelligence engine consumes.
 */

function resolveIdentity(event) {
  return event.customer_id || event.email || `session:${event.session_id}`;
}

function createCustomerProfiles({ store }) {
  async function findOrCreate(storeId, identity, event) {
    const candidates = [store.customers.findOne({ store_id: storeId, identity })];
    if (event.email) {
      candidates.push(store.customers.findOne({ store_id: storeId, email: event.email }));
    }
    if (event.session_id) {
      candidates.push(
        store.customers.findOne({ store_id: storeId, identity: `session:${event.session_id}` })
      );
    }

    const matches = (await Promise.all(candidates)).filter(Boolean);
    let profile = null;

    if (matches.length > 0) {
      // Identity resolution: keep one profile per person and upgrade its
      // identity whenever a stronger identifier is observed.
      profile = matches.sort((a, b) => a.first_seen.localeCompare(b.first_seen))[0];
      const others = matches.filter((match) => match._id !== profile._id);

      for (const other of others) {
        const history = await store.events.find(
          (existing) =>
            existing.store_id === storeId &&
            (existing.customer_id === other.identity ||
              (other.email && existing.email === other.email))
        );
        for (const existing of history) {
          await store.events.update(existing._id, { customer_id: profile.identity });
        }
        await store.customers.update(other._id, { merged_into: profile._id, identity: `${other.identity}::merged` });
      }

      if (profile.identity !== identity || (event.email && !profile.email)) {
        profile = await store.customers.update(profile._id, {
          identity,
          email: event.email || profile.email,
        });
      }
    }

    if (!profile) {
      profile = await store.customers.insert({
        store_id: storeId,
        identity,
        email: event.email || null,
        phone: event.phone || null,
        first_seen: event.timestamp,
        last_seen: event.timestamp,
        sessions: 0,
        product_views: 0,
        cart_updates: 0,
        abandoned_carts: 0,
        checkouts_started: 0,
        purchases: 0,
        total_spent: 0,
        refunded: 0,
        viewed_products: [],
        channels_responded: [],
        last_purchase_at: null,
      });
    }

    return profile;
  }

  return {
    /** Apply one logged event to the matching profile. */
    async applyEvent(event) {
      const storeId = event.store_id;
      const identity = resolveIdentity(event);
      const profile = await findOrCreate(storeId, identity, event);

      const patch = {
        last_seen: event.timestamp,
        email: event.email || profile.email,
        phone: event.phone || profile.phone,
      };

      switch (event.event_type) {
        case "page_view":
        case "search":
          patch.sessions = profile.sessions + 1;
          break;
        case "product_view":
          patch.product_views = profile.product_views + 1;
          if (event.product_id && !profile.viewed_products.includes(event.product_id)) {
            patch.viewed_products = [...profile.viewed_products, event.product_id].slice(-50);
          }
          break;
        case "cart_updated":
          patch.cart_updates = profile.cart_updates + 1;
          break;
        case "cart_abandoned":
          patch.abandoned_carts = profile.abandoned_carts + 1;
          break;
        case "checkout_started":
          patch.checkouts_started = profile.checkouts_started + 1;
          break;
        case "checkout_completed":
        case "purchase":
          patch.purchases = profile.purchases + 1;
          patch.total_spent = profile.total_spent + (event.total || 0);
          patch.last_purchase_at = event.timestamp;
          break;
        case "refund":
          patch.refunded = profile.refunded + (event.total || 0);
          break;
        case "email_opened":
        case "email_clicked":
          patch.channels_responded = [...new Set([...profile.channels_responded, "email"])];
          break;
        case "whatsapp_read":
        case "whatsapp_replied":
          patch.channels_responded = [...new Set([...profile.channels_responded, "whatsapp"])];
          break;
        case "push_opened":
          patch.channels_responded = [...new Set([...profile.channels_responded, "push"])];
          break;
        case "competitor_view":
          patch.competitor_views = (profile.competitor_views || 0) + 1;
          break;
        default:
          break;
      }

      return store.customers.update(profile._id, patch);
    },

    async get(storeId, identity) {
      return store.customers.findOne({ store_id: storeId, identity });
    },

    async list(storeId) {
      const profiles = await store.customers.find({ store_id: storeId });
      return profiles.filter((profile) => !profile.merged_into);
    },

    /** Events for a customer, chronological. */
    async history(storeId, identity) {
      const events = await store.events.find(
        (event) =>
          event.store_id === storeId &&
          (event.customer_id === identity || event.email === identity)
      );
      return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    },
  };
}

module.exports = { createCustomerProfiles, resolveIdentity };
