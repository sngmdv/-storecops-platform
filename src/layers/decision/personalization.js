"use strict";

/**
 * Layer 3 — Personalization Engine.
 *
 * Turns intelligence outputs into customer-specific content: message
 * copy, offer selection and recommended product lists. The execution
 * layer only needs to deliver what this engine produces.
 */

const MESSAGE_TEMPLATES = {
  recovery_message: {
    email: {
      subject: "You left something in your cart",
      body: "Hi {name}, your cart is waiting. Complete your order in the next 24 hours and we'll hold your items for you.",
    },
    whatsapp: {
      body: "Hi {name} — quick heads up: your cart is saved and waiting. Finish checkout whenever you're ready.",
    },
  },
  recovery_reminder_1h: {
    email: {
      subject: "Your cart is still waiting",
      body: "Hi {name}, just a friendly reminder — the items in your cart are still available. Complete your checkout before they sell out.",
    },
    whatsapp: {
      body: "Hi {name}, quick reminder: your cart is still saved. Complete checkout before your items sell out!",
    },
  },
  recovery_escalation_3h: {
    email: {
      subject: "Don't miss out — your cart expires soon",
      body: "Hi {name}, your cart items are in high demand. We'll hold them for a little longer, but complete your order now to guarantee availability.",
    },
    whatsapp: {
      body: "Hi {name}, your cart items are selling fast! Complete your order now to guarantee availability.",
    },
  },
  recovery_final_24h: {
    email: {
      subject: "Last chance: {discount}% off to complete your order",
      body: "Hi {name}, this is your last chance! We've saved {discount}% off your cart as a thank-you for coming back. Use code {code} at checkout.",
    },
    whatsapp: {
      body: "Hi {name}, final chance! Enjoy {discount}% off your cart with code {code}. Complete your order now before it expires.",
    },
  },
  winback_offer: {
    email: {
      subject: "We miss you — here's {discount}% off",
      body: "Hi {name}, it's been a while. Here's {discount}% off your next order as a thank-you for being with us.",
    },
    whatsapp: {
      body: "Hi {name}, we miss you! Enjoy {discount}% off your next order with code {code}.",
    },
  },
  checkout_nudge: {
    email: {
      subject: "Almost there — finish your checkout",
      body: "Hi {name}, you were one step away. Your checkout is saved and ready when you are.",
    },
    whatsapp: {
      body: "Hi {name}, your checkout is saved. Pick up right where you left off.",
    },
  },
  browse_abandonment: {
    email: {
      subject: "Still thinking it over?",
      body: "Hi {name}, we saw you checking out some products. Here's a closer look at what caught your eye — happy to help you choose.",
    },
    whatsapp: {
      body: "Hi {name}, noticed you were browsing! Here are the products you looked at — want a recommendation?",
    },
  },
  vip_surprise: {
    email: {
      subject: "A little thank-you, just for you",
      body: "Hi {name}, you're one of our best customers — and it's been a few weeks since your last order. Enjoy early access to our new arrivals plus a surprise gift with your next purchase.",
    },
    whatsapp: {
      body: "Hi {name}! As one of our VIPs you get early access to new arrivals + a surprise gift on your next order. 💝",
    },
  },
};

/**
 * Offer-type personalization: pick the incentive most likely to move
 * this customer, based on their segment and value.
 */
const OFFER_BY_SEGMENT = {
  VIP: { offer_type: "gift", detail: "Free gift + early access", discount: 0 },
  HIGH_VALUE: { offer_type: "free_shipping", detail: "Free express shipping", discount: 5 },
  LOYAL: { offer_type: "vip_access", detail: "Early access to new drops", discount: 5 },
  NEW: { offer_type: "discount", detail: "Welcome discount", discount: 15 },
  AT_RISK: { offer_type: "discount", detail: "Come-back discount", discount: 15 },
  DEFECTED: { offer_type: "discount", detail: "Strong win-back discount", discount: 25 },
};

function chooseOffer(segment) {
  return OFFER_BY_SEGMENT[segment] || OFFER_BY_SEGMENT.NEW;
}

function interpolate(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    values[key] !== undefined ? String(values[key]) : `{${key}}`
  );
}

function createPersonalizationEngine({ store, recommendationEngine }) {
  return {
    /**
     * Build the deliverable content for an action.
     *
     * action: { type, channel, urgency, params }
     */
    async buildContent({ store_id, customer_id, action }) {
      const profile = await store.customers.findOne({ store_id, identity: customer_id });

      const values = {
        name: profile?.identity?.startsWith("session:") ? "there" : profile?.identity || "there",
        discount: action.params?.discount || 10,
        code: action.params?.code || `WELCOME${store_id.length}`.toUpperCase(),
        offer: action.params?.offer || "",
        step: action.params?.sequence_step || 1,
      };

      const channel = action.channel === "auto" ? "email" : action.channel;
      const templates = MESSAGE_TEMPLATES[action.type];
      const template = templates?.[channel] || templates?.email;

      if (!template) {
        throw new Error(`No message template for action type: ${action.type}`);
      }

      // Attach recommendations where it makes sense.
      let recommendations = [];
      if (["recovery_message", "winback_offer"].includes(action.type)) {
        const result = await recommendationEngine.recommend(store_id, customer_id, 3);
        recommendations = result.recommendations;
      }

      return {
        action_type: action.type,
        channel,
        subject: template.subject ? interpolate(template.subject, values) : undefined,
        body: interpolate(template.body, values),
        recommendations,
        customer_id,
        built_at: new Date().toISOString(),
      };
    },
  };
}

module.exports = { createPersonalizationEngine, interpolate, chooseOffer, MESSAGE_TEMPLATES, OFFER_BY_SEGMENT };
