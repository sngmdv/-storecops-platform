"use strict";

/**
 * Layer 3 — Decision Orchestrator.
 *
 * The conductor of the platform. It reacts to real-time events and
 * runs periodic scans, evaluates rules against intelligence outputs,
 * de-duplicates repeat actions, and queues approved action plans for
 * the execution layer.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTION_COOLDOWN_HOURS = 12;

function createOrchestrator({ store, rulesEngine, churnScoring, brandSentiment }) {
  /** Dedup guard: one action per customer per rule inside the cooldown. */
  async function recentlyActed(store_id, customer_id, rule_id) {
    const cutoff = new Date(Date.now() - ACTION_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
    const existing = await store.actions.find(
      (a) =>
        a.store_id === store_id &&
        a.customer_id === customer_id &&
        a.rule_id === rule_id &&
        a.created_at >= cutoff
    );
    return existing.length > 0;
  }

  async function queueAction({ store_id, customer_id, rule, context, source }) {
    if (await recentlyActed(store_id, customer_id, rule.rule_id)) {
      return { skipped: true, reason: "cooldown", rule_id: rule.rule_id };
    }

    const action = await store.actions.insert({
      store_id,
      customer_id,
      rule_id: rule.rule_id,
      rule_name: rule.name,
      type: rule.action.type,
      channel: rule.action.channel,
      urgency: rule.action.urgency,
      params: rule.action.params || {},
      context,
      source,
      status: "pending",
      created_at: new Date().toISOString(),
    });

    return { skipped: false, action };
  }

  return {
    /**
     * Real-time path: called right after Layer 1 logs a high-priority
     * event. Builds an evaluation context from the customer profile
     * and fires matching rules.
     */
    async handleEvent(event) {
      const profile = await store.customers.findOne(
        (c) =>
          c.store_id === event.store_id &&
          (c.identity === (event.customer_id || event.email) ||
            (event.session_id && c.identity === `session:${event.session_id}`))
      );

      if (!profile) return { evaluated: false, actions: [] };

      const context = {
        abandoned_carts: profile.abandoned_carts,
        purchases: profile.purchases,
        product_views: profile.product_views,
        cart_updates: profile.cart_updates,
        total_spent: profile.total_spent,
      };

      const matches = await rulesEngine.evaluate({
        store_id: event.store_id,
        trigger: event.event_type,
        context,
      });

      const results = [];
      for (const { rule } of matches) {
        results.push(
          await queueAction({
            store_id: event.store_id,
            customer_id: profile.identity,
            rule,
            context,
            source: `event:${event.event_type}`,
          })
        );
      }

      return {
        evaluated: true,
        customer_id: profile.identity,
        actions: results.filter((r) => !r.skipped).map((r) => r.action),
        skipped: results.filter((r) => r.skipped).length,
      };
    },

    /**
     * Batch path: periodic store-wide scan for churn risk, brand
     * sentiment and VIP surprise & delight. Returns every queued action.
     */
    async scanStore(store_id) {
      const queued = [];

      // Churn win-back.
      const scores = await churnScoring.scoreStore(store_id);
      for (const score of scores) {
        const matches = await rulesEngine.evaluate({
          store_id,
          trigger: "churn_risk",
          context: { churn_score: score.churn_score },
        });

        for (const { rule } of matches) {
          const result = await queueAction({
            store_id,
            customer_id: score.customer_id,
            rule,
            context: { churn_score: score.churn_score, risk_band: score.risk_band },
            source: "scan:churn",
          });
          if (!result.skipped) queued.push(result.action);
        }
      }

      // Brand sentiment escalation.
      const sentiment = await brandSentiment.analyze(store_id);
      if (sentiment.sample_count > 0) {
        const matches = await rulesEngine.evaluate({
          store_id,
          trigger: "sentiment_alert",
          context: { health_score: sentiment.health_score },
        });

        for (const { rule } of matches) {
          const result = await queueAction({
            store_id,
            customer_id: null,
            rule,
            context: { health_score: sentiment.health_score },
            source: "scan:sentiment",
          });
          if (!result.skipped) queued.push(result.action);
        }
      }

      // Browse abandonment: heavy browsing, zero carts, zero purchases.
      const allProfiles = (await store.customers.find({ store_id })).filter(
        (profile) => !profile.merged_into
      );
      for (const profile of allProfiles) {
        if (profile.purchases > 0 || profile.cart_updates > 0) continue;

        const matches = await rulesEngine.evaluate({
          store_id,
          trigger: "product_view",
          context: {
            product_views: profile.product_views,
            cart_updates: profile.cart_updates,
          },
        });

        for (const { rule } of matches) {
          const result = await queueAction({
            store_id,
            customer_id: profile.identity,
            rule,
            context: { product_views: profile.product_views, viewed_products: profile.viewed_products },
            source: "scan:browse",
          });
          if (!result.skipped) queued.push(result.action);
        }
      }

      // VIP surprise & delight: high-LTV customers gone quiet.
      const profiles = allProfiles;
      let vipChecked = 0;
      for (const profile of profiles) {
        const daysSincePurchase = profile.last_purchase_at
          ? Math.floor((Date.now() - new Date(profile.last_purchase_at).getTime()) / DAY_MS)
          : null;
        if (daysSincePurchase === null) continue;
        vipChecked += 1;

        const matches = await rulesEngine.evaluate({
          store_id,
          trigger: "vip_check",
          context: { total_spent: profile.total_spent, days_since_purchase: daysSincePurchase },
        });

        for (const { rule } of matches) {
          const result = await queueAction({
            store_id,
            customer_id: profile.identity,
            rule: {
              ...rule,
              action: { ...rule.action, params: { offer: "early access + surprise gift", ...rule.action.params } },
            },
            context: { total_spent: profile.total_spent, days_since_purchase: daysSincePurchase },
            source: "scan:vip",
          });
          if (!result.skipped) queued.push(result.action);
        }
      }

      return {
        store_id,
        scanned_at: new Date().toISOString(),
        churn_scores: scores.length,
        sentiment_health: sentiment.health_score,
        vip_profiles_checked: vipChecked,
        queued_actions: queued,
      };
    },

    /** Pending queue for the execution layer. */
    async pendingActions(store_id) {
      const actions = await store.actions.find(
        (a) => a.store_id === store_id && a.status === "pending"
      );
      return actions.sort((a, b) => a.created_at.localeCompare(b.created_at));
    },

    async updateAction(action_id, patch) {
      return store.actions.update(action_id, patch);
    },
  };
}

module.exports = { createOrchestrator, ACTION_COOLDOWN_HOURS };
