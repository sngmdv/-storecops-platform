"use strict";

/**
 * Customer Acquisition Cost (CAC) Tracker
 *
 * Tracks and calculates CAC by:
 * - Recording marketing spend per channel
 * - Attributing new customers to acquisition channels
 * - Calculating CAC by channel and overall
 * - Comparing CAC to LTV for profitability analysis
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function createCacTracker({ store }) {
  return {
    /**
     * Record marketing spend for a channel.
     */
    async recordSpend({ store_id, channel, amount, description, date, metadata }) {
      if (!store_id) throw new Error("store_id is required");
      if (!channel) throw new Error("channel is required");
      if (amount === undefined || amount < 0) throw new Error("amount must be a non-negative number");

      return store.marketingSpend?.insert({
        store_id,
        channel,
        amount,
        description: description || "",
        date: date || new Date().toISOString().split("T")[0],
        metadata: metadata || {},
        created_at: new Date().toISOString(),
      });
    },

    /**
     * Get all spend records for a store.
     */
    async getSpend(store_id, { from, to, channel } = {}) {
      let records = await store.marketingSpend?.find({ store_id }) || [];

      if (from) records = records.filter((r) => r.date >= from);
      if (to) records = records.filter((r) => r.date <= to);
      if (channel) records = records.filter((r) => r.channel === channel);

      return records.sort((a, b) => b.date.localeCompare(a.date));
    },

    /**
     * Calculate CAC for a specific channel.
     */
    async calculateChannelCac(store_id, channel, periodDays = 30) {
      const cutoff = new Date(Date.now() - periodDays * DAY_MS).toISOString().split("T")[0];

      // Get spend for the period
      const spendRecords = await store.marketingSpend?.find({
        store_id,
        channel,
      }) || [];
      const periodSpend = spendRecords
        .filter((r) => r.date >= cutoff)
        .reduce((sum, r) => sum + r.amount, 0);

      // Get new customers acquired through this channel
      const customers = await store.customers?.find({ store_id }) || [];
      const newCustomers = customers.filter(
        (c) =>
          c.acquisition_channel === channel &&
          c.created_at >= cutoff
      );

      const customersAcquired = newCustomers.length;
      const cac = customersAcquired > 0 ? periodSpend / customersAcquired : 0;

      return {
        store_id,
        channel,
        period_days: periodDays,
        total_spend: periodSpend,
        customers_acquired: customersAcquired,
        cac: Number(cac.toFixed(2)),
        calculated_at: new Date().toISOString(),
      };
    },

    /**
     * Calculate overall CAC across all channels.
     */
    async calculateOverallCac(store_id, periodDays = 30) {
      const cutoff = new Date(Date.now() - periodDays * DAY_MS).toISOString().split("T")[0];

      // Get total spend
      const spendRecords = await store.marketingSpend?.find({ store_id }) || [];
      const totalSpend = spendRecords
        .filter((r) => r.date >= cutoff)
        .reduce((sum, r) => sum + r.amount, 0);

      // Get all new customers
      const customers = await store.customers?.find({ store_id }) || [];
      const newCustomers = customers.filter((c) => c.created_at >= cutoff);

      const totalCustomers = newCustomers.length;
      const overallCac = totalCustomers > 0 ? totalSpend / totalCustomers : 0;

      // Calculate by channel
      const channels = {};
      for (const record of spendRecords.filter((r) => r.date >= cutoff)) {
        if (!channels[record.channel]) {
          channels[record.channel] = { spend: 0, customers: 0 };
        }
        channels[record.channel].spend += record.amount;
      }

      for (const customer of newCustomers) {
        const channel = customer.acquisition_channel || "organic";
        if (!channels[channel]) {
          channels[channel] = { spend: 0, customers: 0 };
        }
        channels[channel].customers += 1;
      }

      // Calculate CAC per channel
      const channelCacs = {};
      for (const [channel, data] of Object.entries(channels)) {
        channelCacs[channel] = {
          spend: data.spend,
          customers: data.customers,
          cac: data.customers > 0 ? Number((data.spend / data.customers).toFixed(2)) : 0,
        };
      }

      return {
        store_id,
        period_days: periodDays,
        total_spend: totalSpend,
        total_customers: totalCustomers,
        overall_cac: Number(overallCac.toFixed(2)),
        by_channel: channelCacs,
        calculated_at: new Date().toISOString(),
      };
    },

    /**
     * Calculate LTV:CAC ratio for profitability analysis.
     */
    async calculateLtvCacRatio(store_id, periodDays = 30) {
      const cacData = await this.calculateOverallCac(store_id, periodDays);

      // Calculate average LTV from customer data
      const customers = await store.customers?.find({ store_id }) || [];
      const totalRevenue = customers.reduce((sum, c) => sum + (c.total_spent || 0), 0);
      const avgLtv = customers.length > 0 ? totalRevenue / customers.length : 0;

      const ltvCacRatio = cacData.overall_cac > 0 ? avgLtv / cacData.overall_cac : 0;

      return {
        store_id,
        avg_ltv: Number(avgLtv.toFixed(2)),
        avg_cac: cacData.overall_cac,
        ltv_cac_ratio: Number(ltvCacRatio.toFixed(2)),
        verdict:
          ltvCacRatio >= 3 ? "EXCELLENT" :
          ltvCacRatio >= 2 ? "GOOD" :
          ltvCacRatio >= 1 ? "BREAKING_EVEN" :
          "LOSING_MONEY",
        cac_data: cacData,
        calculated_at: new Date().toISOString(),
      };
    },

    /**
     * Get CAC trends over time.
     */
    async getCacTrends(store_id, months = 6) {
      const trends = [];

      for (let i = months - 1; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        const monthStr = date.toISOString().substring(0, 7);

        const monthStart = `${monthStr}-01`;
        const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0)
          .toISOString()
          .split("T")[0];

        const cacData = await this.calculateOverallCac(store_id, 30);
        trends.push({
          month: monthStr,
          ...cacData,
        });
      }

      return trends;
    },

    /**
     * Get marketing spend summary by channel.
     */
    async getSpendSummary(store_id, periodDays = 30) {
      const cutoff = new Date(Date.now() - periodDays * DAY_MS).toISOString().split("T")[0];

      const spendRecords = await store.marketingSpend?.find({ store_id }) || [];
      const periodRecords = spendRecords.filter((r) => r.date >= cutoff);

      const byChannel = {};
      let total = 0;

      for (const record of periodRecords) {
        if (!byChannel[record.channel]) {
          byChannel[record.channel] = { total: 0, transactions: 0 };
        }
        byChannel[record.channel].total += record.amount;
        byChannel[record.channel].transactions += 1;
        total += record.amount;
      }

      return {
        store_id,
        period_days: periodDays,
        total_spend: total,
        by_channel: byChannel,
        calculated_at: new Date().toISOString(),
      };
    },
  };
}

module.exports = { createCacTracker };
