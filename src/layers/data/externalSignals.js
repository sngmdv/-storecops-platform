'use strict';

/**
 * Layer 1 — External Signal Aggregator.
 *
 * Normalizes signals from external sources (Google Trends, Reddit,
 * Pinterest, search APIs) into one store-tagged stream that the trend
 * intelligence engine consumes.
 */

const SIGNAL_SOURCES = new Set(['google_trends', 'reddit', 'pinterest', 'search_api', 'manual',],);

function createExternalSignals({ store, },) {
  return {
    /**
     * Record a normalized signal.
     *
     * signal: { store_id, source, keyword, score (0-100), region, url }
     */
    async ingest(signal,) {
      if (!signal || !signal.keyword) {
        throw new Error('keyword is required.',);
      }
      if (signal.source && !SIGNAL_SOURCES.has(signal.source,)) {
        throw new Error(`Unknown signal source: ${signal.source}`,);
      }

      return store.externalSignals.insert({
        store_id: signal.store_id || null,
        source: signal.source || 'manual',
        keyword: String(signal.keyword,).toLowerCase().trim(),
        score: Math.max(0, Math.min(100, Number(signal.score,) || 50,),),
        region: signal.region || 'global',
        url: signal.url || null,
        captured_at: new Date().toISOString(),
      },);
    },

    /** Bulk ingest from one provider response. */
    async ingestBatch(signals,) {
      const ingested = [];
      for (const signal of signals) {
        ingested.push(await this.ingest(signal,),);
      }
      return ingested;
    },

    /** Latest signals for a store (or global signals when store_id null). */
    async recent(store_id, limit = 50,) {
      const signals = await store.externalSignals.find(
        (signal,) => !store_id || signal.store_id === store_id || signal.store_id === null,
      );
      return signals
        .sort((a, b,) => b.captured_at.localeCompare(a.captured_at,),)
        .slice(0, limit,);
    },
  };
}

module.exports = { createExternalSignals, SIGNAL_SOURCES, };
