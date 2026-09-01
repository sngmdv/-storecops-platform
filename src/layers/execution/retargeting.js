'use strict';

/**
 * Layer 4 — Retargeting Ad Automation.
 *
 * Builds ready-to-upload retargeting audiences from the event log —
 * cart abandoners and browse abandoners who never converted — and
 * drafts the ad copy for Meta/Google. The platform stays advisory:
 * audiences and creatives are generated for the client's ad account,
 * never pushed without approval.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function createRetargetingService({ store, },) {
  return {
    /**
     * Build retargeting audiences for a store.
     *
     * cart_abandoners: had a cart_abandoned/checkout_started event and
     * no purchase since. browse_abandoners: 3+ product views, no cart.
     */
    async buildAudiences(store_id, { lookbackDays = 30, } = {},) {
      const cutoff = new Date(Date.now() - lookbackDays * DAY_MS,).toISOString();
      const events = await store.events.find(
        (e,) => e.store_id === store_id && e.timestamp >= cutoff,
      );

      const identity = (e,) => e.customer_id || e.email;
      const lastPurchase = new Map();
      for (const e of events) {
        if (!['purchase', 'checkout_completed',].includes(e.event_type,)) continue;
        const id = identity(e,);
        if (id) lastPurchase.set(id, e.timestamp,);
      }

      const cartAudience = new Map();
      const browseAudience = new Map();
      const views = new Map();

      for (const e of events) {
        const id = identity(e,);
        if (!id) continue;
        const purchasedSince = (lastPurchase.get(id,) || '') >= e.timestamp;

        if (['cart_abandoned', 'checkout_started',].includes(e.event_type,) && !purchasedSince) {
          cartAudience.set(id, { customer_id: id, last_signal: e.timestamp, event: e.event_type, },);
        }
        if (e.event_type === 'product_view') {
          views.set(id, (views.get(id,) || 0) + 1,);
        }
      }

      for (const [id, count,] of views) {
        const purchasedAtAll = lastPurchase.has(id,);
        if (count >= 3 && !purchasedAtAll && !cartAudience.has(id,)) {
          browseAudience.set(id, { customer_id: id, product_views: count, },);
        }
      }

      const audiences = {
        store_id,
        lookback_days: lookbackDays,
        cart_abandoners: [...cartAudience.values(),],
        browse_abandoners: [...browseAudience.values(),],
        sizes: {
          cart_abandoners: cartAudience.size,
          browse_abandoners: browseAudience.size,
        },
        ad_drafts: [
          {
            audience: 'cart_abandoners',
            platform: 'meta',
            format: 'carousel',
            headline: 'Your cart misses you',
            primary_text: 'You left something behind — finish your order today and get free shipping on us.',
            cta: 'Complete Purchase',
          },
          {
            audience: 'browse_abandoners',
            platform: 'meta',
            format: 'single_image',
            headline: 'Still thinking about it?',
            primary_text: 'The products you viewed are selling fast. Take another look.',
            cta: 'Shop Now',
          },
        ],
        built_at: new Date().toISOString(),
      };

      await store.retargetingAudiences.insert(audiences,);
      return audiences;
    },

    /** Previously built audience snapshots. */
    async history(store_id, limit = 5,) {
      const records = await store.retargetingAudiences.find({ store_id, },);
      return records.sort((a, b,) => b.built_at.localeCompare(a.built_at,),).slice(0, limit,);
    },
  };
}

module.exports = { createRetargetingService, };
