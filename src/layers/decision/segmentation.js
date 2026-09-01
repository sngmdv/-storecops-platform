'use strict';

/**
 * Layer 3 — Customer Segmentation Engine.
 *
 * Assigns every customer a lifecycle segment so rules, offers and
 * campaigns can speak to each group differently:
 *   VIP, HIGH_VALUE, LOYAL, NEW, AT_RISK, DEFECTED.
 *
 * Rule-based scoring on the unified profile — deterministic and
 * explainable; a clustering model can replace the thresholds later
 * without changing the segment names downstream code depends on.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SEGMENTS = ['VIP', 'HIGH_VALUE', 'LOYAL', 'NEW', 'AT_RISK', 'DEFECTED',];

function daysSince(iso, now = Date.now(),) {
  if (!iso) return null;
  return Math.floor((now - new Date(iso,).getTime()) / DAY_MS,);
}

/** Classify one profile. Returns { segment, reasons }. */
function classifyProfile(profile, { inactiveDays = 45, now = Date.now(), } = {},) {
  const sincePurchase = daysSince(profile.last_purchase_at, now,);
  const spend = profile.total_spent || 0;
  const purchases = profile.purchases || 0;
  const reasons = [];

  if (purchases === 0) {
    reasons.push('No purchases yet.',);
    return { segment: 'NEW', reasons, };
  }

  if (sincePurchase !== null && sincePurchase >= inactiveDays) {
    reasons.push(`No purchase for ${sincePurchase} days.`,);
    return { segment: purchases >= 3 ? 'DEFECTED' : 'AT_RISK', reasons, };
  }

  if (spend >= 500 && purchases >= 3) {
    reasons.push(`High lifetime value (${spend}) across ${purchases} orders.`,);
    return { segment: 'VIP', reasons, };
  }

  if (spend >= 200) {
    reasons.push(`Strong spend (${spend}).`,);
    return { segment: 'HIGH_VALUE', reasons, };
  }

  if (purchases >= 3) {
    reasons.push(`Repeat buyer (${purchases} orders).`,);
    return { segment: 'LOYAL', reasons, };
  }

  if (sincePurchase !== null && sincePurchase >= inactiveDays / 2) {
    reasons.push('Slowing purchase cadence.',);
    return { segment: 'AT_RISK', reasons, };
  }

  reasons.push(purchases === 1 ? 'Single purchase so far.' : 'Early relationship.',);
  return { segment: purchases === 1 ? 'NEW' : 'LOYAL', reasons, };
}

function createSegmentationEngine({ store, },) {
  return {
    SEGMENTS,
    classifyProfile,

    /** Segment one customer. */
    async segmentCustomer(store_id, customer_id,) {
      const profile = await store.customers.findOne({ store_id, identity: customer_id, },);
      if (!profile || profile.merged_into) return null;

      const { segment, reasons, } = classifyProfile(profile,);
      return { store_id, customer_id, segment, reasons, total_spent: profile.total_spent, };
    },

    /** Full store segmentation with distribution counts. */
    async segmentStore(store_id,) {
      const profiles = (await store.customers.find({ store_id, },)).filter(
        (profile,) => !profile.merged_into,
      );

      const counts = Object.fromEntries(SEGMENTS.map((segment,) => [segment, 0,],),);
      const customers = [];

      for (const profile of profiles) {
        const { segment, reasons, } = classifyProfile(profile,);
        counts[segment] += 1;
        customers.push({
          customer_id: profile.identity,
          segment,
          reasons,
          total_spent: profile.total_spent,
          purchases: profile.purchases,
        },);
      }

      customers.sort((a, b,) => b.total_spent - a.total_spent,);

      return {
        store_id,
        customers,
        distribution: counts,
        segmented_at: new Date().toISOString(),
      };
    },
  };
}

module.exports = { createSegmentationEngine, classifyProfile, SEGMENTS, };
