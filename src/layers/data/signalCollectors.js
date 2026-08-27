"use strict";

/**
 * External Signal Collectors.
 *
 * Fetches trending data from Google Trends, Reddit, and other public
 * sources to feed the trend intelligence engine. Each collector
 * normalizes data into { source, keyword, score } format.
 *
 * All collectors are best-effort: network failures are swallowed
 * so the platform never crashes due to external API issues.
 */

const EXTERNAL_SIGNALS_SOURCES = {
  google_trends: "google_trends",
  reddit: "reddit",
  pinterest: "pinterest",
};

// ── Google Trends (via SerpApi or direct scraping) ──────────────────
/**
 * Fetch trending topics from Google Trends.
 * Uses the public RSS feed or SerpApi when available.
 */
async function collectGoogleTrends(keywords = [], store_id = null) {
  const signals = [];
  for (const keyword of keywords) {
    try {
      // Use Google Trends RSS feed (public, no API key needed)
      const encoded = encodeURIComponent(keyword);
      const url = `https://trends.google.com/trends/api/dailytrends?q=${encoded}&hl=en-US&tz=-480`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; StorecopsBot/1.0)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      // Google prefixes response with ")]}',\n" — strip it
      const json = JSON.parse(text.replace(/^\)\]\}'\s*/, ""));
      const trending = json.default?.trendingSearchesDays?.[0]?.trendingSearches || [];
      if (trending.length > 0) {
        // Score based on search volume relative to max
        const maxTraffic = Math.max(...trending.map((t) => t.formattedTraffic ? parseInt(t.formattedTraffic.replace(/[^0-9]/g, "")) || 100 : 100));
        for (const topic of trending.slice(0, 10)) {
          const title = topic.title?.query || topic.title || "";
          const traffic = topic.formattedTraffic ? parseInt(topic.formattedTraffic.replace(/[^0-9]/g, "")) || 50 : 50;
          const score = Math.min(100, Math.round((traffic / maxTraffic) * 100));
          if (title) {
            signals.push({ store_id, source: "google_trends", keyword: title, score });
          }
        }
      }
    } catch (_) {
      // Google Trends may block scraping — fall back silently
    }
  }
  return signals;
}

// ── Reddit (public JSON API) ────────────────────────────────────────
/**
 * Fetch trending posts from Reddit subreddits.
 * Uses the public .json endpoints (no auth required).
 */
async function collectReddit(keywords = [], subreddits = ["gadgets", "technology", "deals"], store_id = null) {
  const signals = [];
  const keywordScores = new Map();

  for (const sub of subreddits) {
    try {
      const url = `https://www.reddit.com/r/${sub}/hot.json?limit=25`;
      const res = await fetch(url, {
        headers: { "User-Agent": "StorecopsBot/1.0 (by /u/storecops)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const posts = json.data?.children || [];

      for (const post of posts) {
        const title = post.data?.title || "";
        const upvotes = post.data?.ups || 0;
        const comments = post.data?.num_comments || 0;
        const engagement = upvotes + comments * 2;

        // Match against keywords
        for (const kw of keywords) {
          if (title.toLowerCase().includes(kw.toLowerCase())) {
            const prev = keywordScores.get(kw) || { score: 0, count: 0 };
            keywordScores.set(kw, { score: prev.score + engagement, count: prev.count + 1 });
          }
        }
      }
    } catch (_) {
      // Reddit may rate-limit — fall back silently
    }
  }

  // Normalize scores to 0-100
  const maxScore = Math.max(1, ...[...keywordScores.values()].map((v) => v.score));
  for (const [kw, data] of keywordScores) {
    const normalized = Math.min(100, Math.round((data.score / maxScore) * 100));
    signals.push({ store_id, source: "reddit", keyword: kw, score: normalized });
  }
  return signals;
}

// ── Pinterest (public trends via scraping) ──────────────────────────
/**
 * Fetch trending topics from Pinterest.
 * Uses the public trending page.
 */
async function collectPinterest(keywords = [], store_id = null) {
  const signals = [];
  for (const keyword of keywords) {
    try {
      const encoded = encodeURIComponent(keyword);
      const url = `https://www.pinterest.com/search/pins/?q=${encoded}&rs=typed`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; StorecopsBot/1.0)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      // Count pin indicators as a rough popularity metric
      const pinCount = (html.match(/pin/gi) || []).length;
      const score = Math.min(100, Math.round(pinCount / 5));
      if (score > 10) {
        signals.push({ store_id, source: "pinterest", keyword, score });
      }
    } catch (_) {
      // Pinterest may block — fall back silently
    }
  }
  return signals;
}

// ── Search API (configurable) ──────────────────────────────────────
/**
 * Fetch search trend data from a configured search API.
 * Supports Google Custom Search, SerpApi, or similar.
 */
async function collectSearchTrends(keywords = [], config = {}, store_id = null) {
  const signals = [];
  const apiKey = config.searchApiKey || process.env.SEARCH_API_KEY;
  const engine = config.searchEngine || process.env.SEARCH_ENGINE || "google";

  if (!apiKey) return signals;

  for (const keyword of keywords) {
    try {
      if (engine === "serpapi") {
        const url = `https://serpapi.com/search.json?q=${encodeURIComponent(keyword)}&tbm=tw&api_key=${apiKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;
        const data = await res.json();
        const results = data.related_searches || [];
        // Score based on number of related searches found
        const score = Math.min(100, 30 + results.length * 10);
        signals.push({ store_id, source: "search_api", keyword, score });
      }
    } catch (_) {}
  }
  return signals;
}

// ── Collector orchestrator ──────────────────────────────────────────
/**
 * Run all collectors for a store's product keywords.
 * Aggregates results and feeds them to the external signals module.
 */
async function collectAll(store_id, keywords, externalSignals, config = {}) {
  const allSignals = [];

  // Run collectors in parallel (best-effort)
  const [google, reddit, pinterest, search] = await Promise.allSettled([
    collectGoogleTrends(keywords, store_id),
    collectReddit(keywords, ["gadgets", "technology", "deals", "ecommerce"], store_id),
    collectPinterest(keywords, store_id),
    collectSearchTrends(keywords, config, store_id),
  ]);

  if (google.status === "fulfilled") allSignals.push(...google.value);
  if (reddit.status === "fulfilled") allSignals.push(...reddit.value);
  if (pinterest.status === "fulfilled") allSignals.push(...pinterest.value);
  if (search.status === "fulfilled") allSignals.push(...search.value);

  // Ingest all collected signals
  if (allSignals.length > 0 && externalSignals) {
    await externalSignals.ingestBatch(allSignals);
  }

  return { collected: allSignals.length, signals: allSignals };
}

module.exports = {
  collectGoogleTrends,
  collectReddit,
  collectPinterest,
  collectSearchTrends,
  collectAll,
};
