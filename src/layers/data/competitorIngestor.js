'use strict';

/**
 * Layer 1 — Competitor Data Ingestor.
 *
 * Stores point-in-time snapshots of competitor prices and catalogs.
 * Layer 2's competitor intelligence engine diffs consecutive snapshots
 * to detect price changes, promotions and catalog shifts.
 */

function createCompetitorIngestor({ store, },) {
  return {
    /**
     * Record a snapshot of one competitor's catalog.
     *
     * products: [{ id, name, price, in_stock, url, promotion }]
     * promotion: free-text detected offer, e.g. "BOGO", "SAVE20", bundle deal.
     */
    async ingestSnapshot({ store_id, competitor, products, source = 'manual', captured_at = null, },) {
      if (!store_id || !competitor) {
        throw new Error('store_id and competitor are required.',);
      }

      return store.competitorSnapshots.insert({
        store_id,
        competitor,
        source,
        captured_at: captured_at || new Date().toISOString(),
        products: (products || []).map((product,) => ({
          id: String(product.id,),
          name: product.name || '',
          price: Number(product.price,),
          in_stock: product.in_stock !== false,
          url: product.url || null,
          promotion: product.promotion || null,
        }),),
      },);
    },

    /** Most recent snapshot per competitor for a store. */
    async latestSnapshots(store_id,) {
      const snapshots = await store.competitorSnapshots.find({ store_id, },);
      const latestByCompetitor = new Map();

      for (const snapshot of snapshots) {
        const existing = latestByCompetitor.get(snapshot.competitor,);
        if (!existing || snapshot.captured_at > existing.captured_at) {
          latestByCompetitor.set(snapshot.competitor, snapshot,);
        }
      }

      return [...latestByCompetitor.values(),];
    },

    /** Two most recent snapshots of one competitor (for diffing). */
    async snapshotPair(store_id, competitor,) {
      const snapshots = (await store.competitorSnapshots.find({ store_id, competitor, },)).sort(
        (a, b,) => a.captured_at.localeCompare(b.captured_at,),
      );

      if (snapshots.length < 2) {
        return { previous: snapshots[0] || null, latest: snapshots[0] || null, };
      }

      return {
        previous: snapshots[snapshots.length - 2],
        latest: snapshots[snapshots.length - 1],
      };
    },
  };
}

module.exports = { createCompetitorIngestor, };
