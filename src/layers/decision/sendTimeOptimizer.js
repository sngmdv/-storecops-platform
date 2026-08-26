"use strict";

/**
 * Layer 3 — Send-Time Optimizer.
 *
 * Learns each customer's engagement clock: which hour of day their
 * email opens, WhatsApp reads and push taps actually happen. The
 * execution layer asks for the best send hour before delivering.
 *
 * Falls back to population averages, then to sane defaults, so it is
 * useful from the very first message.
 */

const ENGAGEMENT_EVENTS = {
  email_opened: "email",
  email_clicked: "email",
  whatsapp_read: "whatsapp",
  whatsapp_replied: "whatsapp",
  push_opened: "push",
};

// Sensible defaults when there is no history yet.
const CHANNEL_DEFAULTS = { email: 10, whatsapp: 19, push: 18 };
const GLOBAL_DEFAULT = 10;

function bestHourFromHistogram(histogram) {
  const entries = Object.entries(histogram || {});
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
  return Number(entries[0][0]);
}

function createSendTimeOptimizer({ store }) {
  return {
    /**
     * Build engagement-hour histograms from the event log.
     * Returns { perCustomer: { id: { channel: { hour: count } } }, population: { channel: { hour: count } } }
     */
    async learn(store_id) {
      const events = await store.events.find(
        (e) => e.store_id === store_id && ENGAGEMENT_EVENTS[e.event_type]
      );

      const perCustomer = new Map();
      const population = {};

      for (const event of events) {
        const channel = ENGAGEMENT_EVENTS[event.event_type];
        const hour = new Date(event.timestamp).getHours();
        const customer = event.customer_id || event.email;
        if (!customer) continue;

        if (!perCustomer.has(customer)) perCustomer.set(customer, {});
        const customerMap = perCustomer.get(customer);
        customerMap[channel] = customerMap[channel] || {};
        customerMap[channel][hour] = (customerMap[channel][hour] || 0) + 1;

        population[channel] = population[channel] || {};
        population[channel][hour] = (population[channel][hour] || 0) + 1;
      }

      return {
        store_id,
        samples: events.length,
        perCustomer: Object.fromEntries(perCustomer),
        population,
        learned_at: new Date().toISOString(),
      };
    },

    /**
     * Best send hour (0-23, local server time) for a customer+channel.
     * Resolution order: customer history → store population → default.
     */
    async bestSendHour(store_id, customer_id, channel = "email") {
      const { perCustomer, population, samples } = await this.learn(store_id);

      const personal = bestHourFromHistogram(perCustomer[customer_id]?.[channel]);
      if (personal !== null) {
        return { store_id, customer_id, channel, hour: personal, basis: "customer_history" };
      }

      const crowd = bestHourFromHistogram(population[channel]);
      if (crowd !== null) {
        return { store_id, customer_id, channel, hour: crowd, basis: "store_average" };
      }

      return {
        store_id,
        customer_id,
        channel,
        hour: CHANNEL_DEFAULTS[channel] ?? GLOBAL_DEFAULT,
        basis: "default",
        samples,
      };
    },
  };
}

module.exports = { createSendTimeOptimizer, ENGAGEMENT_EVENTS };
