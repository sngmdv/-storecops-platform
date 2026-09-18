'use strict';

/**
 * Sub-processor register (COMP-004).
 *
 * THE SINGLE SOURCE OF TRUTH for `public/subprocessors.html`.
 *
 * Why this exists as a module rather than as prose on the page: the page used to
 * be the only copy, and it had already drifted. `privacy.html` section 3 listed
 * Shopify, Meta, Resend, "SQLite" and Redis — omitting Railway (the actual host),
 * the payment providers, SerpApi, and every third-party asset the browser loads.
 * A hand-maintained compliance list drifts the same way `API.md` drifted (11 of
 * 30 documented routes were 404s), so it gets the same treatment: derive the set,
 * and fail a test when the two disagree.
 *
 * `test/subprocessors.test.js` enforces three things:
 *   1. every third-party host appearing in `src/` is declared below, or is a
 *      documented non-request host (a namespace, a doc link, a placeholder);
 *   2. every declared host actually still appears in `src/`, so a stale entry
 *      fails rather than lingering;
 *   3. the published page names every entry, and invents none.
 *
 * WHAT THIS CANNOT DETECT: providers reached through an SDK rather than a URL
 * literal, and infrastructure (the host itself). Those entries declare
 * `hosts: []` and carry a `detection` note saying how they are known. The point
 * is that the gap is written down, not that the guard is omniscient.
 */

/** Grouping used by the published page. */
const CATEGORY = {
  INFRASTRUCTURE: 'infrastructure',
  PLATFORM: 'platform',
  DELIVERY: 'delivery',
  PAYMENTS: 'payments',
  INTELLIGENCE: 'intelligence',
  ASSETS: 'assets',
  SOURCES: 'sources',
};

/**
 * Parties that process merchant or shopper personal data on our behalf.
 *
 * `dataCategories` describes what reaches them — this is the part a merchant's
 * DPA questionnaire asks about, so it is stated explicitly rather than implied.
 * `hosts` is what the guard checks against `src/`; `detection` records how the
 * entry is known when `hosts` is empty.
 */
const SUBPROCESSORS = [
  {
    key: 'railway',
    name: 'Railway',
    category: CATEGORY.INFRASTRUCTURE,
    purpose: 'Application hosting, persistent database volume, backups and log retention.',
    dataCategories: 'All data the platform stores, including merchant and shopper personal data.',
    hosts: [],
    detection: 'infrastructure — the deploy target (railway.json, RAILWAY_VOLUME_MOUNT_PATH)',
  },
  {
    key: 'shopify',
    name: 'Shopify',
    category: CATEGORY.PLATFORM,
    purpose: 'Source of store, product, order and customer data; app embedding; billing; mandatory privacy webhooks.',
    dataCategories: 'Store domain, product catalogue, orders, customer name/email/phone, access tokens (encrypted at rest).',
    hosts: ['admin.shopify.com', 'cdn.shopify.com', 'extensions.shopifycdn.com',],
  },
  {
    key: 'meta',
    name: 'Meta (WhatsApp Business API)',
    category: CATEGORY.DELIVERY,
    purpose: 'Delivery of cart-recovery and campaign messages over WhatsApp; public Ad Library reads for competitor intelligence.',
    dataCategories: 'Shopper phone number and message content, where the merchant has connected WhatsApp.',
    hosts: ['graph.facebook.com',],
  },
  {
    key: 'resend',
    name: 'Resend',
    category: CATEGORY.DELIVERY,
    purpose: 'Transactional and marketing email delivery.',
    dataCategories: 'Shopper and merchant email address, message content.',
    hosts: ['api.resend.com',],
  },
  {
    key: 'bigcommerce',
    name: 'BigCommerce',
    category: CATEGORY.PLATFORM,
    purpose: 'Merchant platform integration (catalogue, orders) when the merchant connects BigCommerce.',
    dataCategories: 'Store domain, product catalogue, orders, access tokens (encrypted at rest).',
    hosts: ['api.bigcommerce.com', 'login.bigcommerce.com',],
  },
  {
    key: 'serpapi',
    name: 'SerpApi',
    category: CATEGORY.INTELLIGENCE,
    purpose: 'Search-result data used for SEO recommendations.',
    dataCategories: 'Search keywords only — no shopper or merchant personal data is sent.',
    hosts: ['serpapi.com',],
  },
  {
    key: 'stripe',
    name: 'Stripe',
    category: CATEGORY.PAYMENTS,
    purpose: 'Subscription payment processing, when enabled.',
    dataCategories: 'Merchant billing contact and payment method, held by the provider.',
    hosts: [],
    detection: 'declared in config (`config.payments.stripe`); no URL literal in src/',
  },
  {
    key: 'razorpay',
    name: 'Razorpay',
    category: CATEGORY.PAYMENTS,
    purpose: 'Subscription payment processing, when enabled.',
    dataCategories: 'Merchant billing contact and payment method, held by the provider.',
    hosts: [],
    detection: 'declared in config (`config.payments.razorpay`); no URL literal in src/',
  },
  {
    key: 'redis',
    name: 'Redis',
    category: CATEGORY.INFRASTRUCTURE,
    purpose: 'Queue and cache backend, when the deployment configures it instead of in-process storage.',
    dataCategories: 'Queued job payloads and session/throttle counters — may contain personal data.',
    hosts: [],
    detection: 'storage adapter (`src/storage/redisStore.js`); reachable only when STORAGE=redis',
  },
];

/**
 * Third-party assets the browser loads directly. Not sub-processors in the
 * GDPR Art. 28 sense — we do not send them personal data — but the visitor's IP
 * address and referrer reach them, so they belong on a public disclosure.
 */
const THIRD_PARTY_ASSETS = [
  {
    key: 'unpkg',
    name: 'unpkg (Lucide icon bundle)',
    category: CATEGORY.ASSETS,
    purpose: 'Icon set, loaded by app.html and index.html.',
    hosts: ['unpkg.com',],
  },
  {
    key: 'jsdelivr',
    name: 'jsDelivr',
    category: CATEGORY.ASSETS,
    purpose: 'Content delivery, permitted by the Content-Security-Policy.',
    hosts: ['cdn.jsdelivr.net',],
  },
  {
    key: 'google-fonts',
    name: 'Google Fonts',
    category: CATEGORY.ASSETS,
    purpose: 'Web fonts used by the marketing and app pages.',
    hosts: ['fonts.googleapis.com', 'fonts.gstatic.com',],
  },
];

/**
 * Public pages read for market signals. Read-only, no personal data sent, no
 * account relationship — disclosed for completeness rather than as processors.
 */
const PUBLIC_DATA_SOURCES = [
  {
    key: 'google-trends',
    name: 'Google Trends',
    category: CATEGORY.SOURCES,
    purpose: 'Daily trending searches, used as a demand signal.',
    hosts: ['trends.google.com',],
  },
  {
    key: 'reddit',
    name: 'Reddit',
    category: CATEGORY.SOURCES,
    purpose: 'Public subreddit listings, used as a demand signal.',
    hosts: ['www.reddit.com',],
  },
  {
    key: 'pinterest',
    name: 'Pinterest',
    category: CATEGORY.SOURCES,
    purpose: 'Public search pages, used as a demand signal.',
    hosts: ['www.pinterest.com',],
  },
];

/**
 * Hosts that appear in `src/` but are not requests to anybody.
 *
 * Each needs a reason: the guard fails on an unexplained host, which is the
 * whole point — a new outbound integration cannot be added silently.
 */
const NON_REQUEST_HOSTS = [
  { host: 'schema.org', reason: 'JSON-LD `@context` vocabulary, emitted into generated markup — never fetched.', },
  { host: 'www.w3.org', reason: 'XML namespace URI in generated sitemaps — a namespace, not a URL to call.', },
  { host: 'llmstxt.org', reason: 'Specification reference cited in generated `llms.txt` output.', },
  { host: 'shopify.dev', reason: 'Documentation link in a comment.', },
  { host: 'docs.railway.com', reason: 'Documentation link explaining the Railway build variables.', },
  { host: 'developers.facebook.com', reason: 'Documentation link for the Meta Ad Library.', },
  { host: 'resend.com', reason: 'Documentation link in the email service.', },
  { host: 'example.com', reason: 'Placeholder rejected by the boot-time readiness check.', },
  { host: 'your-app.up.railway.app', reason: 'The unreplaced hosting placeholder that the readiness check refuses to boot on — named in the rejection, never contacted.', },
  { host: 'storecops.com', reason: 'Our own public domain, used in outbound links and defaults.', },
  { host: 'storecops.app', reason: 'Our own domain, used as the contact URL in the competitor-scraper User-Agent.', },
  { host: 'app.storecops.ai', reason: 'Our own dashboard domain, linked from scheduled report emails.', },
];

/** Every declared entry, regardless of category — what the page must name. */
const ALL_ENTRIES = [...SUBPROCESSORS, ...THIRD_PARTY_ASSETS, ...PUBLIC_DATA_SOURCES,];

/** Host -> owning entry key. Built once so the guard cannot disagree with itself. */
function hostOwners() {
  const owners = new Map();
  for (const entry of ALL_ENTRIES) {
    for (const host of entry.hosts || []) {
      if (owners.has(host,)) {
        throw new Error(`host "${host}" is declared by both "${owners.get(host,)}" and "${entry.key}"`,);
      }
      owners.set(host, entry.key,);
    }
  }
  for (const { host, } of NON_REQUEST_HOSTS) {
    if (owners.has(host,)) {
      throw new Error(`host "${host}" is both a declared processor and a non-request host`,);
    }
    owners.set(host, null,);
  }
  return owners;
}

module.exports = {
  CATEGORY,
  SUBPROCESSORS,
  THIRD_PARTY_ASSETS,
  PUBLIC_DATA_SOURCES,
  NON_REQUEST_HOSTS,
  ALL_ENTRIES,
  hostOwners,
};
