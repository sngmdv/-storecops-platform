"use strict";

/**
 * Layer 3 — Rules Engine.
 *
 * Declarative condition → action rules. Ships with platform defaults
 * (cart recovery, win-back, sentiment escalation) and supports custom
 * rules per store. Conditions are simple field comparisons against an
 * evaluation context so they stay auditable and testable.
 */

const OPERATORS = {
  gt: (value, threshold) => value > threshold,
  gte: (value, threshold) => value >= threshold,
  lt: (value, threshold) => value < threshold,
  lte: (value, threshold) => value <= threshold,
  eq: (value, threshold) => value === threshold,
  in: (value, options) => options.includes(value),
};

/**
 * Default rules every store gets unless disabled. The `when` array is
 * AND-composed; every condition must pass for the rule to fire.
 */
const DEFAULT_RULES = [
  {
    rule_id: "cart_recovery",
    name: "Abandoned cart recovery",
    trigger: "cart_abandoned",
    when: [{ field: "abandoned_carts", op: "gte", value: 1 }],
    action: { type: "recovery_message", channel: "auto", urgency: "high" },
    priority: 10,
  },
  {
    rule_id: "churn_winback",
    name: "High churn risk win-back",
    trigger: "churn_risk",
    when: [{ field: "churn_score", op: "gte", value: 70 }],
    action: { type: "winback_offer", channel: "auto", urgency: "medium" },
    priority: 8,
  },
  {
    rule_id: "checkout_nudge",
    name: "Checkout started but not completed",
    trigger: "checkout_started",
    when: [{ field: "purchases", op: "eq", value: 0 }],
    action: { type: "checkout_nudge", channel: "auto", urgency: "medium" },
    priority: 6,
  },
  {
    rule_id: "sentiment_escalation",
    name: "Negative brand sentiment escalation",
    trigger: "sentiment_alert",
    when: [{ field: "health_score", op: "lte", value: -25 }],
    action: { type: "internal_alert", channel: "dashboard", urgency: "critical" },
    priority: 9,
  },
  {
    rule_id: "browse_abandonment",
    name: "Browse abandonment recovery",
    trigger: "product_view",
    when: [
      { field: "product_views", op: "gte", value: 3 },
      { field: "cart_updates", op: "eq", value: 0 },
    ],
    action: { type: "browse_abandonment", channel: "auto", urgency: "low" },
    priority: 4,
  },
  {
    rule_id: "vip_surprise",
    name: "VIP surprise & delight",
    trigger: "vip_check",
    when: [
      { field: "total_spent", op: "gte", value: 500 },
      { field: "days_since_purchase", op: "gte", value: 30 },
    ],
    action: { type: "vip_surprise", channel: "auto", urgency: "low" },
    priority: 5,
  },
];

function evaluateConditions(conditions, context) {
  const matched = [];

  for (const condition of conditions || []) {
    const operator = OPERATORS[condition.op];
    if (!operator) continue;

    const value = context[condition.field];
    if (value !== undefined && operator(value, condition.value)) {
      matched.push(condition);
    }
  }

  return matched.length === (conditions || []).length ? matched : null;
}

function createRulesEngine({ store }) {
  return {
    DEFAULT_RULES,

    /** All active rules for a store: defaults + custom. */
    async activeRules(store_id) {
      const custom = await store.rules.find({ store_id });
      return [...DEFAULT_RULES, ...custom]
        .filter((rule) => rule.enabled !== false)
        .sort((a, b) => b.priority - a.priority);
    },

    /** Register a custom rule for a store. */
    async addRule(store_id, rule) {
      if (!rule || !rule.trigger || !Array.isArray(rule.when) || !rule.action) {
        throw new Error("A rule needs a trigger, a `when` condition array and an action.");
      }

      for (const condition of rule.when) {
        if (!OPERATORS[condition.op]) {
          throw new Error(`Unknown operator: ${condition.op}`);
        }
      }

      return store.rules.insert({
        store_id,
        rule_id: rule.rule_id || `custom_${Date.now()}`,
        name: rule.name || "Custom rule",
        trigger: rule.trigger,
        when: rule.when,
        action: rule.action,
        priority: rule.priority || 1,
        enabled: rule.enabled !== false,
      });
    },

    /** Evaluate a context against all active rules for a trigger. */
    async evaluate({ store_id, trigger, context }) {
      const rules = await this.activeRules(store_id);

      return rules
        .filter((rule) => rule.trigger === trigger)
        .map((rule) => {
          const matched = evaluateConditions(rule.when, context);
          return matched ? { rule, matched_conditions: matched } : null;
        })
        .filter(Boolean);
    },
  };
}

module.exports = { createRulesEngine, evaluateConditions, DEFAULT_RULES };
