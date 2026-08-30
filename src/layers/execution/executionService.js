"use strict";

/**
 * Layer 4 — Execution Service.
 *
 * Drains the orchestrator's pending queue: resolves the best delivery
 * channel, builds personalized content, sends through the provider
 * registry, records the delivery and feeds the sent-event back into
 * the data layer so the channel optimizer keeps learning (Layer 6
 * growth loop).
 */

const SENT_EVENT_BY_CHANNEL = {
  email: "email_sent",
  whatsapp: "whatsapp_sent",
};

function createExecutionService({
  store,
  orchestrator,
  personalization,
  channelOptimizer,
  providerRegistry,
  consentService,
  billingService,
}) {
  return {
    /** Execute one action end to end. */
    async executeAction(action) {
      // Internal alerts go to the dashboard, not to customers.
      if (action.type === "internal_alert" || !action.customer_id) {
        const provider = providerRegistry.get("dashboard");
        const result = await provider.send({
          to: "store-admin",
          subject: `[ALERT] ${action.rule_name}`,
          body: `Rule "${action.rule_name}" fired (${action.urgency}). Context: ${JSON.stringify(action.context)}`,
        });

        await store.deliveries.insert({
          store_id: action.store_id,
          action_id: action._id,
          channel: "dashboard",
          provider: result.provider,
          message_id: result.message_id,
          delivered_at: new Date().toISOString(),
        });

        return orchestrator.updateAction(action._id, { status: "delivered", channel: "dashboard" });
      }

      // ── Consent gate (Tasks 36-40) ──────────────────────────────────
      // Every customer message must pass consent + suppression checks.
      if (consentService) {
        const messageClass = action.message_classification || action.type || "marketing";
        const channel = action.channel || "email";
        const check = await consentService.canSend(
          action.store_id,
          action.customer_id,
          messageClass,
          channel
        );
        if (!check.allowed) {
          return orchestrator.updateAction(action._id, {
            status: "suppressed",
            suppression_reason: check.reason,
            suppressed_at: new Date().toISOString(),
          });
        }
      }

      // ── Billing gate (Tasks 41-45) ──────────────────────────────────
      // Premium features require an active paid subscription.
      if (billingService && (action.channel === "whatsapp" || action.type === "campaign")) {
        try {
          const featureKey = action.channel === "whatsapp" ? "whatsapp_recovery" : "campaigns";
          await billingService.requireFeature(action.store_id, featureKey);
        } catch (err) {
          if (err.code === "FEATURE_LOCKED") {
            return orchestrator.updateAction(action._id, {
              status: "blocked",
              block_reason: err.message,
              blocked_at: new Date().toISOString(),
            });
          }
          throw err;
        }
      }

      // Channel resolution: explicit or learned.
      let channel = action.channel;
      let channelReason = "rule";
      if (channel === "auto") {
        const picked = await channelOptimizer.bestChannel(action.store_id, action.customer_id);
        channel = picked.channel;
        channelReason = picked.reason;
      }

      // Build personalized content.
      const content = await personalization.buildContent({
        store_id: action.store_id,
        customer_id: action.customer_id,
        action: { ...action, channel },
      });

      // Resolve phone for WhatsApp delivery. The provider needs an
      // actual phone number, not just a customer identity.
      let phoneOverride = null;
      if (channel === "whatsapp") {
        const profile = await store.customers.findOne({ store_id: action.store_id, identity: action.customer_id });
        phoneOverride = profile?.phone || null;
      }

      // Deliver.
      const provider = providerRegistry.get(channel);
      const result = await provider.send({
        to: action.customer_id,
        subject: content.subject,
        body: content.body,
        meta: {
          action_id: action._id,
          action_type: action.type,
          recommendations: content.recommendations,
          params: action.params || {},
          phone: phoneOverride,
        },
      });

      // Record delivery + feedback event for learning.
      await store.deliveries.insert({
        store_id: action.store_id,
        action_id: action._id,
        customer_id: action.customer_id,
        channel,
        channel_reason: channelReason,
        provider: result.provider,
        message_id: result.message_id,
        subject: content.subject,
        delivered_at: new Date().toISOString(),
      });

      const sentEvent = SENT_EVENT_BY_CHANNEL[channel];
      if (sentEvent) {
        await channelOptimizer.recordOutcome({
          store_id: action.store_id,
          customer_id: action.customer_id,
          channel,
          event_type: sentEvent,
        });
      }

      return orchestrator.updateAction(action._id, {
        status: "delivered",
        channel,
        delivered_at: new Date().toISOString(),
      });
    },

    /** Drain the full pending queue for a store. Only process actions where send_after <= now. */
    async processStore(store_id) {
      const pending = await orchestrator.pendingActions(store_id);
      const now = new Date();
      const ready = pending.filter((action) => {
        if (!action.send_after) return true;
        return new Date(action.send_after) <= now;
      });
      const results = { processed: 0, delivered: 0, failed: 0, errors: [], deferred: pending.length - ready.length };

      for (const action of ready) {
        try {
          await this.executeAction(action);
          results.delivered += 1;
        } catch (error) {
          results.failed += 1;
          results.errors.push({ action_id: action._id, error: error.message });
          await orchestrator.updateAction(action._id, {
            status: "failed",
            error: error.message,
          });
        }
        results.processed += 1;
      }

      return { store_id, ...results, processed_at: new Date().toISOString() };
    },
  };
}

module.exports = { createExecutionService };
