'use strict';

/**
 * Return intelligence and fraud shield.
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, } = ctx;

  // ── Return Intelligence & Fraud Shield ───────────────────────────
  router.post(
    '/returns/:store_id/process',
    wrap(async (req,) => {
      const result = await platform.returnService.processReturn(req.params.store_id, req.body,);
      return result;
    },),
  );

  router.get(
    '/returns/:store_id',
    wrap(async (req,) => {
      const { status, risk_level, customer_id, date_from, date_to, min_risk_score, page, } = req.query;
      const filters = {};
      if (status) filters.status = status;
      if (risk_level) filters.risk_level = risk_level;
      if (customer_id) filters.customer_id = customer_id;
      if (date_from) filters.date_from = date_from;
      if (date_to) filters.date_to = date_to;
      if (min_risk_score) filters.min_risk_score = Number(min_risk_score,);
      if (page) filters.page = Number(page,);
      return await platform.returnService.listReturns(req.params.store_id, filters,);
    },),
  );

  router.get(
    '/returns/:store_id/dashboard',
    wrap(async (req,) => {
      return await platform.returnService.getReturnDashboard(req.params.store_id,);
    },),
  );

  router.get(
    '/returns/:store_id/:return_id',
    wrap(async (req,) => {
      return await platform.returnService.getReturn(req.params.store_id, req.params.return_id,);
    },),
  );

  router.post(
    '/returns/:store_id/:return_id/approve',
    wrap(async (req,) => {
      return await platform.returnService.approveReturn(req.params.store_id, req.params.return_id, req.body.approved_by || 'admin',);
    },),
  );

  router.post(
    '/returns/:store_id/:return_id/deny',
    wrap(async (req,) => {
      return await platform.returnService.denyReturn(req.params.store_id, req.params.return_id, req.body.denied_by || 'admin', req.body.reason || 'Denied by admin',);
    },),
  );

  router.post(
    '/returns/:store_id/:return_id/flag',
    wrap(async (req,) => {
      return await platform.returnService.flagForReview(req.params.store_id, req.params.return_id, req.body.flagged_by || 'admin',);
    },),
  );

  router.get(
    '/returns/:store_id/analytics/reasons',
    wrap(async (req,) => {
      const days = Number(req.query.days,) || 30;
      return await platform.returnAnalytics.getReturnReasonAnalysis(req.params.store_id, days,);
    },),
  );

  router.get(
    '/returns/:store_id/analytics/top-skus',
    wrap(async (req,) => {
      const limit = Number(req.query.limit,) || 10;
      return await platform.returnAnalytics.getTopReturnedSKUs(req.params.store_id, limit,);
    },),
  );

  router.get(
    '/returns/:store_id/analytics/cost',
    wrap(async (req,) => {
      const days = Number(req.query.days,) || 30;
      return await platform.returnAnalytics.getReturnCostAnalysis(req.params.store_id, days,);
    },),
  );

  router.get(
    '/returns/:store_id/analytics/trend',
    wrap(async (req,) => {
      const days = Number(req.query.days,) || 90;
      return await platform.returnAnalytics.getReturnTrend(req.params.store_id, days,);
    },),
  );

  router.get(
    '/returns/:store_id/analytics/policy',
    wrap(async (req,) => {
      return await platform.returnAnalytics.getPolicyPerformance(req.params.store_id,);
    },),
  );

  router.get(
    '/returns/:store_id/analytics/impact',
    wrap(async (req,) => {
      const days = Number(req.query.days,) || 30;
      return await platform.returnAnalytics.getReturnImpactReport(req.params.store_id, days,);
    },),
  );

  router.get(
    '/returns/:store_id/analytics/recommendations',
    wrap(async (req,) => {
      return await platform.returnAnalytics.generateRecommendations(req.params.store_id,);
    },),
  );

  router.get(
    '/returns/:store_id/fraud/stats',
    wrap(async (req,) => {
      return await platform.returnFraudEngine.getFraudStats(req.params.store_id,);
    },),
  );

  router.get(
    '/returns/:store_id/fraud/bulk-score',
    wrap(async (req,) => {
      return await platform.returnFraudEngine.bulkScoreReturns(req.params.store_id,);
    },),
  );

  router.post(
    '/returns/:store_id/batch',
    wrap(async (req,) => {
      const { returns, } = req.body;
      return await platform.returnService.processBatchReturns(req.params.store_id, returns || [],);
    },),
  );

  router.get(
    '/admin/return-fraud/trends',
    wrap(async (_req,) => {
      const stores = await platform.store.returns.find({},);
      const byStore = {};
      for (const r of stores) {
        if (!byStore[r.store_id]) byStore[r.store_id] = { total: 0, flagged: 0, value: 0, };
        byStore[r.store_id].total++;
        if (r.risk_score > 50) byStore[r.store_id].flagged++;
        byStore[r.store_id].value += r.return_value || 0;
      }
      return { store_count: Object.keys(byStore,).length, by_store: byStore, total_returns: stores.length, };
    },),
  );

  router.get(
    '/admin/return-fraud/model-performance',
    wrap(async (_req,) => {
      const allReturns = await platform.store.returns.find({},);
      const total = allReturns.length;
      const flagged = allReturns.filter((r,) => r.risk_score > 50,).length;
      const approved = allReturns.filter((r,) => r.status === 'approved',).length;
      const denied = allReturns.filter((r,) => r.status === 'denied',).length;
      const avgScore = total > 0 ? allReturns.reduce((sum, r,) => sum + (r.risk_score || 0), 0,) / total : 0;
      return {
        total_returns: total,
        flagged_returns: flagged,
        auto_approved: approved,
        auto_denied: denied,
        avg_risk_score: Math.round(avgScore * 10,) / 10,
        accuracy_estimate: total > 0 ? Math.round((flagged / total) * 100,) : 0,
      };
    },),
  );

  // Admin return actions by return_id alone (no store_id needed)
  router.post(
    '/returns/:return_id/approve',
    wrap(async (req,) => {
      const ret = await platform.store.returns.findById(req.params.return_id,);
      if (!ret) throw new Error('Return not found.',);
      await platform.store.returns.update(req.params.return_id, { status: 'approved', approved_at: new Date().toISOString(), },);
      return { ok: true, return_id: req.params.return_id, status: 'approved', };
    },),
  );

  router.post(
    '/returns/:return_id/deny',
    wrap(async (req,) => {
      const ret = await platform.store.returns.findById(req.params.return_id,);
      if (!ret) throw new Error('Return not found.',);
      await platform.store.returns.update(req.params.return_id, { status: 'denied', denied_at: new Date().toISOString(), },);
      return { ok: true, return_id: req.params.return_id, status: 'denied', };
    },),
  );

}

module.exports = { register, };
