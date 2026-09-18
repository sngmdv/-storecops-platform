'use strict';

/**
 * Templates, notification preferences, feature flags, channel config.
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, } = ctx;

  // ── Demo Simulator ──────────────────────────────────────────────────
  router.get(
    '/demo/status',
    wrap(async () => ({
      running: platform.demoSimulator.isRunning(),
      running_stores: platform.demoSimulator.runningStores(),
      events_generated: platform.demoSimulator.eventCount(),
    }),),
  );

  router.post(
    '/demo/tick/:store_id',
    wrap(async (req,) => {
      const result = await platform.demoSimulator.tickOnce(req.params.store_id,);
      return { success: true, ...result, };
    },),
  );

  // ── Templates Management ──────────────────────────────────────────
  const templateStore = {};

  router.get(
    '/templates/:store_id',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      if (!templateStore[storeId]) {
        templateStore[storeId] = [
          { id: 'cart_recovery', name: 'Cart Recovery', channel: 'email', subject: 'You left something behind!', body: 'Hi {name}, you left items in your cart.', active: true, stats: { sent: 1247, opened: 892, clicked: 341, }, },
          { id: 'browse_abandon', name: 'Browse Abandonment', channel: 'email', subject: 'Still interested in these items?', body: 'Hi {name}, we noticed you were browsing.', active: true, stats: { sent: 856, opened: 534, clicked: 178, }, },
          { id: 'winback', name: 'Win-Back Campaign', channel: 'email', subject: 'We miss you, {name}!', body: 'It\'s been a while since your last visit.', active: true, stats: { sent: 432, opened: 267, clicked: 89, }, },
          { id: 'welcome', name: 'Welcome Series', channel: 'email', subject: 'Welcome to {store_name}!', body: 'Thanks for joining us!', active: true, stats: { sent: 2100, opened: 1890, clicked: 756, }, },
          { id: 'whatsapp_cart', name: 'WhatsApp Cart Recovery', channel: 'whatsapp', subject: 'Your cart is waiting', body: 'Don\'t forget your items!', active: false, stats: { sent: 0, opened: 0, clicked: 0, }, },
          { id: 'weekly_digest', name: 'Weekly Digest', channel: 'email', subject: 'Your weekly performance report', body: 'Here\'s what happened this week.', active: true, stats: { sent: 1200, opened: 840, clicked: 420, }, },
          { id: 'price_drop', name: 'Price Drop Alert', channel: 'email', subject: 'Price dropped on {product_name}!', body: 'Good news - the price dropped.', active: true, stats: { sent: 567, opened: 423, clicked: 234, }, },
          { id: 'back_in_stock', name: 'Back in Stock', channel: 'email', subject: '{product_name} is back!', body: 'The item you wanted is available again.', active: true, stats: { sent: 234, opened: 198, clicked: 156, }, },
        ];
      }
      return { templates: templateStore[storeId], };
    },),
  );

  router.post(
    '/templates/:store_id',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      if (!templateStore[storeId]) templateStore[storeId] = [];
      const template = { id: `tmpl_${Date.now()}`, ...req.body, stats: { sent: 0, opened: 0, clicked: 0, }, };
      templateStore[storeId].push(template,);
      return template;
    },),
  );

  router.put(
    '/templates/:store_id/:template_id',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      const templates = templateStore[storeId] || [];
      const idx = templates.findIndex((t,) => t.id === req.params.template_id,);
      if (idx === -1) throw new Error('Template not found',);
      templates[idx] = { ...templates[idx], ...req.body, };
      return templates[idx];
    },),
  );

  router.delete(
    '/templates/:store_id/:template_id',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      templateStore[storeId] = (templateStore[storeId] || []).filter((t,) => t.id !== req.params.template_id,);
      return { success: true, };
    },),
  );

  router.post(
    '/templates/:store_id/:template_id/test',
    wrap(async (req,) => {
      return { success: true, message: `Test email sent to ${req.body.email || 'test@example.com'}`, };
    },),
  );

  // ── Notifications Preferences ─────────────────────────────────────
  const notifStore = {};

  router.get(
    '/notifications/:store_id/preferences',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      if (!notifStore[storeId]) {
        notifStore[storeId] = {
          email: [
            { id: 'cart_abandon', name: 'Cart abandonment alerts', enabled: true, },
            { id: 'stock_alert', name: 'Stock level warnings', enabled: true, },
            { id: 'competitor_price', name: 'Competitor price changes', enabled: false, },
            { id: 'churn_risk', name: 'Churn risk warnings', enabled: true, },
            { id: 'campaign_perf', name: 'Campaign performance', enabled: false, },
            { id: 'seo_issues', name: 'SEO issues', enabled: false, },
            { id: 'weekly_report', name: 'Weekly report', enabled: true, },
            { id: 'defection_alert', name: 'Defection alerts', enabled: true, },
            { id: 'revenue_milestone', name: 'Revenue milestones', enabled: true, },
            { id: 'new_review', name: 'New product review', enabled: false, },
          ],
          inApp: [
            { id: 'cart_abandon', name: 'Cart abandonment alerts', enabled: true, },
            { id: 'stock_alert', name: 'Stock level warnings', enabled: true, },
            { id: 'competitor_price', name: 'Competitor price changes', enabled: true, },
            { id: 'churn_risk', name: 'Churn risk warnings', enabled: true, },
            { id: 'campaign_perf', name: 'Campaign performance', enabled: true, },
            { id: 'seo_issues', name: 'SEO issues', enabled: true, },
            { id: 'weekly_report', name: 'Weekly report', enabled: false, },
            { id: 'defection_alert', name: 'Defection alerts', enabled: true, },
            { id: 'revenue_milestone', name: 'Revenue milestones', enabled: true, },
            { id: 'new_review', name: 'New product review', enabled: true, },
          ],
          channels: { email: true, inApp: true, push: false, sms: false, },
          quietHours: { enabled: false, start: '22:00', end: '08:00', },
        };
      }
      return notifStore[storeId];
    },),
  );

  router.put(
    '/notifications/:store_id/preferences',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      notifStore[storeId] = { ...notifStore[storeId], ...req.body, };
      return notifStore[storeId];
    },),
  );

  router.post(
    '/notifications/:store_id/test',
    wrap(async (req,) => {
      return { success: true, message: `Test notification sent via ${req.body.channel || 'email'}`, };
    },),
  );

  // ── Feature Flags ─────────────────────────────────────────────────
  const featureStore = {};

  router.get(
    '/features/:store_id',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      if (!featureStore[storeId]) {
        featureStore[storeId] = [
          { id: 'cart_recovery', name: 'Cart Recovery', desc: 'Automated recovery emails for abandoned carts', active: true, category: 'Revenue', },
          { id: 'browse_abandon', name: 'Browse Abandonment', desc: 'Recovery for visitors who didn\'t add to cart', active: true, category: 'Revenue', },
          { id: 'competitor_tracking', name: 'Competitor Tracking', desc: 'Monitor competitor prices and products', active: true, category: 'Intelligence', },
          { id: 'seo_audit', name: 'SEO Audit & Fix', desc: 'Automatic SEO analysis and fixes', active: true, category: 'Growth', },
          { id: 'churn_detection', name: 'Churn Detection', desc: 'Identify customers at risk of leaving', active: true, category: 'Retention', },
          { id: 'dynamic_pricing', name: 'Dynamic Pricing', desc: 'AI-powered pricing recommendations', active: false, category: 'Revenue', },
          { id: 'inventory_advisor', name: 'Inventory Advisor', desc: 'Stock level monitoring and reorder suggestions', active: true, category: 'Operations', },
          { id: 'campaigns', name: 'Campaign Manager', desc: 'Email and WhatsApp campaign creation', active: true, category: 'Marketing', },
          { id: 'trend_detection', name: 'Trend Detection', desc: 'Monitor trending products on social media', active: false, category: 'Intelligence', },
          { id: 'ad_intelligence', name: 'Ad Intelligence', desc: 'Track competitor Meta/Google ads', active: false, category: 'Intelligence', },
          { id: 'recommendations', name: 'Product Recommendations', desc: 'AI-powered product suggestions', active: true, category: 'Revenue', },
          { id: 'sentiment_tracking', name: 'Sentiment Tracking', desc: 'Monitor brand sentiment online', active: false, category: 'Intelligence', },
        ];
      }
      return { features: featureStore[storeId], };
    },),
  );

  router.put(
    '/features/:store_id/:feature_id',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      const features = featureStore[storeId] || [];
      const idx = features.findIndex((f,) => f.id === req.params.feature_id,);
      if (idx === -1) throw new Error('Feature not found',);
      features[idx].active = req.body.active !== undefined ? req.body.active : !features[idx].active;
      return features[idx];
    },),
  );

  // ── Billing Management ────────────────────────────────────────────
  router.get(
    '/billing/:store_id/invoices',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      const subs = await platform.billingService.listSubscriptions({},);
      const mine = (subs || []).filter((s,) => s.shopInstallationId === storeId,);
      return {
        invoices: mine.map((s,) => ({
          id: s._id || s.shopifyChargeId,
          plan: s.planId,
          status: s.status,
          currency: s.currency,
          price_monthly: s.price_monthly,
          started_at: s.started_at,
          current_period_end: s.current_period_end,
          cancelled_at: s.cancelled_at,
        }),),
      };
    },),
  );

  router.post(
    '/billing/:store_id/upgrade',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      const body = req.body || {};
      let shop_domain = body.shop_domain;
      let access_token = body.access_token;
      // Resolve from the stored Shopify connection when not supplied inline.
      if (!shop_domain || !access_token) {
        const conn = await platform.store.integrations.findOne({ store_id: storeId, },);
        const creds = (conn && conn.config) || conn || {};
        shop_domain = shop_domain || creds.shop_domain;
        access_token = access_token || creds.access_token;
      }
      if (!shop_domain || !access_token) {
        throw new Error('No Shopify connection found for this store. Reconnect the store, then retry the upgrade.',);
      }
      return platform.billingService.createShopifyCharge(
        shop_domain,
        access_token,
        body.plan || 'growth',
        { shopInstallationId: storeId, currency: body.currency, test: body.test, },
      );
    },),
  );

  router.post(
    '/billing/:store_id/cancel',
    wrap(async (req,) => {
      return platform.billingService.handleSubscriptionEvent({
        shopInstallationId: req.params.store_id,
        action: 'cancelled',
      },);
    },),
  );

  router.get(
    '/billing/:store_id/usage',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      const [events, deliveries,] = await Promise.all([
        platform.store.events.find({ store_id: storeId, },),
        platform.store.deliveries.find({ store_id: storeId, },),
      ],);
      const entitlement = await platform.billingService.getEntitlement(storeId,);
      const subs = await platform.billingService.listSubscriptions({},);
      const mine = (subs || []).filter((s,) => s.shopInstallationId === storeId,);
      return {
        period: {
          start: entitlement.subscription?.started_at || null,
          end: entitlement.subscription?.current_period_end || null,
        },
        events: { used: (events || []).length, },
        deliveries: { sent: (deliveries || []).length, },
        subscriptions: mine.length,
        plan: entitlement.id,
      };
    },),
  );

  // ── Channel Configuration ─────────────────────────────────────────
  router.put(
    '/channels/:store_id/email',
    wrap(async (req,) => {
      return { success: true, message: 'Email configuration updated', config: req.body, };
    },),
  );

  router.put(
    '/channels/:store_id/whatsapp',
    wrap(async (req,) => {
      return { success: true, message: 'WhatsApp configuration updated', config: req.body, };
    },),
  );

  router.put(
    '/channels/:store_id/push',
    wrap(async (req,) => {
      return { success: true, message: 'Push notification configuration updated', config: req.body, };
    },),
  );

  router.post(
    '/channels/:store_id/test',
    wrap(async (req,) => {
      const { channel, } = req.body;
      return { success: true, message: `Test message sent via ${channel}`, };
    },),
  );

  // ── Price History ─────────────────────────────────────────────────
  router.get(
    '/competitors/:store_id/price-history',
    wrap(async (req,) => {
      const storeId = req.params.store_id;
      const snapshots = await platform.competitorIngestor.latestSnapshots(storeId,);
      return {
        history: (snapshots || []).map((s,) => ({
          competitor: s.competitor,
          product: s.product,
          price: s.price,
          captured_at: s.captured_at,
        }),),
      };
    },),
  );

}

module.exports = { register, };
