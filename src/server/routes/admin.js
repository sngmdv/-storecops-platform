'use strict';

/**
 * Security & administration, growth loop, consent compliance.
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

const { safeUser, } = require('../auth',);
const { exportCustomerData, deleteCustomerData, } = require('../security',);
const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, } = ctx;

  // ── Security & Administration ───────────────────────────────────────

  router.post(
    '/admin/users',
    platform.rbac.middleware('administer',),
    wrap(async (req,) => {
      const user = await platform.rbac.createUser(req.body || {},);
      await platform.auditLog.record(req.get('X-User',) || 'bootstrap', 'user_provisioned', {
        email: user.email,
        role: user.role,
      },);
      return user;
    },),
  );

  // Operator-only. Returns a credential-free projection — the raw user
  // documents carry api_key, which would allow impersonating any tenant.
  router.get(
    '/admin/users',
    platform.rbac.middleware('administer',),
    wrap(async () => (await platform.rbac.users()).map(safeUser,),),
  );

  router.get(
    '/admin/audit',
    platform.rbac.middleware('administer',),
    wrap(async (req,) => platform.auditLog.entries(req.query.store_id || null,),),
  );

  router.get(
    '/admin/gdpr/:store_id/:customer_id',
    platform.rbac.middleware('administer',),
    wrap(async (req,) => exportCustomerData(platform, req.params.store_id, req.params.customer_id,),),
  );

  router.delete(
    '/admin/gdpr/:store_id/:customer_id',
    platform.rbac.middleware('administer',),
    wrap(async (req,) => {
      const result = await deleteCustomerData(platform, req.params.store_id, req.params.customer_id,);
      await platform.auditLog.record(req.get('X-User',) || 'admin', 'gdpr_delete', {
        store_id: req.params.store_id,
        customer_id: req.params.customer_id,
      },);
      return result;
    },),
  );

  // ── Layer 6: Growth Loop ────────────────────────────────────────────

  router.post(
    '/growth-cycle/:store_id',
    wrap(async (req,) => platform.runGrowthCycle(req.params.store_id,),),
  );

  // ── Consent & Messaging Compliance (Tasks 30-40) ────────────────────

  router.get(
    '/consent/:store_id/:customer_identity',
    wrap(async (req,) => {
      const record = await platform.consentService.getConsent(
        req.params.store_id,
        req.params.customer_identity,
      );
      return record || { consent: null, found: false, };
    },),
  );

  router.post(
    '/consent/:store_id',
    wrap(async (req,) => {
      const { customer_identity, categories, source, } = req.body || {};
      if (!customer_identity) throw new Error('customer_identity is required.',);
      return platform.consentService.setConsent(
        req.params.store_id,
        customer_identity,
        categories || {},
        { source, },
      );
    },),
  );

  router.post(
    '/consent/:store_id/check',
    wrap(async (req,) => {
      const { customer_identity, message_classification, channel, } = req.body || {};
      if (!customer_identity) throw new Error('customer_identity is required.',);
      return platform.consentService.canSend(
        req.params.store_id,
        customer_identity,
        message_classification || 'marketing',
        channel || 'email',
      );
    },),
  );

  router.post(
    '/consent/:store_id/suppress',
    wrap(async (req,) => {
      const { customer_identity, channel, reason, } = req.body || {};
      if (!customer_identity || !channel) throw new Error('customer_identity and channel are required.',);
      return platform.consentService.suppressChannel(
        req.params.store_id,
        customer_identity,
        channel,
        reason,
      );
    },),
  );

  router.post(
    '/consent/:store_id/unsuppress',
    wrap(async (req,) => {
      const { customer_identity, channel, } = req.body || {};
      if (!customer_identity || !channel) throw new Error('customer_identity and channel are required.',);
      return platform.consentService.unsuppressChannel(
        req.params.store_id,
        customer_identity,
        channel,
      );
    },),
  );

  router.get(
    '/unsubscribe',
    // This was the one route in this file not wrapped. It is public and
    // unauthenticated — the token in the query is the only credential — and it
    // awaits the consent service, so an unguarded rejection would leave the
    // request unanswered and take the process down.
    wrap(async (req, res,) => {
      const token = req.query.token;
      const parsed = platform.consentService.parseUnsubscribeToken(token,);
      if (!parsed) return res.status(400,).json({ error: 'Invalid or expired unsubscribe link.', },);

      await platform.consentService.suppressEmailGlobally(parsed.email, {
        reason: 'UNSUBSCRIBE',
        source: 'SELF_SERVICE',
        shopInstallationId: parsed.shopInstallationId || null,
      },);

      return res.json({ success: true, message: 'You have been unsubscribed. You will no longer receive marketing emails.', },);
    },),
  );

}

module.exports = { register, };
