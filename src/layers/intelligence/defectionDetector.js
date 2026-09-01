'use strict';

/**
 * Layer 2 — Defection Detector.
 *
 * Flags high-value customers who look like they are drifting to a
 * competitor: purchases stopped but browsing continues, or explicit
 * competitor-browsing signals (`competitor_view` events) were
 * captured by the pixel. These are the highest-intent win-back
 * targets the retention layer has.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function createDefectionDetector({ store, },) {
  return {
    /**
     * Scan a store's customers for defection signals.
     *
     * A customer is flagged when they have spend history AND either:
     *   - recent competitor browsing signals, or
     *   - no purchase for `inactiveDays` while still visiting the site.
     */
    async detect(store_id, { inactiveDays = 30, minSpend = 1, } = {},) {
      const profiles = (await store.customers.find({ store_id, },)).filter(
        (profile,) => !profile.merged_into,
      );
      const now = Date.now();
      const flagged = [];

      for (const profile of profiles) {
        if (profile.total_spent < minSpend) continue;

        const daysSincePurchase = profile.last_purchase_at
          ? Math.floor((now - new Date(profile.last_purchase_at,).getTime()) / DAY_MS,)
          : null;
        const daysSinceSeen = Math.floor((now - new Date(profile.last_seen,).getTime()) / DAY_MS,);

        const competitorSignal = (profile.competitor_views || 0) > 0;
        const lapsedButBrowsing =
          daysSincePurchase !== null && daysSincePurchase >= inactiveDays && daysSinceSeen < inactiveDays;

        if (!competitorSignal && !lapsedButBrowsing) continue;

        const severity = competitorSignal && lapsedButBrowsing
          ? 'CRITICAL'
          : competitorSignal
            ? 'HIGH'
            : 'MEDIUM';

        flagged.push({
          customer_id: profile.identity,
          email: profile.email || null,
          severity,
          total_spent: profile.total_spent,
          purchases: profile.purchases,
          days_since_purchase: daysSincePurchase,
          competitor_views: profile.competitor_views || 0,
          reasons: [
            ...(competitorSignal ? [`Browsed competitor content ${profile.competitor_views} time(s).`,] : []),
            ...(lapsedButBrowsing
              ? [`No purchase for ${daysSincePurchase} days but still visiting the store.`,]
              : []),
          ],
          suggested_action: 'Trigger a targeted win-back with a strong offer before the switch happens.',
        },);
      }

      flagged.sort((a, b,) => b.total_spent - a.total_spent,);

      return {
        store_id,
        flagged,
        count: flagged.length,
        scanned_at: new Date().toISOString(),
      };
    },
  };
}

module.exports = { createDefectionDetector, };
