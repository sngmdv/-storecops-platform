"use strict";

/**
 * WhatsApp Business API — Meta Cloud Adapter
 *
 * Sends messages via the Meta Cloud API (WhatsApp Business Platform).
 * Supports two message types:
 *
 *   1. Template messages — for business-initiated conversations
 *      (cart recovery, win-back, checkout nudge). Meta requires
 *      pre-approved templates for proactive messages.
 *
 *   2. Text messages — for session messages within the 24-hour
 *      customer-service window.
 *
 * Env vars:
 *   WHATSAPP_PROVIDER=meta
 *   WHATSAPP_ACCESS_TOKEN=<Meta system user token>
 *   WHATSAPP_PHONE_NUMBER_ID=<Phone number ID from Meta>
 *   WHATSAPP_BUSINESS_ACCOUNT_ID=<Business Account ID>
 *   WHATSAPP_API_VERSION=v19.0  (optional, defaults to v19.0)
 *   WHATSAPP_WEBHOOK_VERIFY_TOKEN=<token for webhook verification>
 *
 * The provider contract:
 *   send({ to, subject, body, meta }) -> { delivered, provider, message_id }
 *
 * `to` can be a phone number (E.164) or a customer identity that
 * resolves to a phone number via the customer profile store.
 */

const crypto = require("crypto");

const DEFAULT_API_VERSION = "v19.0";
const GRAPH_API_BASE = "https://graph.facebook.com";

/** Mask a phone number for safe logging: show last 4 digits. */
function maskPhone(phone) {
  if (!phone || typeof phone !== "string") return "***";
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "***";
  return `***${digits.slice(-4)}`;
}

/**
 * Map a message action type to the corresponding Meta-approved
 * template name. Merchants configure these templates in their
 * Meta Business Manager. The names here are sensible defaults;
 * override via WHATSAPP_TEMPLATE_<TYPE> env vars.
 */
const DEFAULT_TEMPLATE_MAP = {
  recovery_message: "cart_recovery",
  checkout_nudge: "checkout_reminder",
  winback_offer: "winback_discount",
  browse_abandonment: "browse_reminder",
  vip_surprise: "vip_thankyou",
};

function getTemplateName(actionType) {
  const envKey = `WHATSAPP_TEMPLATE_${actionType.toUpperCase()}`;
  return process.env[envKey] || DEFAULT_TEMPLATE_MAP[actionType] || "generic_message";
}

/**
 * Build the Meta Cloud API request body for a template message.
 *
 * Template messages are required for business-initiated conversations
 * outside the 24-hour customer service window. The template must be
 * pre-approved by Meta.
 *
 * We use the "utility" category for transactional messages (cart
 * recovery, checkout reminders) which don't need marketing approval.
 */
function buildTemplatePayload(to, actionType, body, params = {}) {
  const templateName = getTemplateName(actionType);

  const components = [];

  // Body component — pass dynamic parameters the template expects.
  const bodyParams = [];
  if (params.name) bodyParams.push({ type: "text", text: params.name });
  if (params.discount) bodyParams.push({ type: "text", text: String(params.discount) });
  if (params.code) bodyParams.push({ type: "text", text: params.code });

  if (bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParams,
    });
  }

  return {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en_US" },
      components,
    },
  };
}

/**
 * Build the Meta Cloud API request body for a free-form text message.
 * Used within the 24-hour customer service window.
 */
function buildTextPayload(to, body) {
  return {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: body || "" },
  };
}

/**
 * Create the Meta WhatsApp provider.
 *
 * @param {object} opts
 * @param {string} opts.accessToken - Meta system user access token
 * @param {string} opts.phoneNumberId - WhatsApp phone number ID
 * @param {string} [opts.businessAccountId] - Business Account ID (for webhooks)
 * @param {string} [opts.apiVersion] - Graph API version (default: v19.0)
 * @param {object} [opts.store] - Customer store for phone resolution
 */
function createMetaWhatsAppProvider({
  accessToken,
  phoneNumberId,
  businessAccountId,
  apiVersion = DEFAULT_API_VERSION,
  store,
}) {
  if (!accessToken) throw new Error("WHATSAPP_ACCESS_TOKEN is required for the Meta WhatsApp provider.");
  if (!phoneNumberId) throw new Error("WHATSAPP_PHONE_NUMBER_ID is required for the Meta WhatsApp provider.");

  const baseUrl = `${GRAPH_API_BASE}/${apiVersion}/${phoneNumberId}/messages`;

  /**
   * Resolve a customer identity to a phone number.
   *
   * The `to` field from the execution service is a customer identity
   * (e.g. "customer_123" or "session:abc"). For WhatsApp we need an
   * actual E.164 phone number. We look it up from the customer profile.
   *
   * If `to` already looks like a phone number (starts with +), use it
   * directly.
   */
  async function resolvePhone(to, meta) {
    if (!to) return null;

    // Already a phone number.
    if (/^\+?\d{8,}$/.test(to.replace(/[\s-]/g, ""))) {
      return to.replace(/[\s-]/g, "");
    }

    // Check meta for an explicit phone override.
    if (meta?.phone) return meta.phone;

    // Look up from customer profile.
    if (store) {
      const profile = await store.customers.findOne({ identity: to });
      if (profile?.phone) return profile.phone;
    }

    return null;
  }

  return {
    provider: "meta:whatsapp",

    /**
     * Send a WhatsApp message via the Meta Cloud API.
     *
     * @param {object} message
     * @param {string} message.to - Customer identity or phone number
     * @param {string} [message.subject] - Ignored for WhatsApp (no subject line)
     * @param {string} message.body - Message body text
     * @param {object} [message.meta] - Additional metadata
     * @param {string} [message.meta.action_type] - Maps to template name
     * @param {string} [message.meta.action_id] - For tracking
     * @param {boolean} [message.meta.use_text] - Force text mode (within 24h window)
     * @param {string} [message.meta.phone] - Explicit phone override
     */
    async send({ to, subject, body, meta }) {
      const phone = await resolvePhone(to, meta);
      if (!phone) {
        console.log(`[WHATSAPP] no phone number for ${maskPhone(to) || to} — skipping send`);
        return {
          delivered: false,
          provider: "meta:whatsapp",
          error: "no_phone_number",
          to,
        };
      }

      // Choose template vs text based on message type.
      const actionType = meta?.action_type;
      const useText = meta?.use_text || !actionType;
      const payload = useText
        ? buildTextPayload(phone, body)
        : buildTemplatePayload(phone, actionType, body, meta?.params || {});

      console.log(
        `[WHATSAPP] to=${maskPhone(phone)} type=${useText ? "text" : `template:${getTemplateName(actionType)}`} body="${(body || "").slice(0, 60)}"`
      );

      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const errMsg = errBody?.error?.message || `HTTP ${res.status}`;
        console.error(`[WHATSAPP] send failed: ${errMsg}`);
        return {
          delivered: false,
          provider: "meta:whatsapp",
          error: errMsg,
          error_code: errBody?.error?.code,
          to,
        };
      }

      const data = await res.json();
      const messageId = data?.messages?.[0]?.id || crypto.randomUUID();

      return {
        delivered: true,
        provider: "meta:whatsapp",
        message_id: messageId,
        to: phone,
      };
    },
  };
}

/**
 * Verify a Meta webhook signature (X-Hub-Signature-256).
 *
 * Meta signs every webhook payload with the app secret using
 * HMAC-SHA256. We verify the signature before processing any
 * status update to prevent spoofed delivery receipts.
 *
 * @param {string} rawBody - Raw request body string
 * @param {string} signature - Value of X-Hub-Signature-256 header
 * @param {string} appSecret - Meta app secret
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature, appSecret) {
  if (!rawBody || !signature || !appSecret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Parse incoming Meta webhook statuses into a normalized format.
 *
 * Meta sends status updates for every message:
 *   sent → delivered → read (or failed)
 *
 * We extract the relevant fields for our channel optimizer feedback.
 *
 * @param {object} webhookBody - Parsed webhook request body
 * @returns {Array<{message_id, phone, status, timestamp}>}
 */
function parseStatusUpdates(webhookBody) {
  const statuses = [];

  const entries = webhookBody?.entry || [];
  for (const entry of entries) {
    const changes = entry?.changes || [];
    for (const change of changes) {
      if (change.field !== "messages") continue;
      const value = change.value || {};
      const phone = value?.metadata?.display_phone_number || null;

      for (const status of value?.statuses || []) {
        statuses.push({
          message_id: status.id,
          phone,
          recipient: status.recipient_id,
          status: status.status, // sent, delivered, read, failed
          timestamp: status.timestamp,
          errors: status.errors || [],
        });
      }
    }
  }

  return statuses;
}

/**
 * Parse incoming Meta webhook messages (customer replies).
 *
 * When a customer replies to a WhatsApp message within the 24-hour
 * window, Meta forwards the message via webhook.
 *
 * @param {object} webhookBody - Parsed webhook request body
 * @returns {Array<{message_id, from, text, timestamp}>}
 */
function parseIncomingMessages(webhookBody) {
  const messages = [];

  const entries = webhookBody?.entry || [];
  for (const entry of entries) {
    const changes = entry?.changes || [];
    for (const change of changes) {
      if (change.field !== "messages") continue;
      const value = change.value || {};

      for (const msg of value?.messages || []) {
        if (msg.type !== "text") continue;
        messages.push({
          message_id: msg.id,
          from: msg.from,
          text: msg.text?.body || "",
          timestamp: msg.timestamp,
        });
      }
    }
  }

  return messages;
}

module.exports = {
  createMetaWhatsAppProvider,
  verifyWebhookSignature,
  parseStatusUpdates,
  parseIncomingMessages,
  buildTemplatePayload,
  buildTextPayload,
  getTemplateName,
  DEFAULT_TEMPLATE_MAP,
};
