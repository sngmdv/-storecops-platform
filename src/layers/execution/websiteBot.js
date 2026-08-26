"use strict";

/**
 * Layer 4 — Website Assistant Bot.
 *
 * Rule-based conversational bot that plugs into the same intelligence
 * layer as everything else: it can recommend products, report order
 * context and answer stock/price questions from competitor data.
 */

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
}

function createWebsiteBot({ recommendationEngine, competitorIngestor }) {
  const INTENTS = [
    { id: "recommendation", patterns: ["recommend", "suggest", "what should i buy", "best product"] },
    { id: "shipping", patterns: ["shipping", "delivery", "how long", "arrive"] },
    { id: "returns", patterns: ["return", "refund", "exchange"] },
    { id: "price_match", patterns: ["cheaper", "price match", "better price", "discount"] },
    { id: "order_status", patterns: ["order status", "track my order", "where is my order"] },
    { id: "greeting", patterns: ["hi", "hello", "hey"] },
  ];

  function detectIntent(message) {
    const text = normalize(message);

    for (const intent of INTENTS) {
      if (intent.patterns.some((pattern) => text.includes(pattern))) {
        return intent.id;
      }
    }
    return "fallback";
  }

  return {
    detectIntent,

    /**
     * Handle one visitor message.
     *
     * input: { store_id, customer_id, message }
     */
    async reply({ store_id, customer_id, message }) {
      const intent = detectIntent(message);
      let response;
      let payload = null;

      switch (intent) {
        case "recommendation": {
          const result = await recommendationEngine.recommend(store_id, customer_id, 3);
          payload = result;
          response =
            result.recommendations.length > 0
              ? `Based on what you've been browsing, I'd point you at: ${result.recommendations
                  .map((r) => r.product_id)
                  .join(", ")}.`
              : "Our most popular items are on the homepage — take a look and I'll learn your taste as you browse!";
          break;
        }
        case "shipping":
          response =
            "Standard shipping takes 3–5 business days; express options are available at checkout.";
          break;
        case "returns":
          response =
            "You can return any item within 30 days of delivery for a full refund — no questions asked.";
          break;
        case "price_match": {
          // Show we watch the market: quote the cheapest competitor for context.
          try {
            const snapshots = await competitorIngestor.latestSnapshots(store_id);
            const prices = snapshots.flatMap((s) => s.products.map((p) => p.price));
            payload = { competitor_count: snapshots.length };
            response =
              prices.length > 0
                ? "We continuously monitor market pricing to stay competitive. Add the item to your cart and any active offers apply automatically."
                : "We price against the market continuously. Tell me the product and I'll check for you.";
          } catch {
            response = "Let me check that for you — which product did you have in mind?";
          }
          break;
        }
        case "order_status":
          response =
            "You can track your order from the account page. If you share your order number, our team will jump on it.";
          break;
        case "greeting":
          response =
            "Hi! I can recommend products, check pricing, and answer shipping or returns questions. What do you need?";
          break;
        default:
          response =
            "I can help with product recommendations, shipping, returns and pricing. Could you rephrase, or ask about one of those?";
      }

      return {
        store_id,
        customer_id,
        intent,
        response,
        payload,
        replied_at: new Date().toISOString(),
      };
    },
  };
}

module.exports = { createWebsiteBot };
