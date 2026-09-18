'use strict';

/**
 * Central configuration.
 *
 * Every tunable in the platform reads from here so behaviour can be
 * adjusted via environment variables without touching engine code.
 *
 * In production, sensitive values MUST be set via environment variables.
 * The app will throw on startup if required secrets are missing.
 *
 * Beyond the required secrets, production also runs a readiness check
 * (src/config/readiness.js). That exists because the app previously booted
 * successfully while PUBLIC_URL pointed at an unreplaced hosting placeholder
 * and no outbound delivery credential existed — faults that are invisible at
 * runtime and only appear when a real merchant installs. See that module for
 * the full rationale.
 */

const { buildReadinessReport, formatReport, } = require('./readiness.js',);
const { resolveShopifyApiVersion, } = require('./shopifyApiVersion.js',);

// ─── Environment Validation ─────────────────────────────────────────────────

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

if (isProduction) {
  // Emergency escape hatch, documented and logged. Prefer fixing the config.
  if (process.env.SKIP_READINESS_CHECK === 'true') {
    console.warn(
      '[WARN] SKIP_READINESS_CHECK=true — startup configuration checks are disabled. ' +
      'Unset this once the deployment is correct.',
    );
  } else {
    const report = buildReadinessReport(process.env, { env: process.env.NODE_ENV, },);

    if (report.blocking.length > 0) {
      console.error(formatReport(report,),);
      console.error(
        '\n[FATAL] Refusing to start with a misconfigured deployment. ' +
        'Fix the BLOCKING items above, or set SKIP_READINESS_CHECK=true to override ' +
        '(not recommended — the app will serve broken URLs to merchants).',
      );
      process.exit(1,);
    }

    // Non-fatal, but the operator must know which features are inert.
    if (report.warnings.length > 0) {
      console.warn(formatReport(report,),);
      console.warn(
        '[WARN] The app will start, but the features above will not deliver anything. ' +
        'A merchant who installs and receives no message will treat the app as broken.',
      );
    }
  }
}

const config = {
  port: Number(process.env.PORT || 4000,),
  env: process.env.NODE_ENV || 'development',
  apiKey: process.env.API_KEY || 'dev-key',

  /**
   * Express `trust proxy`.
   *
   * Behind a reverse proxy (Railway, Heroku, Fly, nginx) `req.ip` is the
   * *proxy's* address unless this is configured. That matters because the rate
   * limiter keys on `req.ip`: without it every visitor shares one bucket, so a
   * per-IP limit becomes a global limit and a handful of requests locks out
   * every merchant at once.
   *
   * It is not simply `true`, because trusting the header when the app is also
   * directly reachable lets a client spoof `X-Forwarded-For` and evade the
   * limit. The value has to describe the real topology, so it is configurable:
   * a hop count, `true`, `false`, or an Express preset such as `loopback`.
   * Defaults to a single trusted hop in production, where these hosts all
   * terminate TLS at exactly one proxy.
   */
  trustProxy: (() => {
    const raw = process.env.TRUST_PROXY;
    if (raw === undefined || raw === '') {
      return process.env.NODE_ENV === 'production' ? 1 : false;
    }
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const asNumber = Number(raw,);
    return Number.isFinite(asNumber,) ? asNumber : raw;
  })(),
  defaultStoreId: process.env.DEFAULT_STORE_ID || 'store_demo',

  // Public-facing URL of the platform (used for OAuth callbacks, billing
  // return URLs, Script Tag src, webhook addresses).
  publicUrl: process.env.PUBLIC_URL || '',

  // Shopify API version. Derived from src/config/shopifyApiVersion.js so there is
  // exactly one copy of the default — see that module for why. Override via
  // SHOPIFY_API_VERSION.
  shopifyApiVersion: resolveShopifyApiVersion(),

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

  // Data-retention policy (Task 14) — enforced by src/server/dataRetention.js.
  //
  // Named `dataRetention`, NOT `retention`: `retentionEngine` is the unrelated
  // customer-retention product feature (churn/health scoring). The two names
  // colliding is part of why this policy sat here with zero consumers.
  //
  // Enforcement is opt-in via RETENTION_ENABLED=true. Deleting production data
  // on a timer is not something that should begin because a config object
  // happened to exist — the previous state was a documented policy that nothing
  // read, which is worse than either enforcing it or removing it.
  dataRetention: {
    enabled: String(process.env.RETENTION_ENABLED || '',).toLowerCase() === 'true',
    intervalHours: Number(process.env.RETENTION_INTERVAL_HOURS || 24,),
    // Rows older than these windows are deleted. A value of 0 (or anything
    // non-positive) disables that collection's policy — it never means
    // "delete everything".
    events: Number(process.env.RETENTION_EVENTS_DAYS || 365,),
    deliveries: Number(process.env.RETENTION_DELIVERIES_DAYS || 180,),
    // HELD BY DEFAULT. privacy.html §4 says consent records are "retained
    // indefinitely (or until revocation + 2 years for audit)" — note the
    // parenthetical is measured from *revocation*, which a timestamp sweep
    // cannot evaluate, and the config value below would have deleted them 2
    // years after creation regardless. A consent record is also the evidence
    // that we had permission to contact someone, so deleting it destroys the
    // proof we would need in a dispute. Enforce only with
    // RETENTION_ENFORCE_CONSENT=true.
    consentRecords: Number(process.env.RETENTION_CONSENT_DAYS || 730,),
    enforceConsent: String(process.env.RETENTION_ENFORCE_CONSENT || '',).toLowerCase() === 'true',
    monitoringEvents: Number(process.env.RETENTION_MONITORING_DAYS || 90,),
    sessions: Number(process.env.RETENTION_SESSIONS_DAYS || 30,),
  },

  security: {
    // HMAC secret for inbound webhooks (empty = verification disabled).
    webhookSecret: process.env.WEBHOOK_SECRET || '',
    // Shopify app CLIENT SECRET — used to verify Shopify's webhook HMAC
    // (X-Shopify-Hmac-Sha256, base64). Distinct from webhookSecret above.
    shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    // Sliding-window API rate limit per key/IP.
    rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000,),
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 300,),
    // Credential endpoints get their own, much tighter ceiling. The general
    // 300/60s limit is sized for the data API and is useless against password
    // guessing — a human signs in a few times an hour, an attacker tries
    // thousands. Applied per IP, on top of the per-account throttle in
    // src/server/loginThrottle.js.
    authRateLimitWindowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 900000,),
    authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX || 20,),
    // Per-account lockout: failures tolerated, then the base lockout (which
    // doubles per further failure, capped at 24h).
    loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS || 5,),
    loginLockoutMs: Number(process.env.LOGIN_LOCKOUT_MS || 900000,),
    // How long `/ready` waits for `store.ping()` before declaring the storage
    // backend unreachable. Configurable because it is coupled to a *deploy-time*
    // value: `railway.json` sets `healthcheckTimeout: 120` (seconds) against
    // `healthcheckPath: /ready`, so this bound must stay well inside it or the
    // orchestrator gives up first and the probe's diagnostic is never seen.
    // test/readinessEndpoint.test.js asserts that relationship directly.
    // A value that is not a positive finite number falls back to the default
    // rather than becoming 0, which would fail every probe instantly.
    readinessPingTimeoutMs: Number(process.env.READINESS_PING_TIMEOUT_MS || 2000,),
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
