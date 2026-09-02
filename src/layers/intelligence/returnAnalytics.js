'use strict';

const PROCESSING_COST_PER_RETURN = 5;

function createReturnAnalytics({ store, }) {
  async function getReturnReasonAnalysis(store_id, days = 30,) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000,);
    const returns = await store.returns.find(
      (r,) => r.store_id === store_id && new Date(r.created_at,) >= since,
    );

    const reasonMap = {};
    let totalValue = 0;

    for (const ret of returns) {
      const reason = ret.reason || 'Unknown';
      if (!reasonMap[reason]) {
        reasonMap[reason] = { reason, count: 0, total_value: 0, };
      }
      reasonMap[reason].count += 1;
      reasonMap[reason].total_value += ret.return_value || 0;
      totalValue += ret.return_value || 0;
    }

    const reasons = Object.values(reasonMap,)
      .map((r,) => {
        return {
          ...r,
          pct: totalValue > 0 ? Math.round((r.total_value / totalValue) * 10000,) / 100 : 0,
        };
      },)
      .sort((a, b,) => b.total_value - a.total_value,);

    const top_reason = reasons.length > 0 ? reasons[0].reason : null;
    const top_reason_value = reasons.length > 0 ? reasons[0].total_value : 0;

    return { reasons, top_reason, top_reason_value, };
  }

  async function getTopReturnedSKUs(store_id, limit = 10,) {
    const returns = await store.returns.find(
      (r,) => r.store_id === store_id,
    );

    const skuMap = {};

    for (const ret of returns) {
      for (const item of ret.items || []) {
        const sku = item.sku;
        if (!skuMap[sku]) {
          skuMap[sku] = {
            sku,
            name: item.name,
            return_count: 0,
            return_value: 0,
          };
        }
        skuMap[sku].return_count += item.quantity || 1;
        skuMap[sku].return_value += (item.price || 0) * (item.quantity || 1);
      }
    }

    const skus = Object.values(skuMap,)
      .sort((a, b,) => b.return_count - a.return_count,)
      .slice(0, limit,)
      .map((s,) => {
        return {
          ...s,
          return_rate: s.return_count,
        };
      },);

    return { skus, };
  }

  async function getReturnCostAnalysis(store_id, days = 30,) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000,);
    const returns = await store.returns.find(
      (r,) => r.store_id === store_id && new Date(r.created_at,) >= since,
    );

    const total_returns = returns.length;
    const total_return_value = returns.reduce(
      (sum, r,) => sum + (r.return_value || 0), 0,
    );
    const avg_return_value = total_returns > 0
      ? Math.round((total_return_value / total_returns) * 100,) / 100
      : 0;

    const allOrders = await store.returns.find(
      (r,) => r.store_id === store_id,
    );
    const total_order_count = allOrders.length || 1;
    const return_rate_pct = Math.round((total_returns / total_order_count) * 10000,) / 100;

    const processing_cost = total_returns * PROCESSING_COST_PER_RETURN;
    const net_loss = total_return_value + processing_cost;

    return {
      total_returns,
      total_return_value,
      avg_return_value,
      return_rate_pct,
      processing_cost,
      net_loss,
    };
  }

  async function getReturnTrend(store_id, days = 90,) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000,);
    const returns = await store.returns.find(
      (r,) => r.store_id === store_id && new Date(r.created_at,) >= since,
    );

    const dayMap = {};

    for (const ret of returns) {
      const dateKey = new Date(ret.created_at,).toISOString().slice(0, 10,);
      if (!dayMap[dateKey]) {
        dayMap[dateKey] = { date: dateKey, count: 0, value: 0, };
      }
      dayMap[dateKey].count += 1;
      dayMap[dateKey].value += ret.return_value || 0;
    }

    const trend = Object.values(dayMap,).sort(
      (a, b,) => a.date.localeCompare(b.date,),
    );

    const moving_avg_7d = trend.map((entry, i,) => {
      const windowStart = Math.max(0, i - 6,);
      const window = trend.slice(windowStart, i + 1,);
      const avg = window.reduce((sum, w,) => sum + w.count, 0) / window.length;
      return Math.round(avg * 100,) / 100;
    },);

    return { trend, moving_avg_7d, };
  }

  async function getCustomerReturnProfile(store_id, customer_id,) {
    const returns = await store.returns.find(
      (r,) => r.store_id === store_id && r.customer_id === customer_id,
    );

    const total_returns = returns.length;
    const total_return_value = returns.reduce(
      (sum, r,) => sum + (r.return_value || 0), 0,
    );

    const allOrders = await store.returns.find(
      (r,) => r.store_id === store_id,
    );
    const customerOrderCount = allOrders.filter(
      (r,) => r.customer_id === customer_id,
    ).length || 1;
    const return_rate = Math.round((total_returns / customerOrderCount) * 10000,) / 100;

    const is_serial_returner = total_returns >= 3 && return_rate > 30;

    let avg_days_to_return = 0;
    if (returns.length > 0) {
      const totalDays = returns.reduce((sum, r,) => {
        const created = new Date(r.created_at,).getTime();
        return sum + created;
      }, 0,) / returns.length;
      avg_days_to_return = Math.round(
        (Date.now() - totalDays) / (24 * 60 * 60 * 1000) * 10,
      ) / 10;
    }

    return {
      customer_id,
      total_returns,
      total_return_value,
      return_rate,
      is_serial_returner,
      avg_days_to_return,
    };
  }

  async function getPolicyPerformance(store_id,) {
    const returns = await store.returns.find(
      (r,) => r.store_id === store_id,
    );

    let auto_approved_count = 0;
    let manual_review_count = 0;
    let denied_count = 0;
    let total_processing_ms = 0;
    let processed_count = 0;

    for (const ret of returns) {
      if (ret.status === 'approved' && (ret.risk_score || 0) < 30) {
        auto_approved_count += 1;
      } else if (ret.status === 'denied') {
        denied_count += 1;
      } else {
        manual_review_count += 1;
      }

      if (ret.created_at && ret.processed_at) {
        total_processing_ms += new Date(ret.processed_at,).getTime()
          - new Date(ret.created_at,).getTime();
        processed_count += 1;
      }
    }

    const total_decisions = auto_approved_count + manual_review_count + denied_count;
    const approval_rate_pct = total_decisions > 0
      ? Math.round((auto_approved_count + manual_review_count) / total_decisions * 10000,) / 100
      : 0;
    const avg_processing_hours = processed_count > 0
      ? Math.round((total_processing_ms / processed_count / (1000 * 60 * 60)) * 100,) / 100
      : 0;

    return {
      auto_approved_count,
      manual_review_count,
      denied_count,
      approval_rate_pct,
      avg_processing_hours,
    };
  }

  async function getReturnImpactReport(store_id, days = 30,) {
    const [costAnalysis, reasons, skus, trend, policy,] = await Promise.all([
      getReturnCostAnalysis(store_id, days,),
      getReturnReasonAnalysis(store_id, days,),
      getTopReturnedSKUs(store_id,),
      getReturnTrend(store_id,),
      getPolicyPerformance(store_id,),
    ],);

    const trend_summary = trend.trend.length > 0
      ? {
        total_days: trend.trend.length,
        avg_daily_returns: Math.round(
          trend.trend.reduce((s, d,) => s + d.count, 0) / trend.trend.length * 100,
        ) / 100,
        peak_day: trend.trend.reduce((max, d,) => d.count > max.count ? d : max,),
      }
      : { total_days: 0, avg_daily_returns: 0, peak_day: null, };

    const recommendations = generateRecommendations(store_id,);

    return {
      period: `${days} days`,
      cost_analysis: costAnalysis,
      top_reasons: reasons.reasons.slice(0, 5,),
      top_skus: skus.skus.slice(0, 5,),
      trend_summary,
      policy_performance: policy,
      recommendations,
    };
  }

  async function generateRecommendations(store_id,) {
    const recommendations = [];
    const reasons = await getReturnReasonAnalysis(store_id,);
    const skus = await getTopReturnedSKUs(store_id,);
    const cost = await getReturnCostAnalysis(store_id,);
    const returns = await store.returns.find(
      (r,) => r.store_id === store_id,
    );

    if (reasons.top_reason) {
      const reasonLower = reasons.top_reason.toLowerCase();
      if (reasonLower.includes('fit') || reasonLower.includes('size')) {
        const topSku = skus.skus.length > 0 ? skus.skus[0].name : 'top products';
        recommendations.push({
          type: 'product_info',
          priority: 'high',
          message: `Update size guide for ${topSku}`,
          action: 'update_size_guide',
        },);
      }
      if (reasonLower.includes('defect') || reasonLower.includes('quality')) {
        const topSku = skus.skus.length > 0 ? skus.skus[0].name : 'unknown product';
        recommendations.push({
          type: 'quality_alert',
          priority: 'critical',
          message: `Quality alert: investigate supplier for ${topSku}`,
          action: 'investigate_supplier',
        },);
      }
      if (reasonLower.includes('wrong') || reasonLower.includes('incorrect')) {
        recommendations.push({
          type: 'process_improvement',
          priority: 'high',
          message: 'Review order fulfillment accuracy - wrong item returns detected',
          action: 'review_fulfillment',
        },);
      }
    }

    const customerMap = {};
    for (const ret of returns) {
      if (!customerMap[ret.customer_id]) {
        customerMap[ret.customer_id] = 0;
      }
      customerMap[ret.customer_id] += 1;
    }

    for (const [customerId, count] of Object.entries(customerMap)) {
      if (count >= 3) {
        recommendations.push({
          type: 'customer_policy',
          priority: 'medium',
          message: `Consider restricting return privileges for customer ${customerId}`,
          action: 'restrict_customer_returns',
        },);
      }
    }

    if (cost.return_rate_pct > 15) {
      recommendations.push({
        type: 'business_review',
        priority: 'high',
        message: 'Return rate above threshold - review product listings',
        action: 'review_product_listings',
      },);
    }

    if (cost.total_return_value > 1000) {
      recommendations.push({
        type: 'financial',
        priority: 'medium',
        message: `High return costs: $${cost.total_return_value.toFixed(2,)} in returns - consider policy adjustments`,
        action: 'review_return_policy',
      },);
    }

    return recommendations;
  }

  return {
    getReturnReasonAnalysis,
    getTopReturnedSKUs,
    getReturnCostAnalysis,
    getReturnTrend,
    getCustomerReturnProfile,
    getPolicyPerformance,
    getReturnImpactReport,
    generateRecommendations,
  };
}

module.exports = { createReturnAnalytics, };
