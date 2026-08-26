"use strict";

/**
 * Layer 2 — Competitor Ad Intelligence.
 *
 * Ingests snapshots of competitor ads (as the Meta Ad Library /
 * Google Ads Transparency Center / TikTok library expose them) and
 * summarizes what rivals are running: platforms, formats, CTAs and
 * how long creatives have been active.
 */

function createAdIntelligence({ store }) {
  return {
    /**
     * Record observed competitor ads.
     * ads: [{ competitor, platform, creative_type, headline, cta, started_at?, url? }]
     */
    async ingest({ store_id, ads = [] }) {
      if (!store_id) throw new Error("store_id is required.");

      let count = 0;
      for (const ad of ads) {
        if (!ad.competitor) continue;
        await store.competitorAds.insert({
          store_id,
          competitor: ad.competitor,
          platform: ad.platform || "unknown", // meta | google | tiktok
          creative_type: ad.creative_type || "static", // static | video | carousel
          headline: ad.headline || "",
          cta: ad.cta || null,
          started_at: ad.started_at || null,
          url: ad.url || null,
          observed_at: new Date().toISOString(),
        });
        count += 1;
      }

      return { store_id, ads_ingested: count };
    },

    /**
     * Summarize the competitive ad landscape: volume per competitor,
     * platform mix, dominant CTAs and freshest creatives.
     */
    async analyze(store_id) {
      const ads = await store.competitorAds.find({ store_id });

      if (ads.length === 0) {
        return { store_id, competitors: [], insights: [], analyzed_at: new Date().toISOString() };
      }

      const byCompetitor = new Map();
      for (const ad of ads) {
        const entry = byCompetitor.get(ad.competitor) || {
          competitor: ad.competitor,
          ad_count: 0,
          platforms: {},
          creative_types: {},
          ctas: {},
          ads: [],
        };
        entry.ad_count += 1;
        entry.platforms[ad.platform] = (entry.platforms[ad.platform] || 0) + 1;
        entry.creative_types[ad.creative_type] = (entry.creative_types[ad.creative_type] || 0) + 1;
        if (ad.cta) entry.ctas[ad.cta] = (entry.ctas[ad.cta] || 0) + 1;
        entry.ads.push(ad);
        byCompetitor.set(ad.competitor, entry);
      }

      const competitors = [...byCompetitor.values()]
        .map((entry) => {
          const topOf = (counts) =>
            Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

          return {
            competitor: entry.competitor,
            ad_count: entry.ad_count,
            primary_platform: topOf(entry.platforms),
            primary_format: topOf(entry.creative_types),
            top_cta: topOf(entry.ctas),
            newest_ads: entry.ads
              .sort((a, b) => (b.observed_at || "").localeCompare(a.observed_at || ""))
              .slice(0, 3)
              .map((ad) => ({ platform: ad.platform, headline: ad.headline, cta: ad.cta })),
          };
        })
        .sort((a, b) => b.ad_count - a.ad_count);

      // Cross-competitor takeaways.
      const videoShare = ads.filter((ad) => ad.creative_type === "video").length / ads.length;
      const insights = [];
      if (videoShare >= 0.5) {
        insights.push("Competitors lean heavily on video creatives — match or beat with short-form video.");
      }
      const mostActive = competitors[0];
      if (mostActive) {
        insights.push(
          `${mostActive.competitor} is the most active advertiser (${mostActive.ad_count} ads, mostly ${mostActive.primary_platform}/${mostActive.primary_format}).`
        );
      }

      return { store_id, competitors, insights, analyzed_at: new Date().toISOString() };
    },
  };
}

module.exports = { createAdIntelligence };
