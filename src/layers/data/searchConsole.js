'use strict';

/**
 * Layer 1 — Search Console & SEO Data Integrator.
 *
 * Ingests search-performance data (the shape Google Search Console
 * delivers: query, page, impressions, clicks, position) and keyword
 * ranking snapshots for the store and its competitors. Layer 2's SEO
 * growth engine turns this raw data into gap analysis, content ideas
 * and ranking comparisons.
 *
 * Ships with an API-driven ingest so it runs without Google OAuth;
 * a real GSC/Ahrefs adapter can push the same shape in later.
 */

function createSearchConsole({ store, },) {
  return {
    /**
     * Ingest performance rows.
     * rows: [{ query, page, impressions, clicks, position, date? }]
     */
    async ingestPerformance({ store_id, rows = [], },) {
      if (!store_id) throw new Error('store_id is required.',);

      const inserted = [];
      for (const row of rows) {
        if (!row.query) continue;
        inserted.push(
          await store.searchConsole.insert({
            store_id,
            kind: 'performance',
            query: String(row.query,).toLowerCase(),
            page: row.page || null,
            impressions: Number(row.impressions,) || 0,
            clicks: Number(row.clicks,) || 0,
            position: Number(row.position,) || null,
            captured_at: row.date || new Date().toISOString(),
          },),
        );
      }

      return { store_id, rows_ingested: inserted.length, };
    },

    /**
     * Ingest keyword ranking snapshots (store + competitors).
     * rankings: [{ keyword, brand, position }]
     */
    async ingestRankings({ store_id, rankings = [], },) {
      if (!store_id) throw new Error('store_id is required.',);

      let count = 0;
      for (const row of rankings) {
        if (!row.keyword || !row.brand) continue;
        await store.searchConsole.insert({
          store_id,
          kind: 'ranking',
          keyword: String(row.keyword,).toLowerCase(),
          brand: row.brand,
          position: Number(row.position,) || null,
          captured_at: new Date().toISOString(),
        },);
        count += 1;
      }

      return { store_id, rankings_ingested: count, };
    },

    /** Aggregated performance per query (CTR, average position). */
    async performance(store_id,) {
      const rows = await store.searchConsole.find(
        (r,) => r.store_id === store_id && r.kind === 'performance',
      );

      const byQuery = new Map();
      for (const row of rows) {
        const entry = byQuery.get(row.query,) || {
          query: row.query,
          impressions: 0,
          clicks: 0,
          positions: [],
          pages: new Set(),
        };
        entry.impressions += row.impressions;
        entry.clicks += row.clicks;
        if (row.position) entry.positions.push(row.position,);
        if (row.page) entry.pages.add(row.page,);
        byQuery.set(row.query, entry,);
      }

      const queries = [...byQuery.values(),]
        .map((entry,) => ({
          query: entry.query,
          impressions: entry.impressions,
          clicks: entry.clicks,
          ctr: entry.impressions > 0 ? Number(((entry.clicks / entry.impressions) * 100).toFixed(2,),) : 0,
          avg_position: entry.positions.length
            ? Number((entry.positions.reduce((a, b,) => a + b, 0,) / entry.positions.length).toFixed(1,),)
            : null,
          pages: [...entry.pages,],
        }),)
        .sort((a, b,) => b.impressions - a.impressions,);

      return { store_id, queries, fetched_at: new Date().toISOString(), };
    },
  };
}

module.exports = { createSearchConsole, };
