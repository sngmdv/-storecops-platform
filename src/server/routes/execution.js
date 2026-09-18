'use strict';

/**
 * Layer 4 — execution, deliveries, retargeting, purchase orders.
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, defaultStore, paginate, } = ctx;

  // ── Layer 4: Execution ──────────────────────────────────────────────

  router.post(
    '/execute/:store_id',
    wrap(async (req,) => platform.executionService.processStore(req.params.store_id,),),
  );

  router.post(
    '/bot/chat',
    wrap(async (req,) =>
      platform.websiteBot.reply({
        store_id: defaultStore(req,),
        customer_id: req.body?.customer_id || null,
        message: req.body?.message || '',
      },),
    ),
  );

  // ── Delivery history & channel status ─────────────────────────────

  router.get(
    '/deliveries/:store_id',
    wrap(async (req,) => {
      const store_id = req.params.store_id;
      const all = await platform.store.deliveries.find({ store_id, },);
      const sorted = all.sort((a, b,) => (b.createdAt || '').localeCompare(a.createdAt || '',),);

      // Aggregate stats
      const byChannel = {};
      const byStatus = {};
      const byAction = {};
      for (const d of all) {
        const ch = d.channel || 'unknown';
        byChannel[ch] = (byChannel[ch] || 0) + 1;
        const st = d.status || 'unknown';
        byStatus[st] = (byStatus[st] || 0) + 1;
        const act = d.action_type || 'unknown';
        byAction[act] = (byAction[act] || 0) + 1;
      }

      const paged = paginate(sorted, req, { maxDefault: 50, },);
      return { store_id, ...paged, stats: { total: all.length, by_channel: byChannel, by_status: byStatus, by_action: byAction, }, };
    },),
  );

  router.get(
    '/channels/:store_id/status',
    wrap(async (_req,) => {
      const cfg = platform.config;
      const whatsappProvider = cfg.providers?.whatsapp || 'console';
      const emailProvider = cfg.providers?.email || 'console';
      const whatsappReady = whatsappProvider === 'meta'
        && !!cfg.whatsapp?.accessToken
        && !!cfg.whatsapp?.phoneNumberId;
      const emailReady = emailProvider === 'resend'
        && !!cfg.email?.resendApiKey;

      return {
        whatsapp: {
          provider: whatsappProvider,
          configured: whatsappReady,
          webhook_url: '/webhooks/whatsapp',
          templates: {
            cart_recovery: process.env.WHATSAPP_TEMPLATE_CART_RECOVERY || 'cart_recovery',
            checkout_reminder: process.env.WHATSAPP_TEMPLATE_CHECKOUT_REMINDER || 'checkout_reminder',
            winback_discount: process.env.WHATSAPP_TEMPLATE_WINBACK || 'winback_discount',
            browse_reminder: process.env.WHATSAPP_TEMPLATE_BROWSE || 'browse_reminder',
            vip_thankyou: process.env.WHATSAPP_TEMPLATE_VIP || 'vip_thankyou',
          },
        },
        email: {
          provider: emailProvider,
          configured: emailReady,
          from_address: cfg.email?.from || 'noreply@storecops.app',
        },
      };
    },),
  );

  // ── Retargeting audiences & purchase orders ──────────────────────────

  router.post(
    '/retargeting/:store_id/build',
    wrap(async (req,) =>
      platform.retargeting.buildAudiences(req.params.store_id, {
        lookbackDays: Number(req.body?.lookback_days,) || 30,
      },),
    ),
  );

  router.get(
    '/retargeting/:store_id/history',
    wrap(async (req,) => platform.retargeting.history(req.params.store_id,),),
  );

  router.post(
    '/purchase-orders/:store_id/generate',
    wrap(async (req,) =>
      platform.purchaseOrders.generate({
        store_id: req.params.store_id,
        supplier: req.body?.supplier,
        items: req.body?.items || null,
      },),
    ),
  );

  router.get(
    '/purchase-orders/:store_id',
    wrap(async (req,) => platform.purchaseOrders.list(req.params.store_id,),),
  );

}

module.exports = { register, };
