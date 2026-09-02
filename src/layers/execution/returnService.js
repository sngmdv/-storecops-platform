'use strict';

const crypto = require('crypto',);

function createReturnService({ store, returnFraudEngine, returnAnalytics, notificationService, },) {

  function now() { return new Date().toISOString(); }

  async function processReturn(store_id, returnData,) {
    const returnRecord = {
      store_id,
      customer_id: returnData.customer_id,
      order_id: returnData.order_id,
      items: returnData.items || [],
      reason: returnData.reason || 'Not specified',
      return_value: returnData.return_value || 0,
      shipping_address: returnData.shipping_address,
      return_address: returnData.return_address,
      status: 'pending',
      risk_score: null,
      risk_level: null,
      recommended_action: null,
      processed_by: null,
      denial_reason: null,
      created_at: now(),
      updated_at: now(),
    };

    const inserted = await store.returns.insert(returnRecord,);

    const assessment = await returnFraudEngine.analyzeReturn(inserted,);

    let status;
    if (assessment.risk_score < 20) {
      status = 'approved';
    } else if (assessment.risk_score > 80) {
      status = 'denied';
    } else {
      status = 'under_review';
    }

    await store.returns.update(inserted._id, {
      status,
      risk_score: assessment.risk_score,
      risk_level: assessment.risk_level,
      recommended_action: assessment.recommended_action,
      denial_reason: status === 'denied' ? 'high fraud risk' : null,
      updated_at: now(),
    },);

    await store.returnAuditLog.insert({
      store_id,
      return_id: inserted._id,
      decision: status,
      reason: status === 'denied' ? 'high fraud risk' : `auto score: ${assessment.risk_score}`,
      auto_generated: true,
      decided_by: 'system',
      created_at: now(),
    },);

    return {
      ...inserted,
      status,
      risk_score: assessment.risk_score,
      risk_level: assessment.risk_level,
      recommended_action: assessment.recommended_action,
      factors: assessment.factors,
    };
  }

  async function approveReturn(store_id, return_id, approved_by,) {
    const rec = await store.returns.findOne((r,) => r._id === return_id && r.store_id === store_id,);
    if (!rec) throw new Error('Return not found',);
    await store.returns.update(return_id, { status: 'approved', processed_by: approved_by, updated_at: now(), },);
    await store.returnAuditLog.insert({ store_id, return_id, decision: 'approved', reason: 'Manual approval', auto_generated: false, decided_by: approved_by, created_at: now(), },);
    if (notificationService?.send) {
      await notificationService.send(store_id, { type: 'return_approved', return_id, customer_id: rec.customer_id, },);
    }
    return await store.returns.findById(return_id,);
  }

  async function denyReturn(store_id, return_id, denied_by, reason,) {
    const rec = await store.returns.findOne((r,) => r._id === return_id && r.store_id === store_id,);
    if (!rec) throw new Error('Return not found',);
    await store.returns.update(return_id, { status: 'denied', processed_by: denied_by, denial_reason: reason, updated_at: now(), },);
    await store.returnAuditLog.insert({ store_id, return_id, decision: 'denied', reason, auto_generated: false, decided_by: denied_by, created_at: now(), },);
    if (notificationService?.send) {
      await notificationService.send(store_id, { type: 'return_denied', return_id, customer_id: rec.customer_id, reason, },);
    }
    return await store.returns.findById(return_id,);
  }

  async function flagForReview(store_id, return_id, flagged_by,) {
    const rec = await store.returns.findOne((r,) => r._id === return_id && r.store_id === store_id,);
    if (!rec) throw new Error('Return not found',);
    await store.returns.update(return_id, { status: 'flagged', processed_by: flagged_by, updated_at: now(), },);
    await store.returnAuditLog.insert({ store_id, return_id, decision: 'flagged', reason: 'Flagged for review', auto_generated: false, decided_by: flagged_by, created_at: now(), },);
    return await store.returns.findById(return_id,);
  }

  async function getReturn(store_id, return_id,) {
    const rec = await store.returns.findOne((r,) => r._id === return_id && r.store_id === store_id,);
    if (!rec) return null;
    const auditLog = await store.returnAuditLog.find((a,) => a.return_id === return_id,);
    return { ...rec, audit_log: auditLog, };
  }

  async function listReturns(store_id, filters = {},) {
    const page = filters.page || 1;
    const perPage = 50;
    let results = await store.returns.find((r,) => r.store_id === store_id,);

    if (filters.status) results = results.filter((r,) => r.status === filters.status,);
    if (filters.risk_level) results = results.filter((r,) => r.risk_level === filters.risk_level,);
    if (filters.customer_id) results = results.filter((r,) => r.customer_id === filters.customer_id,);
    if (filters.min_risk_score) results = results.filter((r,) => (r.risk_score || 0) >= Number(filters.min_risk_score),);
    if (filters.date_from) results = results.filter((r,) => r.created_at >= filters.date_from,);
    if (filters.date_to) results = results.filter((r,) => r.created_at <= filters.date_to,);

    results.sort((a, b,) => new Date(b.created_at,).getTime() - new Date(a.created_at,).getTime(),);
    const total = results.length;
    const paged = results.slice((page - 1) * perPage, page * perPage,);

    return { returns: paged, total, page, per_page: perPage, };
  }

  async function getReturnDashboard(store_id,) {
    const fraudStats = await returnFraudEngine.getFraudStats(store_id,);
    const costAnalysis = await returnAnalytics.getReturnCostAnalysis(store_id, 30,);
    const allReturns = await store.returns.find((r,) => r.store_id === store_id,);
    allReturns.sort((a, b,) => new Date(b.created_at,).getTime() - new Date(a.created_at,).getTime(),);
    const pendingCount = allReturns.filter((r,) => r.status === 'pending' || r.status === 'under_review',).length;

    return {
      fraud_stats: fraudStats,
      cost_analysis: costAnalysis,
      recent_returns: allReturns.slice(0, 50,),
      pending_reviews_count: pendingCount,
    };
  }

  async function processBatchReturns(store_id, returns,) {
    let autoApproved = 0;
    let autoDenied = 0;
    let needsReview = 0;

    for (const r of returns) {
      const result = await processReturn(store_id, r,);
      if (result.status === 'approved') autoApproved++;
      else if (result.status === 'denied') autoDenied++;
      else needsReview++;
    }

    return { processed: returns.length, auto_approved: autoApproved, auto_denied: autoDenied, needs_review: needsReview, };
  }

  return {
    processReturn,
    approveReturn,
    denyReturn,
    flagForReview,
    getReturn,
    listReturns,
    getReturnDashboard,
    processBatchReturns,
  };
}

module.exports = { createReturnService, };
