'use strict';

/**
 * Notifications, 2FA, activity log, data export, onboarding, engagement.
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

// Note: the GDPR data-request route below calls platform.dataExport
// (the DI service), not the ../security helper of the same name.

const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, } = ctx;

  // ── Notification Center ─────────────────────────────────────────────
  router.get(
    '/notifications',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      const { severity, category, unreadOnly, } = req.query;
      return platform.notificationService.list(store_id, {
        severity,
        category,
        unreadOnly: unreadOnly === 'true',
        limit: Number(req.query.limit,) || 50,
      },);
    },),
  );

  router.get(
    '/notifications/summary',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.notificationService.summary(store_id,);
    },),
  );

  router.get(
    '/notifications/unread-count',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      const count = await platform.notificationService.unreadCount(store_id,);
      return { count, };
    },),
  );

  router.post(
    '/notifications/read',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.body.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.notificationService.markRead(store_id, req.body.notification_id,);
    },),
  );

  // ── Two-Factor Authentication ───────────────────────────────────────
  router.post(
    '/auth/2fa/enable',
    wrap(async (req,) => {
      const user_id = req.authUser?._id || req.authUser?.email;
      if (!user_id) throw new Error('Authentication required',);
      return platform.twoFactorAuth.enable(user_id, { email: req.authUser?.email, },);
    },),
  );

  router.post(
    '/auth/2fa/verify',
    wrap(async (req,) => {
      const user_id = req.authUser?._id || req.authUser?.email || req.body.user_id;
      if (!user_id) throw new Error('Authentication required',);
      return platform.twoFactorAuth.verify(user_id, req.body.code,);
    },),
  );

  router.post(
    '/auth/2fa/disable',
    wrap(async (req,) => {
      const user_id = req.authUser?._id || req.authUser?.email;
      if (!user_id) throw new Error('Authentication required',);
      return platform.twoFactorAuth.disable(user_id, req.body.code,);
    },),
  );

  router.get(
    '/auth/2fa/status',
    wrap(async (req,) => {
      const user_id = req.authUser?._id || req.authUser?.email || req.query.user_id;
      if (!user_id) throw new Error('Authentication required',);
      return platform.twoFactorAuth.status(user_id,);
    },),
  );

  // ── Activity Log ────────────────────────────────────────────────────
  router.get(
    '/activity',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.activityLog.query(store_id, {
        actor: req.query.actor,
        action: req.query.action,
        since: req.query.since,
        until: req.query.until,
        limit: Number(req.query.limit,) || 100,
      },);
    },),
  );

  router.get(
    '/activity/recent',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.activityLog.recent(store_id, Number(req.query.limit,) || 10,);
    },),
  );

  router.get(
    '/activity/summary',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.activityLog.summary(store_id, { since: req.query.since, days: Number(req.query.days,) || 30, },);
    },),
  );

  router.get(
    '/activity/export',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.activityLog.export(store_id, { since: req.query.since, until: req.query.until, },);
    },),
  );

  // ── Data Export (GDPR) ──────────────────────────────────────────────
  router.get(
    '/export/store',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.dataExport.exportStoreData(store_id, {
        anonymize: req.query.anonymize === 'true',
        collections: req.query.collections ? req.query.collections.split(',',) : null,
        since: req.query.since,
      },);
    },),
  );

  router.get(
    '/export/store/preview',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.dataExport.previewStoreData(store_id,);
    },),
  );

  router.get(
    '/export/customer/:customer_id',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.dataExport.exportCustomerData(store_id, req.params.customer_id,);
    },),
  );

  router.get(
    '/export/store/file',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.dataExport.generateExportFile(store_id, {
        anonymize: req.query.anonymize === 'true',
      },);
    },),
  );

  // ── Onboarding Wizard ───────────────────────────────────────────────
  router.get(
    '/onboarding',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.onboarding.getState(store_id,);
    },),
  );

  router.get(
    '/onboarding/next',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.onboarding.getNextAction(store_id,);
    },),
  );

  router.post(
    '/onboarding/complete-step',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.body.store_id;
      if (!store_id) throw new Error('store_id is required',);
      if (!req.body.step_id) throw new Error('step_id is required',);
      return platform.onboarding.completeStep(store_id, req.body.step_id, req.body.data,);
    },),
  );

  router.post(
    '/onboarding/skip-step',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.body.store_id;
      if (!store_id) throw new Error('store_id is required',);
      if (!req.body.step_id) throw new Error('step_id is required',);
      return platform.onboarding.skipStep(store_id, req.body.step_id,);
    },),
  );

  router.post(
    '/onboarding/auto-check',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.body.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.onboarding.autoCheck(store_id,);
    },),
  );

  // Brand keywords setup for onboarding
  router.post(
    '/brand-keywords',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.body.store_id;
      if (!store_id) throw new Error('store_id is required',);
      const { keywords, } = req.body;
      if (!Array.isArray(keywords,) || keywords.length === 0) {
        throw new Error('keywords must be a non-empty array',);
      }

      const existing = await platform.store.customers?.findOne({ store_id, },);
      if (existing) {
        await platform.store.customers.update(existing._id, {
          brand_keywords: keywords.map((k,) => k.toLowerCase().trim(),),
          brand_keywords_updated_at: new Date().toISOString(),
        },);
      } else {
        await platform.store.customers?.insert({
          store_id,
          identity: `config:${store_id}`,
          brand_keywords: keywords.map((k,) => k.toLowerCase().trim(),),
          brand_keywords_updated_at: new Date().toISOString(),
        },);
      }

      await platform.onboarding.completeStep(store_id, 'brand_keywords', { keywords, },);
      return { success: true, keywords, };
    },),
  );

  router.get(
    '/brand-keywords',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      const existing = await platform.store.customers?.findOne({ store_id, },);
      return { keywords: existing?.brand_keywords || [], };
    },),
  );

  router.get(
    '/admin/onboarding/analytics',
    wrap(async () => {
      return platform.onboarding.getAnalytics();
    },),
  );

  // ── Aha Moments ──────────────────────────────────────────────────────
  router.get(
    '/aha-moments',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.ahaMomentService.getProgress(store_id,);
    },),
  );

  router.get(
    '/aha-moments/achieved',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.ahaMomentService.getAchieved(store_id,);
    },),
  );

  router.post(
    '/aha-moments/scan',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.body.store_id;
      if (!store_id) throw new Error('store_id is required',);
      const newAchievements = await platform.ahaMomentService.scanForMoments(store_id,);
      return { new_achievements: newAchievements, };
    },),
  );

  // ── Support Tickets ──────────────────────────────────────────────────
  router.post(
    '/support/tickets',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.body.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.supportTicketService.createTicket({
        store_id,
        customer_id: req.authUser?.id || req.body.customer_id,
        subject: req.body.subject,
        description: req.body.description,
        category: req.body.category,
        priority: req.body.priority,
        metadata: req.body.metadata,
      },);
    },),
  );

  router.get(
    '/support/tickets',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.supportTicketService.getTickets(store_id, {
        status: req.query.status,
        priority: req.query.priority,
        category: req.query.category,
        assignee: req.query.assignee,
      },);
    },),
  );

  router.get(
    '/support/tickets/stats',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.supportTicketService.getStats(store_id,);
    },),
  );

  router.get(
    '/support/tickets/search',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      if (!req.query.q) throw new Error('search query (q) is required',);
      return platform.supportTicketService.searchTickets(store_id, req.query.q,);
    },),
  );

  router.get(
    '/support/tickets/:ticket_id',
    wrap(async (req,) => {
      return platform.supportTicketService.getTicket(req.params.ticket_id,);
    },),
  );

  router.patch(
    '/support/tickets/:ticket_id/status',
    wrap(async (req,) => {
      return platform.supportTicketService.updateStatus(
        req.params.ticket_id,
        req.body.status,
        req.body.assignee,
      );
    },),
  );

  router.post(
    '/support/tickets/:ticket_id/respond',
    wrap(async (req,) => {
      return platform.supportTicketService.addResponse(req.params.ticket_id, {
        author: req.authUser?.id || req.body.author,
        message: req.body.message,
        is_internal: req.body.is_internal,
      },);
    },),
  );

  router.post(
    '/support/tickets/:ticket_id/tags',
    wrap(async (req,) => {
      return platform.supportTicketService.addTags(req.params.ticket_id, req.body.tags,);
    },),
  );

  // ── Weekly Scheduler ─────────────────────────────────────────────────
  router.get(
    '/scheduler/weekly/next',
    wrap(async () => {
      return { next_send_at: platform.weeklyScheduler.getNextSendTime(), };
    },),
  );

  router.get(
    '/scheduler/weekly/history',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.weeklyScheduler.getSendHistory(store_id,);
    },),
  );

  router.post(
    '/scheduler/weekly/send-now',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.body.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.weeklyScheduler.sendNow(store_id,);
    },),
  );

  // ── CAC Tracking ─────────────────────────────────────────────────────
  router.post(
    '/cac/spend',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.body.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.cacTracker.recordSpend({
        store_id,
        channel: req.body.channel,
        amount: req.body.amount,
        description: req.body.description,
        date: req.body.date,
        metadata: req.body.metadata,
      },);
    },),
  );

  router.get(
    '/cac/spend',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.cacTracker.getSpend(store_id, {
        from: req.query.from,
        to: req.query.to,
        channel: req.query.channel,
      },);
    },),
  );

  router.get(
    '/cac/summary',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.cacTracker.getSpendSummary(store_id, parseInt(req.query.period,) || 30,);
    },),
  );

  router.get(
    '/cac/calculate',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.cacTracker.calculateOverallCac(store_id, parseInt(req.query.period,) || 30,);
    },),
  );

  router.get(
    '/cac/channel/:channel',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.cacTracker.calculateChannelCac(store_id, req.params.channel, parseInt(req.query.period,) || 30,);
    },),
  );

  router.get(
    '/cac/ltv-ratio',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.cacTracker.calculateLtvCacRatio(store_id, parseInt(req.query.period,) || 30,);
    },),
  );

  // ── Feature Adoption ─────────────────────────────────────────────────
  router.post(
    '/features/activate',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.body.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.featureAdoption.recordActivation(store_id, req.body.feature_id, req.body.metadata,);
    },),
  );

  router.get(
    '/features/usage',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);
      return platform.featureAdoption.getStoreUsage(store_id,);
    },),
  );

  router.get(
    '/admin/features/heatmap',
    wrap(async () => {
      return platform.featureAdoption.getHeatmapData();
    },),
  );

  router.get(
    '/admin/features/summary',
    wrap(async () => {
      return platform.featureAdoption.getAdoptionSummary();
    },),
  );

  // ── Real-Time Activity Feed ──────────────────────────────────────────
  router.get(
    '/admin/activity/feed',
    wrap(async (req,) => {
      return platform.activityFeed.getRecent(req.query.store_id, parseInt(req.query.limit,) || 50,);
    },),
  );

  router.get(
    '/admin/activity/stats',
    wrap(async (req,) => {
      return platform.activityFeed.getStats(req.query.store_id, parseInt(req.query.period,) || 86400000,);
    },),
  );

  router.get(
    '/admin/activity/stream',
    (req, res,) => {
      platform.activityFeed.createSSEHandler(req.query.store_id,)(req, res,);
    },
  );

  // ── Webhook Retry Queue ─────────────────────────────────────────────
  router.post(
    '/webhooks/outbound',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.body.store_id;
      return platform.webhookQueue.enqueue({
        store_id,
        url: req.body.url,
        payload: req.body.payload,
        headers: req.body.headers,
        priority: req.body.priority,
      },);
    },),
  );

  router.get(
    '/webhooks/queue/status',
    wrap(async () => {
      return platform.webhookQueue.status();
    },),
  );

  router.post(
    '/webhooks/queue/process',
    wrap(async () => {
      return platform.webhookQueue.processNow();
    },),
  );

  router.post(
    '/webhooks/queue/retry/:id',
    wrap(async (req,) => {
      return platform.webhookQueue.retryDeadLetter(req.params.id,);
    },),
  );

  // ── Tiered Rate Limiter ─────────────────────────────────────────────
  router.get(
    '/rate-limit/usage',
    wrap(async (req,) => {
      return platform.tieredRateLimiter.getUsage(req,);
    },),
  );

  router.get(
    '/rate-limit/plans',
    wrap(async () => {
      return platform.tieredRateLimiter.PLAN_LIMITS;
    },),
  );

}

module.exports = { register, };
