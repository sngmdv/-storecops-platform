"use strict";

/**
 * Layer 2 — SEO Growth Engine.
 *
 * Everything organic-growth on top of the audit engine and Search
 * Console data:
 *   - Search intent gap analysis        (5.2)
 *   - Content opportunity generator     (5.3)
 *   - SEO auto-fix suggestions          (5.4)
 *   - Competitor ranking comparison     (5.5)
 *   - SEO-optimized product content     (2.7)
 *
 * Copy generation is deterministic template-based so it runs with no
 * external LLM; swap `generateCopy` for a GPT adapter when available.
 */

const INTENT_HINTS = [
  { hint: ["buy", "price", "deal", "discount", "cheap", "order"], intent: "transactional" },
  { hint: ["best", "vs", "review", "top", "compare"], intent: "commercial" },
  { hint: ["how", "what", "why", "guide", "tips", "tutorial"], intent: "informational" },
];

function classifyIntent(query) {
  for (const { hint, intent } of INTENT_HINTS) {
    if (hint.some((word) => query.includes(word))) return intent;
  }
  return "navigational";
}

function titleCase(text) {
  return String(text)
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trim()}…`;
}

function createSeoGrowth({ store, searchConsole }) {
  /**
   * Deterministic SEO copy for a product page (2.7).
   * Fills meta title (<=60), meta description (<=160) and an H1.
   */
  function generateProductContent({ product_id, name, description = "", keywords = [] }) {
    const title = truncate(`${titleCase(name || product_id)} | Best Price & Fast Shipping`, 60);
    const keywordLine = keywords.slice(0, 2).join(", ");
    const meta_description = truncate(
      `Shop ${titleCase(name || product_id)} at the best price. ${
        description ? `${description.split(".")[0]}. ` : ""
      }${keywordLine ? `Popular for ${keywordLine}. ` : ""}Free returns, fast delivery.`,
      160
    );

    return {
      product_id,
      meta_title: title,
      meta_description,
      h1: titleCase(name || product_id),
      target_keywords: keywords,
      generated_at: new Date().toISOString(),
    };
  }

  return {
    generateProductContent,

    /**
     * Search intent gap analysis (5.2): queries bringing impressions
     * that the store fails to convert or doesn't cover at all.
     *
     * coveredKeywords: terms the store's site already targets.
     */
    async intentGap(store_id, coveredKeywords = []) {
      const { queries } = await searchConsole.performance(store_id);
      const covered = new Set(coveredKeywords.map((k) => String(k).toLowerCase()));

      const gaps = [];
      for (const query of queries) {
        const isCovered = [...covered].some(
          (keyword) => query.query.includes(keyword) || keyword.includes(query.query)
        );

        // Gap = meaningful impressions but weak result.
        const weakCtr = query.ctr < 2;
        const weakPosition = query.avg_position !== null && query.avg_position > 10;

        if (!isCovered || weakCtr || weakPosition) {
          gaps.push({
            query: query.query,
            intent: classifyIntent(query.query),
            impressions: query.impressions,
            clicks: query.clicks,
            ctr: query.ctr,
            avg_position: query.avg_position,
            covered: isCovered,
            reason: !isCovered
              ? "No content targets this query yet."
              : weakPosition
                ? "Ranks beyond page 1 — needs optimization."
                : "Ranked but CTR is weak — rewrite title/description.",
          });
        }
      }

      return {
        store_id,
        gaps: gaps.sort((a, b) => b.impressions - a.impressions),
        analyzed_at: new Date().toISOString(),
      };
    },

    /**
     * Content opportunity generator (5.3): turns gap queries into
     * concrete blog/content briefs, best-intent first.
     */
    async contentOpportunities(store_id, coveredKeywords = [], limit = 10) {
      const { gaps } = await this.intentGap(store_id, coveredKeywords);
      const intentWeight = { transactional: 3, commercial: 2, informational: 1, navigational: 0 };

      return {
        store_id,
        ideas: gaps
          .sort(
            (a, b) =>
              intentWeight[b.intent] - intentWeight[a.intent] || b.impressions - a.impressions
          )
          .slice(0, limit)
          .map((gap) => ({
            target_keyword: gap.query,
            intent: gap.intent,
            headline:
              gap.intent === "informational"
                ? `${titleCase(gap.query)}: The Complete Guide`
                : `${titleCase(gap.query)} — What to Know Before You Buy`,
            suggested_structure: ["Intro + answer up front", "Comparison / criteria", "FAQ", "CTA"],
            estimated_impressions: gap.impressions,
          })),
        generated_at: new Date().toISOString(),
      };
    },

    /**
     * SEO auto-fix suggestions (5.4): takes an audit result and
     * produces ready-to-apply fixes for every failed check.
     */
    autoFixSuggestions(audit, { brand = "Our Store", keywords = [] } = {}) {
      const fixes = [];

      for (const check of audit.checks || []) {
        if (check.pass) continue;

        if (check.check === "title_tag") {
          fixes.push({
            target: "title_tag",
            current: check.detail,
            suggested: truncate(`${brand} — ${keywords.slice(0, 2).join(" & ") || "Shop Online"} | Official Store`, 60),
            action: "Replace the <title> tag.",
          });
        }
        if (check.check === "meta_description") {
          fixes.push({
            target: "meta_description",
            current: check.detail,
            suggested: truncate(
              `Discover ${keywords.slice(0, 2).join(", ") || "our products"} at ${brand}. Best prices, fast shipping and easy returns. Shop now.`,
              160
            ),
            action: "Add or replace the meta description.",
          });
        }
        if (check.check === "single_h1") {
          fixes.push({
            target: "h1",
            current: check.detail,
            suggested: titleCase(brand),
            action: "Ensure exactly one <h1> that matches the page topic.",
          });
        }
        if (check.check === "canonical_link") {
          fixes.push({
            target: "canonical",
            current: check.detail,
            suggested: audit.url,
            action: "Add <link rel=\"canonical\"> pointing to this URL.",
          });
        }
        if (check.check === "https") {
          fixes.push({
            target: "https",
            current: check.detail,
            suggested: String(audit.url).replace("http://", "https://"),
            action: "Serve the page over HTTPS and redirect HTTP.",
          });
        }
        if (check.check === "mobile_viewport") {
          fixes.push({
            target: "viewport",
            current: check.detail,
            suggested: '<meta name="viewport" content="width=device-width, initial-scale=1">',
            action: "Add the responsive viewport meta tag.",
          });
        }
      }

      return {
        url: audit.url,
        fixes,
        auto_apply_safe: ["canonical", "viewport", "title_tag", "meta_description"],
        generated_at: new Date().toISOString(),
      };
    },

    /**
     * Competitor ranking comparison (5.5): latest position per keyword
     * for the store's brand vs every tracked competitor.
     */
    async rankingComparison(store_id, brand) {
      const rows = await store.searchConsole.find(
        (r) => r.store_id === store_id && r.kind === "ranking"
      );

      // Keep only the latest snapshot per keyword+brand.
      const latest = new Map();
      for (const row of rows) {
        const key = `${row.keyword}::${row.brand}`;
        const existing = latest.get(key);
        if (!existing || row.captured_at >= existing.captured_at) latest.set(key, row);
      }

      const byKeyword = new Map();
      for (const row of latest.values()) {
        const entry = byKeyword.get(row.keyword) || { keyword: row.keyword, rankings: [] };
        entry.rankings.push({ brand: row.brand, position: row.position });
        byKeyword.set(row.keyword, entry);
      }

      const comparison = [...byKeyword.values()].map((entry) => {
        entry.rankings.sort((a, b) => (a.position || 999) - (b.position || 999));
        const us = entry.rankings.find((r) => r.brand === brand);
        const leader = entry.rankings[0];
        return {
          keyword: entry.keyword,
          rankings: entry.rankings,
          our_position: us?.position ?? null,
          leader: leader?.brand || null,
          gap_to_leader:
            us && leader && us.brand !== leader.brand ? us.position - leader.position : 0,
        };
      });

      return {
        store_id,
        brand,
        comparison: comparison.sort((a, b) => (a.our_position || 999) - (b.our_position || 999)),
        compared_at: new Date().toISOString(),
      };
    },
  };
}

module.exports = { createSeoGrowth, classifyIntent, titleCase };
