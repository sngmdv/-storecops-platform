'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(value, min, max,) {
  return Math.max(min, Math.min(max, value,),);
}

function createReturnFraudEngine({ store, config, },) {

  function scoreReturn(returnRecord, customerHistory,) {
    const factors = [];
    let risk = 0;

    if (customerHistory.total_returns > 3) {
      const contribution = 25;
      risk += contribution;
      factors.push({
        factor: 'return_frequency',
        detail: `${customerHistory.total_returns} returns in last 90 days`,
        contribution,
      },);
    }

    if (customerHistory.return_rate > 0.4) {
      const contribution = 30;
      risk += contribution;
      factors.push({
        factor: 'serial_returner',
        detail: `${(customerHistory.return_rate * 100).toFixed(1,)}% return rate`,
        contribution,
      },);
    }

    if (returnRecord.return_value > 200) {
      const contribution = 15;
      risk += contribution;
      factors.push({
        factor: 'high_value_return',
        detail: `Return value $${returnRecord.return_value.toFixed(2,)}`,
        contribution,
      },);
    }

    if (returnRecord.created_at && returnRecord.updated_at) {
      const daysToReturn = (new Date(returnRecord.updated_at,).getTime() - new Date(returnRecord.created_at,).getTime()) / DAY_MS;
      if (daysToReturn < 3) {
        const contribution = 20;
        risk += contribution;
        factors.push({
          factor: 'fast_return',
          detail: `Returned within ${daysToReturn.toFixed(1,)} days`,
          contribution,
        },);
      }
    }

    if (customerHistory.account_age_days !== undefined && customerHistory.account_age_days < 30) {
      const contribution = 10;
      risk += contribution;
      factors.push({
        factor: 'new_account',
        detail: `Account ${customerHistory.account_age_days} days old`,
        contribution,
      },);
    }

    if (returnRecord.shipping_address && returnRecord.return_address) {
      const normalizedShipping = JSON.stringify(returnRecord.shipping_address,).toLowerCase();
      const normalizedReturn = JSON.stringify(returnRecord.return_address,).toLowerCase();
      if (normalizedShipping !== normalizedReturn) {
        const contribution = 20;
        risk += contribution;
        factors.push({
          factor: 'address_mismatch',
          detail: 'Return address differs from shipping address',
          contribution,
        },);
      }
    }

    if (returnRecord.return_value > 500) {
      const contribution = 10;
      risk += contribution;
      factors.push({
        factor: 'item_value_risk',
        detail: `High-value item ($${returnRecord.return_value.toFixed(2,)})`,
        contribution,
      },);
    }

    if (['Not as described', 'Defective',].includes(returnRecord.reason,) && returnRecord.return_value > 200) {
      const contribution = 5;
      risk += contribution;
      factors.push({
        factor: 'reason_pattern',
        detail: `"${returnRecord.reason}" on high-value item`,
        contribution,
      },);
    }

    const finalScore = clamp(Math.round(risk,), 0, 100,);

    return {
      risk_score: finalScore,
      factors,
    };
  }

  function classifyRisk(score,) {
    if (score <= 20) {
      return { level: 'low', action: 'auto_approve', };
    }
    if (score <= 50) {
      return { level: 'medium', action: 'review', };
    }
    if (score <= 75) {
      return { level: 'high', action: 'flag', };
    }
    return { level: 'critical', action: 'auto_deny', };
  }

  async function getCustomerReturnHistory(store_id, customer_id,) {
    const returns = await store.returns.find(
      (r,) => r.store_id === store_id && r.customer_id === customer_id,
    );

    const total_returns = returns.length;
    const total_return_value = returns.reduce((sum, r,) => sum + (r.return_value || 0), 0,);
    const avg_return_value = total_returns > 0 ? total_return_value / total_returns : 0;

    const recentReturns = returns.filter((r,) => {
      const age = (Date.now() - new Date(r.created_at,).getTime()) / DAY_MS;
      return age <= 90;
    },);

    const serial_returner = total_returns > 0 && total_returns / (total_returns + 10) > 0.4;

    const sorted = [...returns,].sort(
      (a, b,) => new Date(b.created_at,).getTime() - new Date(a.created_at,).getTime(),
    );
    const last_return_date = sorted.length > 0 ? sorted[0].created_at : null;

    return {
      total_returns: recentReturns.length,
      total_orders: recentReturns.length + 10,
      return_rate: total_returns > 0 ? total_returns / (total_returns + 10) : 0,
      avg_return_value,
      serial_returner,
      last_return_date,
      account_age_days: undefined,
    };
  }

  async function analyzeReturn(returnRecord,) {
    const customerHistory = await getCustomerReturnHistory(
      returnRecord.store_id,
      returnRecord.customer_id,
    );

    const { risk_score, factors, } = scoreReturn(returnRecord, customerHistory,);
    const { level, action, } = classifyRisk(risk_score,);

    return {
      risk_score,
      risk_level: level,
      recommended_action: action,
      factors,
      return_record: returnRecord,
    };
  }

  async function bulkScoreReturns(store_id,) {
    const pendingReturns = await store.returns.find(
      (r,) => r.store_id === store_id && r.status === 'pending',
    );

    const results = [];
    for (const returnRecord of pendingReturns) {
      const analysis = await analyzeReturn(returnRecord,);
      results.push(analysis,);
    }

    return results.sort((a, b,) => b.risk_score - a.risk_score,);
  }

  async function getFraudStats(store_id,) {
    const allReturns = await store.returns.find(
      (r,) => r.store_id === store_id,
    );

    const total_returns = allReturns.length;
    const flagged_returns = allReturns.filter((r,) => r.risk_level === 'high' || r.risk_level === 'critical',).length;
    const auto_approved = allReturns.filter((r,) => r.recommended_action === 'auto_approve',).length;
    const auto_denied = allReturns.filter((r,) => r.recommended_action === 'auto_deny',).length;
    const total_value_at_risk = allReturns
      .filter((r,) => r.risk_level === 'high' || r.risk_level === 'critical',)
      .reduce((sum, r,) => sum + (r.return_value || 0), 0,);
    const fraud_prevented_amount = allReturns
      .filter((r,) => r.recommended_action === 'auto_deny',)
      .reduce((sum, r,) => sum + (r.return_value || 0), 0,);
    const avg_risk_score = total_returns > 0
      ? allReturns.reduce((sum, r,) => sum + (r.risk_score || 0), 0,) / total_returns
      : 0;

    return {
      total_returns,
      flagged_returns,
      auto_approved,
      auto_denied,
      total_value_at_risk,
      fraud_prevented_amount,
      avg_risk_score: Math.round(avg_risk_score,),
    };
  }

  async function auditDecision(return_id, decision, reason,) {
    const record = {
      return_id,
      decision,
      reason,
      auto_generated: true,
      timestamp: new Date().toISOString(),
    };
    await store.returnAuditLog.insert(record,);
    return record;
  }

  return {
    scoreReturn,
    classifyRisk,
    analyzeReturn,
    getCustomerReturnHistory,
    bulkScoreReturns,
    getFraudStats,
    auditDecision,
  };
}

module.exports = { createReturnFraudEngine, };
