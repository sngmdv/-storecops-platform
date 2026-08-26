"use strict";

/**
 * Layer 4 — Delivery Providers.
 *
 * Every provider implements the same tiny contract:
 *   send({ to, subject, body, meta }) -> { delivered: true, provider, message_id }
 *
 * The console provider ships enabled so the platform runs end-to-end
 * with zero credentials; swap in real adapters (Resend, WhatsApp
 * Business API, Intercom-style bot) by registering them here.
 */

const crypto = require("crypto");
const { createMetaWhatsAppProvider } = require("./whatsappService");

/**
 * Task 35: Sanitize a string for safe console output.
 * Strips non-printable and non-ASCII characters that cause mojibake
 * (garbled glyphs) when the terminal encoding mismatches the payload.
 */
function sanitizeForLog(text) {
  if (!text) return "";
  return String(text).replace(/[^\x20-\x7E\t]/g, "");
}

/**
 * Mask an email address for safe logging: show first char + domain initial.
 * e.g. "john.doe@example.com" → "j***@e***"
 */
function maskEmail(email) {
  if (!email || typeof email !== "string") return "***";
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.charAt(0)}***@${domain.charAt(0)}***`;
}

/**
 * Mask a phone number for safe logging: show last 4 digits.
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== "string") return "***";
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "***";
  return `***${digits.slice(-4)}`;
}

function createConsoleProvider(name) {
  return {
    provider: `console:${name}`,

    async send({ to, subject, body }) {
      const message_id = crypto.randomUUID();
      // Task 29: Never log raw PII in production.
      // Task 35: Sanitize output to prevent mojibake in console.
      const safeTo = sanitizeForLog(maskEmail(to) !== "***" ? maskEmail(to) : maskPhone(to));
      const safeSubject = sanitizeForLog((subject || "").slice(0, 60));
      const safeBody = sanitizeForLog((body || "").slice(0, 80));
      console.log(
        `[EXEC:${name.toUpperCase()}] to=${safeTo} subject="${safeSubject}" body="${safeBody}"`
      );
      return { delivered: true, provider: `console:${name}`, message_id };
    },
  };
}

/**
 * Build the Meta WhatsApp provider from environment/config. Returns
 * null if the required credentials are missing.
 */
function buildMetaWhatsAppProvider(config, store) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) return null;

  return createMetaWhatsAppProvider({
    accessToken,
    phoneNumberId,
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    apiVersion: process.env.WHATSAPP_API_VERSION || "v19.0",
    store,
  });
}

/**
 * Registry: provider name -> implementation. Real adapters plug in at
 * boot, e.g. registerProvider("email", resendAdapter).
 */
function createProviderRegistry(config, store) {
  const providers = {};

  function register(channel, provider) {
    providers[channel] = provider;
  }

  // ── Email ────────────────────────────────────────────────────────
  // Console is the default; "resend" wires to the Resend API.
  register(
    "email",
    config.providers.email === "console" ? createConsoleProvider("email") : null
  );

  // ── WhatsApp ─────────────────────────────────────────────────────
  // Console is the default; "meta" wires to the Meta Cloud API.
  if (config.providers.whatsapp === "meta") {
    const metaProvider = buildMetaWhatsAppProvider(config, store);
    register("whatsapp", metaProvider || createConsoleProvider("whatsapp"));
    if (!metaProvider) {
      console.log("[PROVIDER] WHATSAPP_PROVIDER=meta but credentials missing — falling back to console.");
    }
  } else {
    register("whatsapp", createConsoleProvider("whatsapp"));
  }

  register(
    "push",
    config.providers.push === "console" ? createConsoleProvider("push") : null
  );
  register("bot", createConsoleProvider("bot"));
  register("dashboard", createConsoleProvider("dashboard"));

  return {
    register,

    get(channel) {
      const provider = providers[channel];
      if (!provider) {
        throw new Error(
          `No provider registered for channel "${channel}". Configure one or use the console provider.`
        );
      }
      return provider;
    },

    channels() {
      return Object.keys(providers).filter((channel) => providers[channel]);
    },
  };
}

module.exports = { createConsoleProvider, createProviderRegistry, buildMetaWhatsAppProvider };
