"use strict";

/**
 * Layer 3 — Trend-Based Campaign Generator.
 *
 * Turns rising trends and upcoming seasonal moments into ready-to-send
 * campaign drafts (email + WhatsApp copy, subject lines, CTAs and
 * urgency framing). Drafts are persisted so the client can review and
 * launch them — advisory by default, never auto-sent.
 */

function createCampaignGenerator({ store, trendIntelligence, seasonalAlerts }) {
  /** Build copy for one trending keyword. */
  function trendDraft(store_id, trend) {
    const keyword = trend.keyword;
    const label = keyword
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    return {
      campaign_id: `trend_${keyword.replace(/\s+/g, "_")}`,
      source: "trend",
      keyword,
      momentum: trend.momentum,
      channels: ["email", "whatsapp"],
      subject: `${label} is trending — see what everyone's buying`,
      headline: `${label}: Don't Miss This Wave`,
      body: `${label} is blowing up right now${trend.momentum === "RISING" ? " and demand is still climbing" : ""}. Explore our ${label.toLowerCase()} picks before they sell out.`,
      cta: "Shop the trend",
      urgency: trend.momentum === "RISING" ? "Limited stock while the trend lasts." : "Fresh picks, just landed.",
      generated_at: new Date().toISOString(),
      store_id,
    };
  }

  /** Build copy for one seasonal moment. */
  function seasonalDraft(store_id, opportunity) {
    return {
      campaign_id: `seasonal_${opportunity.event.replace(/\s+/g, "_").toLowerCase()}`,
      source: "seasonal",
      event: opportunity.event,
      date: opportunity.date,
      days_until: opportunity.days_until,
      channels: ["email", "whatsapp"],
      subject: `${opportunity.event} is coming — get ready`,
      headline: `${opportunity.event}: Your Moment Is Here`,
      body: opportunity.campaign_angle,
      cta: "Start shopping",
      urgency:
        opportunity.days_until <= 7
          ? `Only ${opportunity.days_until} days left — act now.`
          : `Plan ahead: ${opportunity.days_until} days to go.`,
      generated_at: new Date().toISOString(),
      store_id,
    };
  }

  return {
    /**
     * Generate campaign drafts from rising trends + near seasonal
     * events, then persist them for review.
     */
    async generate({ store_id, categories = ["all"], maxDrafts = 5 } = {}) {
      if (!store_id) throw new Error("store_id is required.");

      const drafts = [];

      const { trends = [] } = await trendIntelligence.analyze(store_id, 10);
      for (const trend of trends.filter((t) => t.momentum !== "COOLING").slice(0, maxDrafts)) {
        drafts.push(trendDraft(store_id, trend));
      }

      const { opportunities } = seasonalAlerts.upcoming({ store_id, categories, horizonDays: 45 });
      const seasonalSlots = Math.max(0, maxDrafts - drafts.length);
      for (const opportunity of opportunities.slice(0, seasonalSlots)) {
        drafts.push(seasonalDraft(store_id, opportunity));
      }

      for (const draft of drafts) {
        await store.campaigns.insert(draft);
      }

      return {
        store_id,
        drafts,
        count: drafts.length,
        status: "AWAITING_APPROVAL",
        generated_at: new Date().toISOString(),
      };
    },

    /** Previously generated drafts. */
    async list(store_id, limit = 20) {
      const drafts = await store.campaigns.find({ store_id });
      return drafts.sort((a, b) => b.generated_at.localeCompare(a.generated_at)).slice(0, limit);
    },
  };
}

module.exports = { createCampaignGenerator };
