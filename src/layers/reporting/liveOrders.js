'use strict';

/**
 * Layer 5 — Live Orders Feed + Revenue Intelligence.
 *
 * Real-time order monitor enriched with customer intelligence:
 * segment, lifetime value, churn risk, and actionable insights.
 * Reads from the immutable event log + customer profiles.
 */

const SALE_EVENTS = ['purchase', 'checkout_completed',];
const DAY_MS = 24 * 60 * 60 * 1000;

function timeAgo(iso, now = Date.now(),) {
  const seconds = Math.max(0, Math.floor((now - new Date(iso,).getTime()) / 1000,),);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60,);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60,);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24,)}d ago`;
}

/** Classify a customer into a lifecycle segment. */
function classifySegment(profile,) {
  const spend = profile.total_spent || 0;
  const purchases = profile.purchases || 0;
  const daysSince = profile.last_purchase_at
    ? Math.floor((Date.now() - new Date(profile.last_purchase_at,).getTime()) / DAY_MS,)
    : null;

  if (purchases === 0) return 'NEW';
  if (daysSince !== null && daysSince >= 45) return purchases >= 3 ? 'DEFECTED' : 'AT_RISK';
  if (spend >= 500 && purchases >= 3) return 'VIP';
  if (spend >= 200) return 'HIGH_VALUE';
  if (purchases >= 3) return 'LOYAL';
  if (daysSince !== null && daysSince >= 22) return 'AT_RISK';
  return purchases === 1 ? 'NEW' : 'LOYAL';
}

/** Generate an actionable insight for a customer based on their profile. */
function customerInsight(profile, segment,) {
  const spend = profile.total_spent || 0;
  const purchases = profile.purchases || 0;
  const views = profile.product_views || 0;
  const abandoned = profile.abandoned_carts || 0;

  if (segment === 'VIP') return { type: 'vip', text: 'VIP customer — nurture with early access', icon: 'star', color: 'green', };
  if (segment === 'HIGH_VALUE') return { type: 'upsell', text: 'High-value — cross-sell opportunity', icon: 'trending-up', color: 'cyan', };
  if (segment === 'AT_RISK') return { type: 'churn', text: 'At risk — consider a win-back offer', icon: 'alert-triangle', color: 'amber', };
  if (segment === 'DEFECTED') return { type: 'winback', text: 'Has defected — send win-back discount', icon: 'heart', color: 'red', };
  if (abandoned > 0 && purchases === 0) return { type: 'abandon', text: 'Abandoned cart but never bought — nudge', icon: 'cart', color: 'amber', };
  if (views >= 5 && purchases === 0) return { type: 'browse', text: 'Browsed a lot, hasn\'t bought — first-purchase nudge', icon: 'eye', color: 'violet', };
  if (spend > 100) return { type: 'repeat', text: 'Repeat buyer — loyalty reward opportunity', icon: 'gift', color: 'green', };
  return { type: 'standard', text: 'Standard order', icon: 'shopping-bag', color: '', };
}

function createLiveOrders({ store, },) {
  return {
    /**
     * Recent purchases enriched with customer intelligence.
     * Each order includes segment, LTV, churn risk, and an actionable insight.
     */
    async recent(store_id, limit = 20,) {
      const events = await store.events.find(
        (e,) => e.store_id === store_id && SALE_EVENTS.includes(e.event_type,),
      );

      const orders = events
        .sort((a, b,) => b.timestamp.localeCompare(a.timestamp,),)
        .slice(0, limit,);

      // Build customer profile cache to avoid repeated lookups.
      const profileCache = new Map();
      async function getProfile(identity,) {
        if (profileCache.has(identity,)) return profileCache.get(identity,);
        const profile = await store.customers.findOne({ store_id, identity, },);
        if (profile) profileCache.set(identity, profile,);
        return profile;
      }

      const enriched = [];
      for (const event of orders) {
        const customerId = event.customer_id || event.email || `session:${event.session_id}`;
        const profile = await getProfile(customerId,);
        const segment = profile ? classifySegment(profile,) : 'NEW';
        const insight = profile ? customerInsight(profile, segment,) : { type: 'new', text: 'New customer', icon: 'user', color: 'violet', };

        enriched.push({
          order_id: event._id,
          customer: customerId,
          email: event.email || null,
          items: (event.items || []).map((item,) => ({
            product_id: item.product_id,
            quantity: item.quantity || 1,
            price: item.price ?? null,
            name: item.product_title || item.name || item.product_id,
          }),),
          total: event.total ?? null,
          at: event.timestamp,
          time_ago: timeAgo(event.timestamp,),

          // Customer intelligence.
          customer_profile: profile ? {
            segment,
            total_spent: profile.total_spent || 0,
            purchases: profile.purchases || 0,
            product_views: profile.product_views || 0,
            abandoned_carts: profile.abandoned_carts || 0,
            first_seen: profile.first_seen,
            last_seen: profile.last_seen,
            days_since_purchase: profile.last_purchase_at
              ? Math.floor((Date.now() - new Date(profile.last_purchase_at,).getTime()) / DAY_MS,)
              : null,
            channels_responded: profile.channels_responded || [],
          } : null,
          insight,
        },);
      }

      // Revenue stats for today.
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0,);
      const todayIso = todayStart.toISOString();

      const todayOrders = enriched.filter((o,) => o.at >= todayIso,);
      const todayRevenue = todayOrders.reduce((sum, o,) => sum + (o.total || 0), 0,);

      // All-time stats from the full event log.
      const allSales = events;
      const totalRevenue = allSales.reduce((sum, e,) => sum + (e.total || 0), 0,);
      const avgOrderValue = allSales.length > 0 ? totalRevenue / allSales.length : 0;

      // Top product by order frequency.
      const productCounts = {};
      for (const e of allSales) {
        for (const item of e.items || []) {
          const name = item.product_title || item.name || item.product_id;
          productCounts[name] = (productCounts[name] || 0) + (item.quantity || 1);
        }
      }
      const topProducts = Object.entries(productCounts,)
        .sort(([, a,], [, b,],) => b - a,)
        .slice(0, 5,)
        .map(([name, qty,],) => ({ name, quantity: qty, }),);

      // Hourly order distribution (last 24h).
      const hourly = Array.from({ length: 24, }, (_, i,) => ({ hour: i, orders: 0, revenue: 0, }),);
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000,).toISOString();
      for (const e of allSales) {
        if (e.timestamp >= dayAgo) {
          const h = new Date(e.timestamp,).getHours();
          hourly[h].orders++;
          hourly[h].revenue += e.total || 0;
        }
      }

      // Segment distribution of today's buyers.
      const segmentCounts = {};
      for (const o of todayOrders) {
        const seg = o.customer_profile?.segment || 'UNKNOWN';
        segmentCounts[seg] = (segmentCounts[seg] || 0) + 1;
      }

      return {
        store_id,
        count: enriched.length,
        orders: enriched,
        stats: {
          today_orders: todayOrders.length,
          today_revenue: todayRevenue,
          avg_order_value: Math.round(avgOrderValue * 100,) / 100,
          total_revenue: totalRevenue,
          total_orders: allSales.length,
          top_products: topProducts,
          hourly,
          today_segments: segmentCounts,
        },
        fetched_at: new Date().toISOString(),
      };
    },

    /** Full customer profile with purchase history + intelligence. */
    async customerPurchases(store_id, customer_id,) {
      const events = await store.events.find(
        (e,) =>
          e.store_id === store_id &&
          SALE_EVENTS.includes(e.event_type,) &&
          (e.customer_id === customer_id || e.email === customer_id),
      );

      const orders = events
        .sort((a, b,) => b.timestamp.localeCompare(a.timestamp,),)
        .map((event,) => ({
          order_id: event._id,
          items: event.items || [],
          total: event.total ?? null,
          at: event.timestamp,
        }),);

      // Get full customer profile.
      const profile = await store.customers.findOne({ store_id, identity: customer_id, },);
      const segment = profile ? classifySegment(profile,) : 'NEW';
      const insight = profile ? customerInsight(profile, segment,) : { type: 'unknown', text: 'Customer not found in profiles', icon: 'help', color: '', };

      // All events (not just purchases) for behavior timeline.
      const allEvents = await store.events.find(
        (e,) =>
          e.store_id === store_id &&
          (e.customer_id === customer_id || e.email === customer_id),
      );
      const eventCounts = {};
      for (const e of allEvents) {
        eventCounts[e.event_type] = (eventCounts[e.event_type] || 0) + 1;
      }

      const totalSpent = orders.reduce((sum, o,) => sum + (o.total || 0), 0,);
      const daysSincePurchase = profile?.last_purchase_at
        ? Math.floor((Date.now() - new Date(profile.last_purchase_at,).getTime()) / DAY_MS,)
        : null;

      return {
        store_id,
        customer_id,
        orders,
        total_orders: orders.length,
        total_spent: totalSpent,
        profile: profile ? {
          segment,
          email: profile.email,
          first_seen: profile.first_seen,
          last_seen: profile.last_seen,
          last_purchase_at: profile.last_purchase_at,
          days_since_purchase: daysSincePurchase,
          product_views: profile.product_views || 0,
          cart_updates: profile.cart_updates || 0,
          abandoned_carts: profile.abandoned_carts || 0,
          checkouts_started: profile.checkouts_started || 0,
          sessions: profile.sessions || 0,
          channels_responded: profile.channels_responded || [],
          viewed_products: (profile.viewed_products || []).slice(-10,),
        } : null,
        insight,
        behavior: eventCounts,
      };
    },
  };
}

module.exports = { createLiveOrders, timeAgo, classifySegment, customerInsight, };
