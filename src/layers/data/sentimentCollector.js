"use strict";

/**
 * Layer 1 — Sentiment Collector.
 *
 * Captures raw text mentions (reviews, social posts, support messages)
 * tagged with their source. Scoring lives in Layer 2's brand sentiment
 * engine so collection stays dumb and lossless.
 */

const SENTIMENT_SOURCES = new Set(["review", "social", "support", "survey", "manual"]);

function createSentimentCollector({ store }) {
  return {
    /**
     * sample: { store_id, source, text, author, url, rating (1-5 optional) }
     */
    async collect(sample) {
      if (!sample || !sample.text) {
        throw new Error("text is required.");
      }
      const source = sample.source || "manual";
      if (!SENTIMENT_SOURCES.has(source)) {
        throw new Error(`Unknown sentiment source: ${source}`);
      }

      return store.sentimentSamples.insert({
        store_id: sample.store_id || null,
        source,
        text: String(sample.text),
        author: sample.author || null,
        url: sample.url || null,
        rating: typeof sample.rating === "number" ? sample.rating : null,
        collected_at: new Date().toISOString(),
      });
    },

    async recent(store_id, limit = 100) {
      const samples = await store.sentimentSamples.find(
        (sample) => !store_id || sample.store_id === store_id || sample.store_id === null
      );
      return samples
        .sort((a, b) => b.collected_at.localeCompare(a.collected_at))
        .slice(0, limit);
    },
  };
}

module.exports = { createSentimentCollector, SENTIMENT_SOURCES };
