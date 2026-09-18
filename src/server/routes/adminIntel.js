'use strict';

/**
 * Retention, revenue and admin intelligence, payment.
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, } = ctx;

  // ── Retention Engine (admin revenue protection) ──────────────────

  // Full retention analysis: health scores, revenue metrics, risk bands.
  router.get(
    '/admin/retention/dashboard',
    wrap(async () => {
      const analysis = await platform.retentionEngine.analyzeAllStores();
      await platform.retentionEngine.recordSnapshot(analysis,);
      return analysis;
    },),
  );

  // Revenue metrics only (MRR, churn, LTV, NRR).
  router.get(
    '/admin/retention/metrics',
    wrap(async () => platform.retentionEngine.getRevenueMetrics(),),
  );

  // Health score for a specific store.
  router.get(
    '/admin/retention/health/:store_id',
    wrap(async (req,) => platform.retentionEngine.calculateHealthScore(req.params.store_id,),),
  );

  // Generate retention interventions for a store.
  router.get(
    '/admin/retention/interventions/:store_id',
    wrap(async (req,) => platform.retentionEngine.generateInterventions(req.params.store_id,),),
  );

  // Retention history (past snapshots).
  router.get(
    '/admin/retention/history',
    wrap(async (req,) => platform.retentionEngine.getHistory(Number(req.query.limit,) || 30,),),
  );

  // ── Revenue Intelligence (conversion, leads, ROI, smart reminders) ──

  // ROI calculation for a store.
  router.get(
    '/admin/revenue/roi/:store_id',
    wrap(async (req,) => platform.revenueIntelligence.calculateROI(req.params.store_id,),),
  );

  // Value realization report for a store (the "can't resist not renewing" doc).
  router.get(
    '/admin/revenue/value-report/:store_id',
    wrap(async (req,) => platform.revenueIntelligence.generateValueReport(req.params.store_id,),),
  );

  // Lead pipeline summary.
  router.get(
    '/admin/leads/pipeline',
    wrap(async () => platform.revenueIntelligence.getLeadPipeline(),),
  );

  // List leads with filtering.
  router.get(
    '/admin/leads',
    wrap(async (req,) => platform.revenueIntelligence.getLeads({
      status: req.query.status,
      minScore: req.query.min_score ? Number(req.query.min_score,) : undefined,
      source: req.query.source,
      limit: Number(req.query.limit,) || 100,
    },),),
  );

  // Update lead status.
  router.patch(
    '/admin/leads/:lead_id',
    wrap(async (req,) => {
      const { status, notes, } = req.body || {};
      return platform.revenueIntelligence.updateLeadStatus(req.params.lead_id, status, notes,);
    },),
  );

  // Smart reminders (renewal sequences).
  router.get(
    '/admin/revenue/reminders',
    wrap(async () => platform.revenueIntelligence.generateSmartReminders(),),
  );

  // Conversion intelligence dashboard.
  router.get(
    '/admin/revenue/conversion',
    wrap(async () => platform.revenueIntelligence.getConversionIntelligence(),),
  );

  // Manual lead capture.
  router.post(
    '/admin/leads',
    wrap(async (req,) => platform.revenueIntelligence.captureLead(req.body || {},),),
  );

  // ── Admin Intelligence: admin tools ──────────────────────────────────────

  // Admin Daily Brief
  router.get(
    '/admin/intel/brief',
    wrap(async () => {
      const stores = await platform.store.integrations.find({},);
      const leads = await platform.store.leads.find({},);
      const retentionSnapshots = await platform.store.retentionSnapshots.find({},);
      const deliveries = await platform.store.deliveries.find({},);
      const events = await platform.store.events.find({},);
      const campaignActions = await platform.store.campaignActions.find({},);
      return platform.adminIntelligence.generateAdminBrief({
        stores, leads, retentionSnapshots, deliveries, events, campaignActions,
      },);
    },),
  );

  // Revenue Forecast
  router.get(
    '/admin/intel/forecast',
    wrap(async () => {
      const stores = await platform.store.integrations.find({},);
      const leads = await platform.store.leads.find({},);
      const retentionSnapshots = await platform.store.retentionSnapshots.find({},);
      return platform.adminIntelligence.generateRevenueForecast({
        stores, leads, retentionSnapshots,
      },);
    },),
  );

  // Campaign Suggestions
  router.get(
    '/admin/intel/campaign-suggestions',
    wrap(async () => {
      const stores = await platform.store.integrations.find({},);
      const leads = await platform.store.leads.find({},);
      const retentionSnapshots = await platform.store.retentionSnapshots.find({},);
      return platform.adminIntelligence.suggestCampaigns({
        stores, leads, retentionSnapshots,
      },);
    },),
  );

  // Create Campaign
  router.post(
    '/admin/intel/campaigns',
    wrap(async (req,) => {
      const campaignActions = await platform.store.campaignActions.find({},);
      const result = platform.adminIntelligence.createCampaign({ campaignActions, }, req.body || {},);
      if (result.campaign) {
        await platform.store.campaignActions.insert(result.campaign,);
      }
      return result;
    },),
  );

  // Feature Adoption Analysis
  router.get(
    '/admin/intel/feature-adoption',
    wrap(async () => {
      const stores = await platform.store.integrations.find({},);
      const events = await platform.store.events.find({},);
      return platform.adminIntelligence.analyzeFeatureAdoption({ stores, events, },);
    },),
  );

  // Lead Capture (multi-source)
  router.post(
    '/admin/leads/capture',
    wrap(async (req,) => {
      const leads = await platform.store.leads.find({},);
      const result = platform.adminIntelligence.captureLead({ leads, input: req.body || {}, },);
      if (result.created && result.lead) {
        await platform.store.leads.insert(result.lead,);
      }
      return result;
    },),
  );

  // Behavioral Lead Scoring
  router.post(
    '/admin/leads/score',
    wrap(async () => {
      const leads = await platform.store.leads.find({},);
      const events = await platform.store.events.find({},);
      const auditResults = await platform.store.siteAudits.find({},);
      const scored = platform.adminIntelligence.scoreLeadsBehavioral({ leads, events, auditResults, },);
      // Update leads in store
      for (const s of scored) {
        await platform.store.leads.update(s.leadId, { score: s.newScore, grade: s.grade, behavioralSignals: s.signals, },);
      }
      return scored;
    },),
  );

  // Trial Expiry Detection
  router.get(
    '/admin/leads/trial-expiry',
    wrap(async () => {
      const stores = await platform.store.integrations.find({},);
      const events = await platform.store.events.find({},);
      return platform.adminIntelligence.detectTrialExpiry({ stores, events, },);
    },),
  );

  // ── Payment & Billing ───────────────────────────────────────────────

  // Get available plans
  router.get(
    '/payment/plans',
    wrap(async () => {
      const cfg = require('../config/config',);
      return {
        plans: cfg.payment.plans,
        gstRate: cfg.payment.gstRate,
        refundWindowDays: cfg.payment.refundWindowDays,
        currencies: ['usd', 'inr',],
      };
    },),
  );

  // Create Stripe checkout (global customers)
  router.post(
    '/payment/checkout/stripe',
    wrap(async (req,) => {
      const cfg = require('../config/config',);
      const { plan, billingCycle, customer, } = req.body || {};
      return platform.paymentEngine.createStripeCheckout({
        config: cfg,
        customer: customer || { email: req.body.email, name: req.body.name, country: req.body.country, },
        plan: plan || 'growth',
        billingCycle: billingCycle || 'monthly',
      },);
    },),
  );

  // Create Razorpay order (Indian customers)
  router.post(
    '/payment/checkout/razorpay',
    wrap(async (req,) => {
      const cfg = require('../config/config',);
      const { plan, billingCycle, customer, } = req.body || {};
      return platform.paymentEngine.createRazorpayOrder({
        config: cfg,
        customer: customer || { email: req.body.email, name: req.body.name, country: 'IN', phone: req.body.phone, },
        plan: plan || 'growth',
        billingCycle: billingCycle || 'monthly',
      },);
    },),
  );

  // Create subscription after payment
  router.post(
    '/payment/subscription',
    wrap(async (req,) => {
      const subs = await platform.store.subscriptions.find({},);
      const result = platform.paymentEngine.createSubscription({ subscriptions: subs, }, req.body || {},);
      if (result.subscription) {
        await platform.store.subscriptions.insert(result.subscription,);
      }
      return result;
    },),
  );

  // Get subscription by customer
  router.get(
    '/payment/subscription/:customerId',
    wrap(async (req,) => {
      const subs = await platform.store.subscriptions.find({ customerId: req.params.customerId, },);
      return subs;
    },),
  );

  // Cancel subscription
  router.post(
    '/payment/subscription/:id/cancel',
    wrap(async (req,) => {
      const subs = await platform.store.subscriptions.find({},);
      const result = platform.paymentEngine.cancelSubscription({ subscriptions: subs, }, req.params.id, req.body?.reason,);
      if (result.subscription) {
        await platform.store.subscriptions.update(req.params.id, { status: 'cancelled', cancelledAt: new Date().toISOString(), },);
      }
      return result;
    },),
  );

  // Pause subscription
  router.post(
    '/payment/subscription/:id/pause',
    wrap(async (req,) => {
      const subs = await platform.store.subscriptions.find({},);
      const result = platform.paymentEngine.pauseSubscription({ subscriptions: subs, }, req.params.id,);
      if (result.subscription) {
        await platform.store.subscriptions.update(req.params.id, { status: 'paused', pausedAt: new Date().toISOString(), },);
      }
      return result;
    },),
  );

  // Resume subscription
  router.post(
    '/payment/subscription/:id/resume',
    wrap(async (req,) => {
      const subs = await platform.store.subscriptions.find({},);
      const result = platform.paymentEngine.resumeSubscription({ subscriptions: subs, }, req.params.id,);
      if (result.subscription) {
        await platform.store.subscriptions.update(req.params.id, { status: 'active', },);
      }
      return result;
    },),
  );

  // Generate invoice
  router.post(
    '/payment/invoice',
    wrap(async (req,) => {
      const invs = await platform.store.invoices.find({},);
      const result = platform.paymentEngine.generateInvoice({ invoices: invs, }, req.body || {},);
      if (result.invoice) {
        await platform.store.invoices.insert(result.invoice,);
      }
      return result;
    },),
  );

  // Get invoices for customer
  router.get(
    '/payment/invoices/:customerId',
    wrap(async (req,) => {
      return platform.store.invoices.find({ customerId: req.params.customerId, },);
    },),
  );

  // Process refund
  router.post(
    '/payment/refund',
    wrap(async (req,) => {
      const subs = await platform.store.subscriptions.find({},);
      const invs = await platform.store.invoices.find({},);
      return platform.paymentEngine.processRefund({ subscriptions: subs, invoices: invs, }, req.body || {},);
    },),
  );

  // Stripe webhook
  router.post(
    '/payment/webhook/stripe',
    wrap(async (req,) => {
      const cfg = require('../config/config',);
      const signature = req.headers['stripe-signature'];
      const rawBody = JSON.stringify(req.body,);
      const verification = platform.paymentEngine.verifyStripeWebhook({
        payload: rawBody,
        signature,
        webhookSecret: cfg.payment.stripe.webhookSecret,
      },);
      if (!verification.valid) {
        return { error: 'Invalid webhook signature', reason: verification.reason, };
      }
      const subs = await platform.store.subscriptions.find({},);
      const invs = await platform.store.invoices.find({},);
      const pays = await platform.store.payments.find({},);
      const result = platform.paymentEngine.processWebhook({ subscriptions: subs, invoices: invs, payments: pays, }, {
        provider: 'stripe',
        event: req.body.type,
        data: req.body.data?.object,
      },);
      if (result.payment) {
        await platform.store.payments.insert(result.payment,);
      }
      return result;
    },),
  );

  // Razorpay webhook
  router.post(
    '/payment/webhook/razorpay',
    wrap(async (req,) => {
      const cfg = require('../config/config',);
      const signature = req.headers['x-razorpay-signature'];
      const rawBody = JSON.stringify(req.body,);
      const verification = platform.paymentEngine.verifyRazorpayWebhook({
        payload: rawBody,
        signature,
        webhookSecret: cfg.payment.razorpay.webhookSecret,
      },);
      if (!verification.valid) {
        return { error: 'Invalid webhook signature', reason: verification.reason, };
      }
      const subs = await platform.store.subscriptions.find({},);
      const invs = await platform.store.invoices.find({},);
      const pays = await platform.store.payments.find({},);
      const result = platform.paymentEngine.processWebhook({ subscriptions: subs, invoices: invs, payments: pays, }, {
        provider: 'razorpay',
        event: req.body.event,
        data: req.body.payload,
      },);
      if (result.payment) {
        await platform.store.payments.insert(result.payment,);
      }
      return result;
    },),
  );

  // Payment analytics (admin)
  router.get(
    '/admin/payment/analytics',
    wrap(async () => {
      const subs = await platform.store.subscriptions.find({},);
      const invs = await platform.store.invoices.find({},);
      const pays = await platform.store.payments.find({},);
      return platform.paymentEngine.getPaymentAnalytics({ subscriptions: subs, invoices: invs, payments: pays, },);
    },),
  );

  // Compliance report (admin)
  router.get(
    '/admin/payment/compliance',
    wrap(async () => {
      const subs = await platform.store.subscriptions.find({},);
      const invs = await platform.store.invoices.find({},);
      const pays = await platform.store.payments.find({},);
      return platform.paymentEngine.generateComplianceReport({ subscriptions: subs, invoices: invs, payments: pays, },);
    },),
  );

  // Upcoming auto-debits (admin — RBI compliance)
  router.get(
    '/admin/payment/auto-debits',
    wrap(async () => {
      const subs = await platform.store.subscriptions.find({},);
      return platform.paymentEngine.getUpcomingAutoDebits({ subscriptions: subs, },);
    },),
  );

}

module.exports = { register, };
