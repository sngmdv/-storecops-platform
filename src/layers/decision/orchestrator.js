'use strict';

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

function createOrchestrator({ store, rulesEngine, churnScoring, brandSentiment, ahaMomentService, },) {
  /** Dedup guard: one action per customer per rule inside the cooldown. */
  async function recentlyActed(store_id, customer_id, rule_id,) {
    const cutoff = new Date(Date.now() - ACTION_COOLDOWN_HOURS * 60 * 60 * 1000,).toISOString();
    const existing = await store.actions.find(
      (a,) =>
        a.store_id === store_id &&
        a.customer_id === customer_id &&
        a.rule_id === rule_id &&
        a.created_at >= cutoff,
    );
    return existing.length > 0;
  }

  async function queueAction({ store_id, customer_id, rule, context, source, },) {
    if (await recentlyActed(store_id, customer_id, rule.rule_id,)) {
      return { skipped: true, reason: 'cooldown', rule_id: rule.rule_id, };
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
      status: 'pending',
      created_at: new Date().toISOString(),
    },);

    return { skipped: false, action, };
  }

  /** Queue a drip sequence: multiple scheduled actions for the same customer+rule. */
  async function queueDripSequence({ store_id, customer_id, rule, context, source, },) {
    const sequenceId = `seq_${Date.now()}_${customer_id.replace(/[^a-z0-9]/gi, '',)}`;
    const results = [];

    for (const step of rule.drip_sequence.steps) {
      const sendAfter = new Date(Date.now() + step.delay_ms,).toISOString();
      const action = await store.actions.insert({
        store_id,
        customer_id,
        rule_id: rule.rule_id,
        rule_name: rule.name,
        type: step.type,
        channel: rule.action.channel,
        urgency: step.urgency,
        params: { ...rule.action.params, sequence_step: step.step, },
        context,
        source,
        status: 'pending',
        send_after: sendAfter,
        sequence_id: sequenceId,
        sequence_step: step.step,
        created_at: new Date().toISOString(),
      },);
      results.push(action,);
    }

    return { skipped: false, actions: results, sequence_id: sequenceId, };
  }

  /** Cancel all pending actions in a drip sequence (e.g. if customer completes purchase). */
  async function cancelDripSequence(store_id, customer_id, rule_id,) {
    const pending = await store.actions.find(
      (a,) =>
        a.store_id === store_id &&
        a.customer_id === customer_id &&
        a.rule_id === rule_id &&
        a.status === 'pending' &&
        a.sequence_id,
    );

    for (const action of pending) {
      await store.actions.update(action._id, {
        status: 'cancelled',
        cancel_reason: 'sequence_cancelled',
        cancelled_at: new Date().toISOString(),
      },);
    }

    return { cancelled: pending.length, };
  }

  return {
    /**
     * Real-time path: called right after Layer 1 logs a high-priority
     * event. Builds an evaluation context from the customer profile
     * and fires matching rules.
     */
    async handleEvent(event,) {
      const profile = await store.customers.findOne(
        (c,) =>
          c.store_id === event.store_id &&
          (c.identity === (event.customer_id || event.email) ||
            (event.session_id && c.identity === `session:${event.session_id}`)),
      );

      if (!profile) return { evaluated: false, actions: [], };

      // Cancel any pending drip sequences when a purchase is completed
      if (['purchase', 'checkout_completed',].includes(event.event_type,)) {
        await this.cancelSequences(event.store_id, profile.identity,);
      }

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
      },);

      const results = [];
      for (const { rule, } of matches) {
        if (rule.drip_sequence && rule.drip_sequence.enabled) {
          // Cancel any existing pending sequence before starting a new one
          await cancelDripSequence(event.store_id, profile.identity, rule.rule_id,);
          const seqResult = await queueDripSequence({
            store_id: event.store_id,
            customer_id: profile.identity,
            rule,
            context,
            source: `event:${event.event_type}`,
          },);
          results.push(seqResult,);
        } else {
          results.push(
            await queueAction({
              store_id: event.store_id,
              customer_id: profile.identity,
              rule,
              context,
              source: `event:${event.event_type}`,
            },),
          );
        }
      }

      const queuedActions = results
        .filter((r,) => !r.skipped,)
        .flatMap((r,) => r.actions || (r.action ? [r.action,] : []),);

      // Check for aha moments after processing the event
      if (ahaMomentService && queuedActions.length > 0) {
        const event_type = event.event_type;
        const momentData = {};
        for (const action of queuedActions) {
          if (action.type === 'recovery_message') momentData.cart_recoveries = (momentData.cart_recoveries || 0) + 1;
          if (action.type === 'browse_abandonment') momentData.browse_abandonments = (momentData.browse_abandonments || 0) + 1;
        }
        await ahaMomentService.checkMoments(event.store_id, event_type, momentData,);
      }

      return {
        evaluated: true,
        customer_id: profile.identity,
        actions: queuedActions,
        skipped: results.filter((r,) => r.skipped,).length,
      };
    },

    /**
     * Cancel all pending drip sequence actions for a customer.
     * Called when a customer completes a purchase or recovers their cart.
     */
    async cancelSequences(store_id, customer_id,) {
      const rules = await rulesEngine.activeRules(store_id,);
      let totalCancelled = 0;

      for (const rule of rules) {
        if (rule.drip_sequence && rule.drip_sequence.enabled) {
          const result = await cancelDripSequence(store_id, customer_id, rule.rule_id,);
          totalCancelled += result.cancelled;
        }
      }

      return { cancelled: totalCancelled, };
    },

    /**
     * Batch path: periodic store-wide scan for churn risk, brand
     * sentiment and VIP surprise & delight. Returns every queued action.
     */
    async scanStore(store_id,) {
      const queued = [];

      // Churn win-back.
      const scores = await churnScoring.scoreStore(store_id,);
      for (const score of scores) {
        const matches = await rulesEngine.evaluate({
          store_id,
          trigger: 'churn_risk',
          context: { churn_score: score.churn_score, },
        },);

        for (const { rule, } of matches) {
          const result = await queueAction({
            store_id,
            customer_id: score.customer_id,
            rule,
            context: { churn_score: score.churn_score, risk_band: score.risk_band, },
            source: 'scan:churn',
          },);
          if (!result.skipped) queued.push(result.action,);
        }
      }

      // Brand sentiment escalation.
      const sentiment = await brandSentiment.analyze(store_id,);
      if (sentiment.sample_count > 0) {
        const matches = await rulesEngine.evaluate({
          store_id,
          trigger: 'sentiment_alert',
          context: { health_score: sentiment.health_score, },
        },);

        for (const { rule, } of matches) {
          const result = await queueAction({
            store_id,
            customer_id: null,
            rule,
            context: { health_score: sentiment.health_score, },
            source: 'scan:sentiment',
          },);
          if (!result.skipped) queued.push(result.action,);
        }
      }

      // Browse abandonment: heavy browsing, zero carts, zero purchases.
      const allProfiles = (await store.customers.find({ store_id, },)).filter(
        (profile,) => !profile.merged_into,
      );
      for (const profile of allProfiles) {
        if (profile.purchases > 0 || profile.cart_updates > 0) continue;

        const matches = await rulesEngine.evaluate({
          store_id,
          trigger: 'product_view',
          context: {
            product_views: profile.product_views,
            cart_updates: profile.cart_updates,
          },
        },);

        for (const { rule, } of matches) {
          const result = await queueAction({
            store_id,
            customer_id: profile.identity,
            rule,
            context: { product_views: profile.product_views, viewed_products: profile.viewed_products, },
            source: 'scan:browse',
          },);
          if (!result.skipped) queued.push(result.action,);
        }
      }

      // VIP surprise & delight: high-LTV customers gone quiet.
      const profiles = allProfiles;
      let vipChecked = 0;
      for (const profile of profiles) {
        const daysSincePurchase = profile.last_purchase_at
          ? Math.floor((Date.now() - new Date(profile.last_purchase_at,).getTime()) / DAY_MS,)
          : null;
        if (daysSincePurchase === null) continue;
        vipChecked += 1;

        const matches = await rulesEngine.evaluate({
          store_id,
          trigger: 'vip_check',
          context: { total_spent: profile.total_spent, days_since_purchase: daysSincePurchase, },
        },);

        for (const { rule, } of matches) {
          const result = await queueAction({
            store_id,
            customer_id: profile.identity,
            rule: {
              ...rule,
              action: { ...rule.action, params: { offer: 'early access + surprise gift', ...rule.action.params, }, },
            },
            context: { total_spent: profile.total_spent, days_since_purchase: daysSincePurchase, },
            source: 'scan:vip',
          },);
          if (!result.skipped) queued.push(result.action,);
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
    async pendingActions(store_id,) {
      const actions = await store.actions.find(
        (a,) => a.store_id === store_id && a.status === 'pending',
      );
      return actions.sort((a, b,) => a.created_at.localeCompare(b.created_at,),);
    },

    async updateAction(action_id, patch,) {
      return store.actions.update(action_id, patch,);
    },
  };
}

module.exports = { createOrchestrator, ACTION_COOLDOWN_HOURS, };
