"use strict";

/**
 * Layer 2 — Trend Intelligence Engine.
 *
 * Aggregates Layer 1 external signals into ranked trends, detects
 * momentum (rising vs cooling), and maps trends to product keywords
 * a store can act on.
 */

function createTrendIntelligence({ store }) {
  return {
    /**
     * Rank keywords by aggregated score and compute momentum from the
     * first vs second half of the observation window.
     */
    async analyze(store_id, limit = 10) {
      const signals = await store.externalSignals.find(
        (signal) => !store_id || signal.store_id === store_id || signal.store_id === null
      );

      if (signals.length === 0) {
        return { store_id, trends: [], analyzed_at: new Date().toISOString() };
      }

      const sorted = signals.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
      const midpoint = sorted[Math.floor(sorted.length / 2)].captured_at;

      const byKeyword = new Map();

      for (const signal of sorted) {
        const entry = byKeyword.get(signal.keyword) || {
          keyword: signal.keyword,
          total_score: 0,
          count: 0,
          sources: new Set(),
          early_sum: 0,
          early_count: 0,
          late_sum: 0,
          late_count: 0,
        };

        entry.total_score += signal.score;
        entry.count += 1;
        entry.sources.add(signal.source);

        if (signal.captured_at < midpoint) {
          entry.early_sum += signal.score;
          entry.early_count += 1;
        } else {
          entry.late_sum += signal.score;
          entry.late_count += 1;
        }

        byKeyword.set(signal.keyword, entry);
      }

      const trends = [...byKeyword.values()].map((entry) => {
        const earlyAvg = entry.early_count ? entry.early_sum / entry.early_count : entry.total_score / entry.count;
        const lateAvg = entry.late_count ? entry.late_sum / entry.late_count : earlyAvg;

        let momentum = "STABLE";
        if (lateAvg > earlyAvg * 1.15) momentum = "RISING";
        else if (lateAvg < earlyAvg * 0.85) momentum = "COOLING";

        return {
          keyword: entry.keyword,
          avg_score: Math.round(entry.total_score / entry.count),
          mentions: entry.count,
          sources: [...entry.sources],
          momentum,
        };
      });

      trends.sort((a, b) => b.avg_score - a.avg_score);

      const report = {
        store_id,
        trends: trends.slice(0, limit),
        analyzed_at: new Date().toISOString(),
      };

      await store.trendReports.insert(report);
      return report;
    },

    /**
     * Match trends against a store's catalog keywords to surface
     * actionable campaign ideas.
     *
     * catalogKeywords: [{ product_id, keywords: [] }]
     */
    async campaignOpportunities(store_id, catalogKeywords = []) {
      const { trends } = await this.analyze(store_id, 25);
      const opportunities = [];

      for (const trend of trends) {
        if (trend.momentum === "COOLING") continue;

        for (const item of catalogKeywords) {
          const matched = (item.keywords || []).some((keyword) =>
            trend.keyword.includes(String(keyword).toLowerCase())
          );

          if (matched) {
            opportunities.push({
              product_id: item.product_id,
              trend_keyword: trend.keyword,
              momentum: trend.momentum,
              trend_score: trend.avg_score,
              idea: `Launch a trend campaign for ${trend.keyword} featuring product ${item.product_id}`,
            });
          }
        }
      }

      return opportunities.sort((a, b) => b.trend_score - a.trend_score);
    },
  };
}

module.exports = { createTrendIntelligence };
