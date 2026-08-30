"use strict";

/**
 * Aha Moment Detection Service
 *
 * Detects and celebrates when merchants first experience key value moments:
 * - First cart recovered
 * - First browse abandonment detected
 * - First competitor tracked
 * - First automation triggered
 * - First revenue attributed
 * - First SEO audit completed
 *
 * Sends congratulatory notifications and tracks milestone completion.
 */

const AHA_MOMENTS = [
  {
    id: "first_cart_recovery",
    title: "First Cart Recovery",
    description: "You just recovered your first abandoned cart! This is the beginning of automated revenue recovery.",
    icon: "🛒",
    trigger_event: "cart_recovery_sent",
    check_field: "cart_recoveries",
    milestone_value: 1,
  },
  {
    id: "first_browse_abandonment",
    title: "Browse Abandonment Detected",
    description: "You've identified your first browse abandonment. These are visitors who showed interest but didn't add to cart.",
    icon: "👀",
    trigger_event: "browse_abandonment_detected",
    check_field: "browse_abandonments",
    milestone_value: 1,
  },
  {
    id: "first_competitor_tracked",
    title: "Competitor Intelligence Active",
    description: "You're now tracking your first competitor. Monitor their pricing, products, and strategies in real-time.",
    icon: "🎯",
    trigger_event: "competitor_added",
    check_field: "competitors_tracked",
    milestone_value: 1,
  },
  {
    id: "first_automation_fired",
    title: "Automation Triggered",
    description: "Your first automated rule just fired! The system is now working for you 24/7.",
    icon: "⚡",
    trigger_event: "automation_triggered",
    check_field: "automations_fired",
    milestone_value: 1,
  },
  {
    id: "first_revenue_attributed",
    title: "Revenue Attributed",
    description: "You've attributed revenue to your recovery efforts. This is the power of data-driven commerce.",
    icon: "💰",
    trigger_event: "revenue_attributed",
    check_field: "attributed_revenue",
    milestone_value: 1,
  },
  {
    id: "first_seo_fix",
    title: "SEO Optimized",
    description: "Your first SEO fix is live. Better search visibility means more organic traffic.",
    icon: "🔍",
    trigger_event: "seo_fix_applied",
    check_field: "seo_fixes",
    milestone_value: 1,
  },
  {
    id: "revenue_milestone_100",
    title: "$100 Revenue Recovered",
    description: "You've recovered $100 in revenue! Keep the momentum going.",
    icon: "🎉",
    trigger_event: "revenue_milestone",
    check_field: "total_revenue_recovered",
    milestone_value: 100,
  },
  {
    id: "revenue_milestone_1000",
    title: "$1,000 Revenue Recovered",
    description: "Incredible! You've recovered $1,000 in revenue. Your store is thriving.",
    icon: "🚀",
    trigger_event: "revenue_milestone",
    check_field: "total_revenue_recovered",
    milestone_value: 1000,
  },
];

function createAhaMomentService({ store, notificationService }) {
  const achievedCache = new Map();

  async function getAchievedMoments(store_id) {
    if (achievedCache.has(store_id)) {
      return achievedCache.get(store_id);
    }

    const record = await store.activityLogs?.findOne({
      store_id,
      type: "aha_moments",
    });

    const achieved = record?.achieved || [];
    achievedCache.set(store_id, achieved);
    return achieved;
  }

  async function recordAchievement(store_id, moment_id) {
    const achieved = await getAchievedMoments(store_id);
    if (achieved.includes(moment_id)) return false;

    achieved.push(moment_id);
    achievedCache.set(store_id, achieved);

    const existing = await store.activityLogs?.findOne({
      store_id,
      type: "aha_moments",
    });

    if (existing) {
      await store.activityLogs.update(existing._id, {
        achieved,
        updated_at: new Date().toISOString(),
      });
    } else {
      await store.activityLogs?.insert({
        store_id,
        type: "aha_moments",
        achieved,
        created_at: new Date().toISOString(),
      });
    }

    return true;
  }

  return {
    AHA_MOMENTS,

    /**
     * Check if a specific moment has been achieved.
     */
    async isAchieved(store_id, moment_id) {
      const achieved = await getAchievedMoments(store_id);
      return achieved.includes(moment_id);
    },

    /**
     * Get all achieved moments for a store.
     */
    async getAchieved(store_id) {
      const achieved = await getAchievedMoments(store_id);
      return AHA_MOMENTS.filter((m) => achieved.includes(m.id));
    },

    /**
     * Get progress toward all moments.
     */
    async getProgress(store_id) {
      const achieved = await getAchievedMoments(store_id);
      return AHA_MOMENTS.map((m) => ({
        ...m,
        achieved: achieved.includes(m.id),
      }));
    },

    /**
     * Check and trigger aha moments based on an event.
     * Call this after processing significant events.
     */
    async checkMoments(store_id, event_type, data = {}) {
      const newAchievements = [];

      for (const moment of AHA_MOMENTS) {
        const alreadyAchieved = await this.isAchieved(store_id, moment.id);
        if (alreadyAchieved) continue;

        let triggered = false;

        switch (moment.id) {
          case "first_cart_recovery":
            triggered = event_type === "cart_recovery_sent" ||
              (data.cart_recoveries && data.cart_recoveries >= moment.milestone_value);
            break;
          case "first_browse_abandonment":
            triggered = event_type === "browse_abandonment_detected" ||
              (data.browse_abandonments && data.browse_abandonments >= moment.milestone_value);
            break;
          case "first_competitor_tracked":
            triggered = event_type === "competitor_added" ||
              (data.competitors_tracked && data.competitors_tracked >= moment.milestone_value);
            break;
          case "first_automation_fired":
            triggered = event_type === "automation_triggered" ||
              (data.automations_fired && data.automations_fired >= moment.milestone_value);
            break;
          case "first_revenue_attributed":
            triggered = event_type === "revenue_attributed" ||
              (data.attributed_revenue && data.attributed_revenue >= moment.milestone_value);
            break;
          case "first_seo_fix":
            triggered = event_type === "seo_fix_applied" ||
              (data.seo_fixes && data.seo_fixes >= moment.milestone_value);
            break;
          case "revenue_milestone_100":
            triggered = data.total_revenue_recovered >= moment.milestone_value;
            break;
          case "revenue_milestone_1000":
            triggered = data.total_revenue_recovered >= moment.milestone_value;
            break;
        }

        if (triggered) {
          const isNew = await recordAchievement(store_id, moment.id);
          if (isNew) {
            newAchievements.push(moment);

            // Send notification
            if (notificationService) {
              await notificationService.send(store_id, {
                type: "aha_moment",
                title: moment.title,
                message: moment.description,
                icon: moment.icon,
                severity: "success",
                category: "milestone",
              });
            }
          }
        }
      }

      return newAchievements;
    },

    /**
     * Manually trigger aha moment check (e.g., on dashboard load).
     */
    async scanForMoments(store_id) {
      const customer = await store.customers?.findOne({ store_id }) || {};
      const events = await store.events?.find({ store_id }) || [];
      const actions = await store.actions?.find({ store_id }) || [];
      const deliveries = await store.deliveries?.find({ store_id }) || [];
      const tracked = await store.trackedCompetitors?.find({ store_id }) || [];
      const seoAudits = await store.seoAudits?.find({ store_id }) || [];

      const data = {
        cart_recoveries: deliveries.filter((d) => d.type === "recovery_message" && d.status === "delivered").length,
        browse_abandonments: actions.filter((a) => a.type === "browse_abandonment").length,
        competitors_tracked: tracked.length,
        automations_fired: actions.length,
        attributed_revenue: events.filter((e) => e.event_type === "purchase").reduce((sum, e) => sum + (e.total || 0), 0),
        seo_fixes: seoAudits.length,
        total_revenue_recovered: events.filter((e) => e.event_type === "purchase").reduce((sum, e) => sum + (e.total || 0), 0) * 0.15,
      };

      return this.checkMoments(store_id, null, data);
    },
  };
}

module.exports = { createAhaMomentService, AHA_MOMENTS };
