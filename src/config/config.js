'use strict';

/**
 * Central configuration.
 *
 * Every tunable in the platform reads from here so behaviour can be
 * adjusted via environment variables without touching engine code.
 *
 * In production, sensitive values MUST be set via environment variables.
 * The app will throw on startup if required secrets are missing.
 */

// ─── Environment Validation ─────────────────────────────────────────────────

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const requiredInProduction = [
  'API_KEY',
  'WEBHOOK_SECRET',
  'TOKEN_ENCRYPTION_KEY',
];

if (isProduction) {
  const missing = requiredInProduction.filter((key,) => !process.env[key],);
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required environment variables for production: ${missing.join(', ',)}`,);
    console.error('[FATAL] Set these in your deployment environment before starting the server.',);
    process.exit(1,);
  }
  
  // Warn about default fallback values
  if (process.env.API_KEY === 'dev-key') {
    console.error('[FATAL] API_KEY cannot be \'dev-key\' in production',);
    process.exit(1,);
  }
  if (process.env.TOKEN_ENCRYPTION_KEY === 'storecops-default-key-do-not-use-in-prod') {
    console.error('[FATAL] TOKEN_ENCRYPTION_KEY cannot be the default value in production',);
    process.exit(1,);
  }
}

const config = {
  port: Number(process.env.PORT || 4000,),
  env: process.env.NODE_ENV || 'development',
  apiKey: process.env.API_KEY || 'dev-key',
  defaultStoreId: process.env.DEFAULT_STORE_ID || 'store_demo',

  // Public-facing URL of the platform (used for OAuth callbacks, billing
  // return URLs, Script Tag src, webhook addresses).
  publicUrl: process.env.PUBLIC_URL || '',

  // Shopify API version (Task 63: keep current)
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || '2025-01',

  // Persistence: "sqlite" survives restarts; tests default to memory.
  storage:
    process.env.STORAGE ||
    (process.env.NODE_ENV === 'test' ? 'memory' : 'sqlite'),
  sqlitePath: process.env.SQLITE_PATH || 'data/storecops.db',

  // Auth: how long a login session stays valid.
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 7,),

  providers: {
    email: process.env.EMAIL_PROVIDER || 'console',
    whatsapp: process.env.WHATSAPP_PROVIDER || 'console',
    push: process.env.PUSH_PROVIDER || 'console',
  },

  intelligence: {
    churnInactiveDays: Number(process.env.CHURN_INACTIVE_DAYS || 30,),
    forecastWindow: Number(process.env.FORECAST_WINDOW || 7,),
  },

  // ROI calculator: the client's monthly subscription cost.
  subscriptionCostMonthly: Number(process.env.SUBSCRIPTION_COST || 49,),

  // Redis configuration (Task 60: production reliability)
  // In production, use a managed Redis instance — never localhost.
  redis: {
    url: process.env.REDIS_URL || '',
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379,),
    password: process.env.REDIS_PASSWORD || '',
    tls: process.env.REDIS_TLS === 'true',
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'storecops:',
  },

  // Data retention policy (Task 14)
  retention: {
    events: Number(process.env.RETENTION_EVENTS_DAYS || 365,),
    deliveries: Number(process.env.RETENTION_DELIVERIES_DAYS || 180,),
    consentRecords: Number(process.env.RETENTION_CONSENT_DAYS || 730,),
    monitoringEvents: Number(process.env.RETENTION_MONITORING_DAYS || 90,),
    sessions: Number(process.env.RETENTION_SESSIONS_DAYS || 30,),
  },

  security: {
    // HMAC secret for inbound webhooks (empty = verification disabled).
    webhookSecret: process.env.WEBHOOK_SECRET || '',
    // Sliding-window API rate limit per key/IP.
    rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000,),
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 300,),
    // Retry configuration for external API calls (Task 64)
    maxRetries: Number(process.env.MAX_RETRIES || 3,),
    retryBaseDelayMs: Number(process.env.RETRY_BASE_DELAY_MS || 1000,),
  },

  // ── Payment Configuration ──────────────────────────────────────────
  payment: {
    // Stripe (global payments)
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY || '',
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
      publicKey: process.env.STRIPE_PUBLIC_KEY || '',
    },
    // Razorpay (India payments — UPI, net banking, wallets, cards)
    razorpay: {
      keyId: process.env.RAZORPAY_KEY_ID || '',
      keySecret: process.env.RAZORPAY_KEY_SECRET || '',
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    },
    // Plans — canonical source is src/layers/execution/billingService.js:23 PLANS
    // starter=free, growth=$49/mo, scale=$149/mo. `premium` is alias of `scale` for compat.
    plans: {
      starter: { monthly: 0, annual: 0, currency: 'usd', },
      growth: { monthly: 49, annual: 468, currency: 'usd', }, // $39/mo billed annually
      scale: { monthly: 149, annual: 1428, currency: 'usd', }, // $119/mo billed annually
      premium: { monthly: 149, annual: 1428, currency: 'usd', }, // alias: premium === scale
      // INR pricing (Razorpay) — mirrors billingService REGIONAL_PRICING
      starter_inr: { monthly: 0, annual: 0, currency: 'inr', },
      growth_inr: { monthly: 3999, annual: 39990, currency: 'inr', },
      scale_inr: { monthly: 11999, annual: 119990, currency: 'inr', },
      premium_inr: { monthly: 11999, annual: 119990, currency: 'inr', }, // alias
    },
    // GST for Indian customers
    gstRate: Number(process.env.GST_RATE || 18,),
    // Refund policy
    refundWindowDays: Number(process.env.REFUND_WINDOW_DAYS || 14,),
    // Auto-renew notice days before charge
    autoRenewNoticeDays: Number(process.env.AUTO_RENEW_NOTICE_DAYS || 7,),
  },
};

module.exports = config;
