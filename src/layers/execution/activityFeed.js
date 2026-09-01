'use strict';

/**
 * Real-Time Activity Feed Service
 *
 * Broadcasts real-time activities to admin dashboard:
 * - New signups and onboarding progress
 * - Cart recovery actions
 * - Support ticket creation
 * - Feature activations
 * - Revenue events
 * - System alerts
 */

const EventEmitter = require('events',);

const ACTIVITY_TYPES = [
  'signup',
  'purchase',
  'cart_recovery',
  'browse_abandonment',
  'support_ticket',
  'feature_activated',
  'subscription_changed',
  'alert',
  'system',
];

function createActivityFeed({ store, live, },) {
  const feed = new EventEmitter();
  feed.setMaxListeners(100,);

  const recentActivities = [];
  const MAX_RECENT = 100;

  function broadcast(activity,) {
    const entry = {
      id: `act_${Date.now()}_${Math.random().toString(36,).slice(2, 8,)}`,
      ...activity,
      timestamp: new Date().toISOString(),
    };

    recentActivities.unshift(entry,);
    if (recentActivities.length > MAX_RECENT) {
      recentActivities.pop();
    }

    feed.emit('activity', entry,);

    // Persist to database
    store.activityLogs?.insert({
      store_id: activity.store_id,
      type: 'activity_feed',
      activity: entry,
    },).catch(() => {},);

    return entry;
  }

  // Listen to existing live events and broadcast them
  if (live) {
    live.on('purchase', (data,) => {
      broadcast({
        store_id: data.store_id,
        type: 'purchase',
        title: 'New Purchase',
        message: `$${data.total?.toFixed(2,) || 'N/A'} order from ${data.customer || 'customer'}`,
        icon: '💰',
        severity: 'success',
        category: 'revenue',
        data,
      },);
    },);
  }

  return {
    ACTIVITY_TYPES,

    /**
     * Broadcast an activity to all subscribers.
     */
    broadcast,

    /**
     * Get recent activities.
     */
    getRecent(store_id = null, limit = 50,) {
      let activities = recentActivities;
      if (store_id) {
        activities = activities.filter((a,) => a.store_id === store_id,);
      }
      return activities.slice(0, limit,);
    },

    /**
     * Subscribe to real-time activities.
     * Returns an unsubscribe function.
     */
    subscribe(callback, store_id = null,) {
      const handler = (activity,) => {
        if (!store_id || activity.store_id === store_id) {
          callback(activity,);
        }
      };
      feed.on('activity', handler,);
      return () => feed.off('activity', handler,);
    },

    /**
     * Create an SSE endpoint handler for real-time streaming.
     */
    createSSEHandler(store_id = null,) {
      return (req, res,) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },);

        // Send recent activities on connect
        const recent = this.getRecent(store_id, 20,);
        res.write(`data: ${JSON.stringify({ type: 'init', activities: recent, },)}\n\n`,);

        // Subscribe to new activities
        const unsubscribe = this.subscribe((activity,) => {
          res.write(`data: ${JSON.stringify({ type: 'activity', activity, },)}\n\n`,);
        }, store_id,);

        // Heartbeat to keep connection alive
        const heartbeat = setInterval(() => {
          res.write(`data: ${JSON.stringify({ type: 'heartbeat', },)}\n\n`,);
        }, 30000,);

        req.on('close', () => {
          unsubscribe();
          clearInterval(heartbeat,);
        },);
      };
    },

    /**
     * Broadcast common activity types.
     */
    async broadcastSignup(store_id, userData,) {
      return broadcast({
        store_id,
        type: 'signup',
        title: 'New Signup',
        message: `${userData.email || 'New user'} joined`,
        icon: '👤',
        severity: 'info',
        category: 'user',
        data: userData,
      },);
    },

    async broadcastPurchase(store_id, purchaseData,) {
      return broadcast({
        store_id,
        type: 'purchase',
        title: 'New Purchase',
        message: `$${purchaseData.total?.toFixed(2,) || 'N/A'} order`,
        icon: '💰',
        severity: 'success',
        category: 'revenue',
        data: purchaseData,
      },);
    },

    async broadcastCartRecovery(store_id, recoveryData,) {
      return broadcast({
        store_id,
        type: 'cart_recovery',
        title: 'Cart Recovery',
        message: `Recovery message sent to ${recoveryData.customer || 'customer'}`,
        icon: '🛒',
        severity: 'success',
        category: 'automation',
        data: recoveryData,
      },);
    },

    async broadcastSupportTicket(store_id, ticketData,) {
      return broadcast({
        store_id,
        type: 'support_ticket',
        title: 'Support Ticket',
        message: `New ticket: ${ticketData.subject || 'Support request'}`,
        icon: '🎫',
        severity: ticketData.priority === 'critical' ? 'critical' : 'info',
        category: 'support',
        data: ticketData,
      },);
    },

    async broadcastFeatureActivation(store_id, featureData,) {
      return broadcast({
        store_id,
        type: 'feature_activated',
        title: 'Feature Activated',
        message: `${featureData.feature_name || 'Feature'} activated`,
        icon: '⚡',
        severity: 'success',
        category: 'feature',
        data: featureData,
      },);
    },

    async broadcastAlert(store_id, alertData,) {
      return broadcast({
        store_id,
        type: 'alert',
        title: alertData.title || 'Alert',
        message: alertData.message || 'System alert',
        icon: alertData.icon || '⚠️',
        severity: alertData.severity || 'warning',
        category: 'alert',
        data: alertData,
      },);
    },

    /**
     * Get activity statistics.
     */
    getStats(store_id = null, periodMs = 24 * 60 * 60 * 1000,) {
      const cutoff = new Date(Date.now() - periodMs,);
      let activities = recentActivities.filter(
        (a,) => new Date(a.timestamp,) >= cutoff,
      );

      if (store_id) {
        activities = activities.filter((a,) => a.store_id === store_id,);
      }

      const byType = {};
      for (const activity of activities) {
        if (!byType[activity.type]) byType[activity.type] = 0;
        byType[activity.type]++;
      }

      return {
        total: activities.length,
        by_type: byType,
        period_ms: periodMs,
      };
    },
  };
}

module.exports = { createActivityFeed, ACTIVITY_TYPES, };
