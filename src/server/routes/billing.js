'use strict';

/**
 * Billing, referral, trial, regional pricing, monitoring, store connections.
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

const { shopifyWebhookVerifier, } = require('../security',);
const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, } = ctx;

  // ── Billing & Entitlements (Tasks 41-45) ────────────────────────────

  router.get(
    '/billing/:store_id/entitlement',
    wrap(async (req,) => platform.billingService.getEntitlement(req.params.store_id,),),
  );

  router.get(
    '/billing/plans',
    wrap(async () => platform.billingService.PLANS,),
  );

  router.get(
    '/billing/:store_id/price/:currency',
    wrap(async (req,) => {
      const planId = req.query.plan || 'growth';
      return platform.billingService.getRegionalPrice(planId, req.params.currency,);
    },),
  );

  router.post(
    '/billing/:store_id/subscription',
    wrap(async (req,) =>
      platform.billingService.upsertSubscription(req.params.store_id, req.body || {},),
    ),
  );

  router.post(
    '/billing/webhook',
    wrap(async (req,) => platform.billingService.handleSubscriptionEvent(req.body || {},),),
  );

  // Task 41: Create a Shopify recurring application charge.
  router.post(
    '/billing/:store_id/charge',
    wrap(async (req,) => {
      const { shop_domain, access_token, plan_id, currency, test, } = req.body || {};
      if (!shop_domain || !access_token) throw new Error('shop_domain and access_token are required.',);
      return platform.billingService.createShopifyCharge(shop_domain, access_token, plan_id || 'growth', {
        shopInstallationId: req.params.store_id,
        return_url: req.body?.return_url,
        currency,
        test,
      },);
    },),
  );

  // Task 43: Shopify app_subscriptions/update webhook handler.
  // This is called by Shopify when a merchant accepts/declines/cancels
  // a recurring charge. Signature verified by shopifyWebhookVerifier
  // (X-Shopify-Hmac-Sha256, base64 HMAC-SHA256 over raw body, client secret).
  router.post(
    '/billing/shopify-webhook',
    shopifyWebhookVerifier(platform.config.security?.shopifyClientSecret,),
    wrap(async (req,) => platform.billingService.handleShopifySubscriptionWebhook(req.body || {},),),
  );

  // ── Referral & Affiliate System ──────────────────────────────────

  // Get referral code for merchant
  router.get(
    '/referral/:store_id/code',
    wrap(async (req,) => {
      const merchant = await platform.store.users.findOne({ store_id: req.params.store_id, },);
      if (!merchant) throw new Error('Merchant not found',);
      return platform.referralService.getOrCreateReferralCode(merchant._id, req.params.store_id,);
    },),
  );

  // Get referral stats for merchant
  router.get(
    '/referral/:store_id/stats',
    wrap(async (req,) => {
      const merchant = await platform.store.users.findOne({ store_id: req.params.store_id, },);
      if (!merchant) throw new Error('Merchant not found',);
      return platform.referralService.getStats(merchant._id,);
    },),
  );

  // Validate referral code (used during signup)
  router.post(
    '/referral/validate',
    wrap(async (req,) => {
      const { code, merchant_id, store_id, ip, } = req.body || {};
      if (!code || !merchant_id || !store_id) throw new Error('code, merchant_id, and store_id are required',);
      return platform.referralService.validateReferral(code, merchant_id, store_id, { ip, },);
    },),
  );

  // Apply referral discount
  router.post(
    '/referral/:store_id/apply',
    wrap(async (req,) => {
      const merchant = await platform.store.users.findOne({ store_id: req.params.store_id, },);
      if (!merchant) throw new Error('Merchant not found',);
      return platform.referralService.applyReferralDiscount(merchant._id,);
    },),
  );

  // Check referral eligibility
  router.get(
    '/referral/:store_id/eligibility',
    wrap(async (req,) => {
      const merchant = await platform.store.users.findOne({ store_id: req.params.store_id, },);
      if (!merchant) throw new Error('Merchant not found',);
      return platform.referralService.checkEligibility(merchant._id,);
    },),
  );

  // List all referrals (admin)
  router.get(
    '/admin/referrals',
    wrap(async (req,) => platform.referralService.listAll(Number(req.query.limit,) || 100,),),
  );

  // ── Trial Management ────────────────────────────────────────────

  // Start trial
  router.post(
    '/trial/:store_id/start',
    wrap(async (req,) => {
      const { plan, } = req.body || {};
      return platform.trialService.startTrial(req.params.store_id, req.params.store_id, plan || 'growth',);
    },),
  );

  // Get trial status
  router.get(
    '/trial/:store_id/status',
    wrap(async (req,) => platform.trialService.getTrialStatus(req.params.store_id,),),
  );

  // Check feature access during trial
  router.get(
    '/trial/:store_id/feature/:feature',
    wrap(async (req,) => platform.trialService.canAccessFeature(req.params.store_id, req.params.feature,),),
  );

  // Convert trial to paid
  router.post(
    '/trial/:store_id/convert',
    wrap(async (req,) => {
      const { subscription_id, } = req.body || {};
      return platform.trialService.convertTrial(req.params.store_id, subscription_id,);
    },),
  );

  // Cancel trial
  router.post(
    '/trial/:store_id/cancel',
    wrap(async (req,) => platform.trialService.cancelTrial(req.params.store_id,),),
  );

  // Get trial analytics (admin)
  router.get(
    '/admin/trial/analytics',
    wrap(async () => platform.trialService.getAnalytics(),),
  );

  // Get expiring trials (admin)
  router.get(
    '/admin/trial/expiring',
    wrap(async (req,) => platform.trialService.getExpiringTrials(Number(req.query.days,) || 3,),),
  );

  // ── Regional Pricing (PPP) ──────────────────────────────────────

  // Get regional price for a plan
  router.get(
    '/pricing/regional/:country',
    wrap(async (req,) => {
      const { plan, cycle, } = req.query;
      return platform.subscriptionPricing.getRegionalPrice(plan || 'growth', req.params.country, cycle || 'monthly',);
    },),
  );

  // Get all prices for a region
  router.get(
    '/pricing/all/:country',
    wrap(async (req,) => platform.subscriptionPricing.getAllPrices(req.params.country,),),
  );

  // Detect country from IP
  router.get(
    '/pricing/detect-country',
    wrap(async (req,) => {
      const ip = req.headers['x-forwarded-for'] || req.ip;
      // The edge (Cloudflare / Vercel / CloudFront) resolves the country
      // already; forward it so detectCountry works when fronted. Headers are
      // a pricing hint, never an auth signal — see subscriptionPricing.js.
      const hints = {
        'cf-ipcountry': req.headers['cf-ipcountry'],
        'x-vercel-ip-country': req.headers['x-vercel-ip-country'],
        'cloudfront-viewer-country': req.headers['cloudfront-viewer-country'],
        'x-appengine-country': req.headers['x-appengine-country'],
        'x-country-code': req.headers['x-country-code'],
      };
      const detected = await platform.subscriptionPricing.detectCountry(ip, hints,);
      return detected;
    },),
  );

  // Validate regional pricing
  router.post(
    '/pricing/validate',
    wrap(async (req,) => {
      const { merchant_id, country, ip, billing_address, } = req.body || {};
      return platform.subscriptionPricing.validateRegionalPricing(merchant_id, country, ip, billing_address, req.headers || {},);
    },),
  );

  // Get PPP stats (admin)
  router.get(
    '/admin/pricing/stats',
    wrap(async () => platform.subscriptionPricing.getStats(),),
  );

  // ── Monitoring & Health (Task 65) ───────────────────────────────────

  router.get(
    '/monitoring/health',
    wrap(async (req,) =>
      platform.monitoringService.getHealthSummary(Number(req.query.hours,) || 24,),
    ),
  );

  router.get(
    '/monitoring/events',
    wrap(async (req,) =>
      platform.monitoringService.getRecentEvents({
        type: req.query.type,
        shopInstallationId: req.query.shopInstallationId,
        severity: req.query.severity,
        limit: Number(req.query.limit,) || 50,
      },),
    ),
  );

  router.get(
    '/monitoring/counters',
    wrap(async () => platform.monitoringService.getCounters(),),
  );

  // ── Secret Rotation (Task 27) ───────────────────────────────────────

  router.get(
    '/secrets/:store_id',
    wrap(async (req,) => platform.secretRotation.listSecrets(req.params.store_id,),),
  );

  router.post(
    '/secrets/:store_id/rotate/shopify',
    wrap(async (req,) =>
      platform.secretRotation.rotateShopifyToken(req.params.store_id, req.body?.new_token || '', {
        rotated_by: req.authUser?.email || 'admin',
        reason: req.body?.reason || 'manual',
      },),
    ),
  );

  router.post(
    '/secrets/:store_id/rotate/api-key',
    wrap(async (req,) =>
      platform.secretRotation.rotateApiKey(req.params.store_id, {
        rotated_by: req.authUser?.email || 'admin',
        reason: req.body?.reason || 'manual',
      },),
    ),
  );

  router.get(
    '/secrets/expiring',
    wrap(async (req,) =>
      platform.secretRotation.getExpiringSecrets(Number(req.query.within_days,) || 14,),
    ),
  );

  // ── Demo data (powers the web app's instant-live experience) ──────────

  router.post(
    '/demo/seed',
    wrap(async (req,) => platform.demoSeed.seed(req.body?.store_id || platform.config.defaultStoreId,),),
  );

  // ── Task ob5: Admin store management ───────────────────────────────

  // List all connected stores with health status.
  router.get(
    '/admin/stores',
    wrap(async () => {
      const stores = await platform.integrations.listAllStores();
      return { stores, count: stores.length, };
    },),
  );

  // Trigger a manual re-sync for a specific store.
  router.post(
    '/admin/stores/:store_id/resync',
    wrap(async (req,) => {
      const result = await platform.integrations.resyncStore(req.params.store_id,);
      return { store_id: req.params.store_id, ...result, };
    },),
  );

  // Get onboarding state for a store.
  router.get(
    '/admin/stores/:store_id/onboarding',
    wrap(async (req,) => {
      const onboarding = await platform.integrations.getOnboardingState(req.params.store_id,);
      return { store_id: req.params.store_id, onboarding, };
    },),
  );

  // Update an onboarding step.
  router.post(
    '/admin/stores/:store_id/onboarding',
    wrap(async (req,) => {
      const { step, value, } = req.body || {};
      if (!step) throw new Error('step is required.',);
      const onboarding = await platform.integrations.updateOnboardingStep(req.params.store_id, step, value !== false,);
      return { store_id: req.params.store_id, onboarding, };
    },),
  );

  // ── Store Connections (how real shops plug in) ─────────────────────

  router.get(
    '/integrations/:store_id',
    wrap(async (req,) => platform.integrations.status(req.params.store_id,),),
  );

  router.get(
    '/integrations/:store_id/snippet',
    wrap(async (req,) => {
      // Prefer the tenant's write-only ingest key; fall back to the
      // presented API key (dev/demo flows).
      const owner = req.authUser?.email
        ? await platform.store.users.findOne({ email: req.authUser.email, },)
        : null;
      const ingest = owner?.ingest_key || req.get('X-API-Key',) || platform.config.apiKey;
      return {
        store_id: req.params.store_id,
        snippet: platform.integrations.generateSnippet(req.params.store_id, ingest,),
        webhook_url: platform.integrations.webhookUrl(req.params.store_id,),
        csv_format: {
          products: 'product_id,name,stock,lead_time_days,price',
          orders: 'customer_id,email,total,product_id,quantity,timestamp',
        },
      };
    },),
  );

  router.post(
    '/integrations/:store_id/csv',
    wrap(async (req,) =>
      platform.integrations.importCSV(req.params.store_id, req.body?.type, req.body?.csv,),
    ),
  );

  router.post(
    '/integrations/:store_id/shopify',
    wrap(async (req,) => platform.integrations.syncShopify(req.params.store_id, req.body || {},),),
  );

  router.post(
    '/integrations/:store_id/woocommerce',
    wrap(async (req,) => platform.integrations.syncWooCommerce(req.params.store_id, req.body || {},),),
  );

  // One-click connect for a signed-in tenant: returns the platform's
  // OAuth authorize URL; the callback syncs straight into this store.
  router.post(
    '/integrations/:store_id/connect/:platform/start',
    wrap(async (req,) => {
      if (!req.authUser?.email) throw new Error('Sign in with an account to use one-click connect.',);
      return platform.oauth.startLink(req.params.platform, req.authUser.email, req.body || {},);
    },),
  );

  // Custom stores: prove ownership first (challenge), then finalize after verify.
  router.post(
    '/integrations/:store_id/connect/custom',
    wrap(async (req,) => platform.oauth.startCustomLink(req.body || {},),),
  );
  router.post(
    '/integrations/:store_id/connect/custom/finalize',
    wrap(async (req,) => platform.oauth.completeCustomLink(req.params.store_id, req.body || {},),),
  );

  // Platform connector credentials (Shopify/BigCommerce app client ids).
  router.get('/connectors', wrap(async () => platform.oauth.status(),),);

  router.put(
    '/connectors/:platform',
    platform.rbac.middleware('administer',),
    wrap(async (req,) => {
      await platform.oauth.setConfig(
        req.params.platform,
        req.body?.client_id,
        req.body?.client_secret,
      );
      await platform.auditLog.record(req.get('X-User',) || req.authUser?.email || 'admin', 'connector_configured', {
        platform: req.params.platform,
      },);
      return { ok: true, platform: req.params.platform, };
    },),
  );

}

module.exports = { register, };
