"use strict";

/**
 * Layer 2 — Channel/Response Optimization Engine.
 *
 * Learns which delivery channels (email, whatsapp) actually generate
 * responses for a store, and which channel a specific customer
 * historically responds to. The decision layer uses this to pick the
 * delivery channel for every action.
 */

const CHANNEL_EVENTS = {
  email: { sent: "email_sent", responded: ["email_opened", "email_clicked"] },
  whatsapp: { sent: "whatsapp_sent", responded: ["whatsapp_read", "whatsapp_replied"] },
};

function createChannelOptimizer({ store }) {
  /** Store-wide response rate per channel. */
  async function storeRates(store_id) {
    const events = await store.events.find({ store_id });
    const rates = {};

    for (const [channel, def] of Object.entries(CHANNEL_EVENTS)) {
      const sent = events.filter((e) => e.event_type === def.sent).length;
      const responded = events.filter((e) => def.responded.includes(e.event_type)).length;

      rates[channel] = {
        sent,
        responded,
        response_rate: sent > 0 ? responded / sent : 0,
      };
    }

    return rates;
  }

  return {
    CHANNEL_EVENTS,
    storeRates,

    /**
     * Pick the best channel for a customer.
     *
     * 1. If the customer has responded on a channel before, prefer it.
     * 2. Otherwise use the store-wide best response rate.
     * 3. Tie/no data falls back to email.
     */
    async bestChannel(store_id, customer_id) {
      const profile = await store.customers.findOne({ store_id, identity: customer_id });
      const respondedBefore = profile?.channels_responded || [];

      if (respondedBefore.length === 1) {
        return { channel: respondedBefore[0], reason: "customer_history" };
      }
      if (respondedBefore.length > 1) {
        // Multiple history: break the tie with store-level rates.
        const rates = await storeRates(store_id);
        const ranked = respondedBefore.sort(
          (a, b) => rates[b].response_rate - rates[a].response_rate
        );
        return { channel: ranked[0], reason: "customer_history+store_rate" };
      }

      const rates = await storeRates(store_id);
      const entries = Object.entries(rates).filter(([, r]) => r.sent > 0);

      if (entries.length === 0) {
        return { channel: "email", reason: "default" };
      }

      entries.sort((a, b) => b[1].response_rate - a[1].response_rate);
      return { channel: entries[0][0], reason: "store_rate" };
    },

    /**
     * Record an execution outcome so rates keep learning
     * (Layer 6 growth loop feedback).
     */
    async recordOutcome({ store_id, customer_id, channel, event_type }) {
      return store.events.insert({
        store_id,
        customer_id,
        event_type,
        origin: "channel_optimizer_feedback",
        timestamp: new Date().toISOString(),
      });
    },
  };
}

module.exports = { createChannelOptimizer };
