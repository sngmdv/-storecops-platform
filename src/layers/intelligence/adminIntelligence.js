"use strict";

/**
 * Admin Intelligence — CEO command-center tools.
 *
 * Provides executive-level insights that directly drive revenue:
 *  - CEO Daily Brief: top priorities, revenue at risk, new leads
 *  - Revenue Forecast: 30/60/90 day MRR projections
 *  - Lead Funnel Engine: multi-source lead capture + behavioral scoring
 *  - Campaign Engine: targeted outreach to leads/segments
 *  - Feature Adoption: which tools drive retention
 */

// ─── helpers ────────────────────────────────────────────────────────────────

function avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function sum(arr) {
  return (arr || []).reduce((s, v) => s + (v || 0), 0);
}

function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function daysBetween(a, b) {
  return Math.max(0, Math.floor((new Date(b) - new Date(a)) / 864e5));
}

function ago(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ─── ceo daily brief ────────────────────────────────────────────────────────

/**
 * Generate a single-page executive brief — the CEO's daily snapshot.
 * Combines retention, revenue, leads, and platform health into
 * actionable priorities.
 */
function generateCEOBrief({ stores, leads, retentionSnapshots, deliveries, events, campaignActions }) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // ── revenue snapshot ──
  const totalMRR = sum(stores.map(s => s.mrr || 0));
  const totalARR = totalMRR * 12;
  const atRiskRevenue = sum(stores
    .filter(s => (s.riskBand || "low") !== "low")
    .map(s => s.mrr || 0));

  // ── churn risk ──
  const atRiskStores = stores.filter(s => (s.riskBand || "low") !== "low");
  const criticalStores = stores.filter(s => s.riskBand === "critical");

  // ── leads snapshot ──
  const newLeadsToday = (leads || []).filter(l =>
    l.createdAt && l.createdAt.slice(0, 10) === today
  );
  const newLeadsThisWeek = (leads || []).filter(l => {
    if (!l.createdAt) return false;
    return daysBetween(l.createdAt, now) <= 7;
  });
  const hotLeads = (leads || []).filter(l => (l.score || 0) >= 80 && l.status === "new");

  // ── store health ──
  const healthyStores = stores.filter(s => (s.healthScore || 50) >= 70);
  const unhealthyStores = stores.filter(s => (s.healthScore || 50) < 40);

  // ── delivery stats ──
  const recentDeliveries = (deliveries || []).filter(d =>
    daysBetween(d.createdAt || d.scheduledFor, now) <= 7
  );
  const deliveredCount = recentDeliveries.filter(d => d.status === "delivered").length;
  const failedCount = recentDeliveries.filter(d => d.status === "failed").length;
  const deliveryRate = pct(deliveredCount, recentDeliveries.length);

  // ── top priorities (actionable) ──
  const priorities = [];

  // Priority 1: Critical stores need immediate attention
  if (criticalStores.length > 0) {
    priorities.push({
      type: "urgent",
      icon: "🚨",
      title: `${criticalStores.length} store(s) in CRITICAL risk`,
      detail: criticalStores.map(s => s.storeId).join(", "),
      action: "Send intervention immediately",
      revenueAtRisk: sum(criticalStores.map(s => s.mrr || 0)),
    });
  }

  // Priority 2: Hot leads need follow-up
  if (hotLeads.length > 0) {
    priorities.push({
      type: "revenue",
      icon: "🔥",
      title: `${hotLeads.length} hot lead(s) waiting`,
      detail: hotLeads.slice(0, 3).map(l => `${l.name || l.email} (${l.score})`).join(", "),
      action: "Personal outreach within 24h",
      potentialRevenue: sum(hotLeads.map(l => (l.score || 0) * 5)), // rough pipeline value
    });
  }

  // Priority 3: Failed deliveries
  if (failedCount > 0) {
    priorities.push({
      type: "ops",
      icon: "⚠️",
      title: `${failedCount} failed delivery/ies this week`,
      detail: `Delivery rate: ${deliveryRate}%`,
      action: "Check provider status & retry",
    });
  }

  // Priority 4: Expansion opportunities
  const expansionCandidates = stores.filter(s =>
    (s.mrr || 0) > 0 && (s.healthScore || 0) >= 60 && (s.upsellOpportunities || []).length > 0
  );
  if (expansionCandidates.length > 0) {
    priorities.push({
      type: "growth",
      icon: "📈",
      title: `${expansionCandidates.length} store(s) ready for upsell`,
      detail: expansionCandidates.slice(0, 3).map(s =>
        `${s.storeId}: ${s.upsellOpportunities.join(", ")}`
      ).join("; "),
      action: "Send upgrade proposal",
      potentialRevenue: sum(expansionCandidates.map(s =>
        (s.upsellOpportunities || []).length * 29
      )),
    });
  }

  // Priority 5: New leads today
  if (newLeadsToday.length > 0) {
    priorities.push({
      type: "leads",
      icon: "🎯",
      title: `${newLeadsToday.length} new lead(s) today`,
      detail: newLeadsToday.map(l => l.source || "unknown").join(", "),
      action: "Review and assign grade",
    });
  }

  // ── metrics summary ──
  const metrics = {
    totalMRR,
    totalARR,
    activeStores: stores.filter(s => s.status === "active").length,
    totalStores: stores.length,
    atRiskRevenue,
    atRiskPct: pct(atRiskRevenue, totalMRR),
    healthyStores: healthyStores.length,
    unhealthyStores: unhealthyStores.length,
    newLeadsToday: newLeadsToday.length,
    newLeadsThisWeek: newLeadsThisWeek.length,
    hotLeads: hotLeads.length,
    deliveryRate,
    totalLeads: (leads || []).length,
    conversionRate: pct(
      (leads || []).filter(l => l.status === "converted").length,
      (leads || []).length
    ),
  };

  return {
    date: today,
    priorities: priorities.slice(0, 5),
    metrics,
    revenueAtRisk: atRiskRevenue,
    pipelineValue: sum((leads || []).filter(l => l.status !== "lost").map(l => (l.score || 0) * 5)),
  };
}

// ─── revenue forecast ───────────────────────────────────────────────────────

/**
 * Project MRR for next 30/60/90 days based on:
 *  - Current MRR
 *  - Churn risk (weighted by severity)
 *  - Pipeline value (weighted by conversion probability)
 *  - Expansion revenue (weighted by likelihood)
 */
function generateRevenueForecast({ stores, leads, retentionSnapshots }) {
  const currentMRR = sum(stores.map(s => s.mrr || 0));

  // ── churn impact ──
  const churnRiskByBand = {
    critical: { probability: 0.6, stores: stores.filter(s => s.riskBand === "critical") },
    high: { probability: 0.3, stores: stores.filter(s => s.riskBand === "high") },
    medium: { probability: 0.1, stores: stores.filter(s => s.riskBand === "medium") },
    low: { probability: 0.02, stores: stores.filter(s => !s.riskBand || s.riskBand === "low") },
  };

  let monthlyChurnLoss = 0;
  for (const [band, { probability, stores: bandStores }] of Object.entries(churnRiskByBand)) {
    const bandMRR = sum(bandStores.map(s => s.mrr || 0));
    monthlyChurnLoss += bandMRR * probability;
  }

  // ── pipeline upside ──
  const leadsByStage = {
    new: (leads || []).filter(l => l.status === "new"),
    contacted: (leads || []).filter(l => l.status === "contacted"),
    qualified: (leads || []).filter(l => l.status === "qualified"),
    proposal: (leads || []).filter(l => l.status === "proposal"),
  };

  const conversionByStage = { new: 0.05, contacted: 0.15, qualified: 0.35, proposal: 0.6 };
  const avgDealSize = 49; // monthly subscription

  let monthlyPipelineGain = 0;
  for (const [stage, stageLeads] of Object.entries(leadsByStage)) {
    const expectedConversions = stageLeads.length * conversionByStage[stage];
    monthlyPipelineGain += expectedConversions * avgDealSize;
  }

  // ── expansion revenue ──
  const expansionCandidates = stores.filter(s =>
    (s.upsellOpportunities || []).length > 0 && s.status === "active"
  );
  const expansionRate = 0.15; // 15% of candidates will upgrade
  const avgExpansionRevenue = 29; // average upsell value
  const monthlyExpansionGain = expansionCandidates.length * expansionRate * avgExpansionRevenue;

  // ── projections ──
  const netMonthlyChange = -monthlyChurnLoss + monthlyPipelineGain + monthlyExpansionGain;

  const projections = [
    {
      period: "30 days",
      projectedMRR: Math.round(currentMRR + netMonthlyChange),
      churnLoss: Math.round(monthlyChurnLoss),
      pipelineGain: Math.round(monthlyPipelineGain),
      expansionGain: Math.round(monthlyExpansionGain),
      netChange: Math.round(netMonthlyChange),
      confidence: 0.7,
    },
    {
      period: "60 days",
      projectedMRR: Math.round(currentMRR + (netMonthlyChange * 2) * 0.9),
      churnLoss: Math.round(monthlyChurnLoss * 2),
      pipelineGain: Math.round(monthlyPipelineGain * 2 * 0.85),
      expansionGain: Math.round(monthlyExpansionGain * 2),
      netChange: Math.round(netMonthlyChange * 2 * 0.9),
      confidence: 0.55,
    },
    {
      period: "90 days",
      projectedMRR: Math.round(currentMRR + (netMonthlyChange * 3) * 0.75),
      churnLoss: Math.round(monthlyChurnLoss * 3),
      pipelineGain: Math.round(monthlyPipelineGain * 3 * 0.7),
      expansionGain: Math.round(monthlyExpansionGain * 3),
      netChange: Math.round(netMonthlyChange * 3 * 0.75),
      confidence: 0.4,
    },
  ];

  return {
    currentMRR,
    currentARR: currentMRR * 12,
    monthlyChurnLoss: Math.round(monthlyChurnLoss),
    monthlyPipelineGain: Math.round(monthlyPipelineGain),
    monthlyExpansionGain: Math.round(monthlyExpansionGain),
    netMonthlyChange: Math.round(netMonthlyChange),
    projections,
    breakdown: {
      churnByBand: Object.fromEntries(
        Object.entries(churnRiskByBand).map(([band, { probability, stores: bs }]) => [
          band,
          { stores: bs.length, mrrAtRisk: Math.round(sum(bs.map(s => s.mrr || 0)) * probability) },
        ])
      ),
      pipelineByStage: Object.fromEntries(
        Object.entries(leadsByStage).map(([stage, sl]) => [
          stage,
          { leads: sl.length, expectedConversions: Math.round(sl.length * conversionByStage[stage]), value: Math.round(sl.length * conversionByStage[stage] * avgDealSize) },
        ])
      ),
    },
  };
}

// ─── lead funnel engine ─────────────────────────────────────────────────────

/**
 * Multi-source lead capture and behavioral scoring.
 * Leads can come from:
 *  - audit: Free store audit submission
 *  - landing: Newsletter/email capture on landing page
 *  - trial: Connected store but no activity (trial expiry)
 *  - pricing: Visited pricing page
 *  - referral: Referred by existing customer
 *  - event: Webinar/event signup
 */
function captureLead({ leads, input }) {
  const { email, name, storeUrl, source, metadata } = input;
  if (!email) return { error: "Email required" };

  // Check for duplicate
  const existing = (leads || []).find(l => l.email === email);
  if (existing) {
    // Update source tracking if new source
    if (source && source !== existing.source) {
      existing.touchpoints = existing.touchpoints || [];
      existing.touchpoints.push({ source, at: new Date().toISOString() });
      existing.score = Math.min(100, (existing.score || 0) + 5); // multi-touch bonus
    }
    return { lead: existing, created: false };
  }

  // Calculate initial score based on source and signals
  let score = 30; // base
  const sourceBonus = { audit: 15, referral: 20, trial: 10, pricing: 5, landing: 0, event: 10 };
  score += sourceBonus[source] || 0;

  // Has store URL = more serious
  if (storeUrl) score += 10;

  // Shopify store bonus
  const domain = (storeUrl || "").replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
  if (domain.includes("myshopify.com") || domain.includes("shopify")) score += 10;

  const lead = {
    id: `lead_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    email,
    name: name || null,
    storeUrl: storeUrl || null,
    source: source || "unknown",
    score: Math.min(100, score),
    grade: score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D",
    status: "new",
    touchpoints: [{ source: source || "unknown", at: new Date().toISOString() }],
    metadata: metadata || {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return { lead, created: true };
}

/**
 * Score leads based on behavioral signals.
 * Call this periodically to update scores based on recent activity.
 */
function scoreLeadsBehavioral({ leads, events, auditResults }) {
  const scored = [];

  for (const lead of (leads || [])) {
    let score = lead.score || 30;
    const signals = [];

    // Signal: ran audit recently
    const hasAudit = (auditResults || []).some(a =>
      a.storeUrl === lead.storeUrl || a.email === lead.email
    );
    if (hasAudit) {
      score += 10;
      signals.push("ran_audit");
    }

    // Signal: multiple touchpoints (engaged across channels)
    const touchpointCount = (lead.touchpoints || []).length;
    if (touchpointCount >= 3) {
      score += 15;
      signals.push("multi_touch");
    } else if (touchpointCount >= 2) {
      score += 8;
      signals.push("repeat_engagement");
    }

    // Signal: recency (engaged in last 7 days)
    const lastTouch = lead.touchpoints?.[lead.touchpoints.length - 1];
    if (lastTouch && daysBetween(lastTouch.at, Date.now()) <= 7) {
      score += 10;
      signals.push("recent_activity");
    }

    // Signal: has connected store (trial)
    if (lead.storeUrl && lead.source === "trial") {
      score += 5;
      signals.push("has_store");
    }

    // Decay: no activity in 30+ days
    if (lastTouch && daysBetween(lastTouch.at, Date.now()) > 30) {
      score -= 10;
      signals.push("stale");
    }

    score = Math.max(0, Math.min(100, score));
    const grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D";

    scored.push({
      leadId: lead.id,
      previousScore: lead.score,
      newScore: score,
      grade,
      signals,
    });

    // Update lead in place
    lead.score = score;
    lead.grade = grade;
    lead.behavioralSignals = signals;
    lead.updatedAt = new Date().toISOString();
  }

  return scored;
}

/**
 * Detect trial expiry leads — stores that connected but went inactive.
 */
function detectTrialExpiry({ stores, events }) {
  const trialExpiry = [];
  const cutoff = ago(14); // 14 days without activity = trial expired

  for (const store of (stores || [])) {
    if (store.status !== "active") continue;

    // Check if store has recent events
    const storeEvents = (events || []).filter(e => e.storeId === store.storeId);
    const recentEvent = storeEvents.some(e => (e.timestamp || e.createdAt || "") > cutoff);

    if (!recentEvent && storeEvents.length > 0) {
      // Had events but none recently — trial may have expired
      trialExpiry.push({
        storeId: store.storeId,
        storeUrl: store.storeUrl,
        lastActivity: storeEvents.length > 0
          ? storeEvents[storeEvents.length - 1].timestamp || storeEvents[storeEvents.length - 1].createdAt
          : null,
        daysSinceActivity: storeEvents.length > 0
          ? daysBetween(storeEvents[storeEvents.length - 1].timestamp || storeEvents[storeEvents.length - 1].createdAt, Date.now())
          : null,
        mrr: store.mrr || 0,
        recommendation: "Send re-engagement campaign",
      });
    }
  }

  return trialExpiry;
}

// ─── campaign engine ────────────────────────────────────────────────────────

/**
 * Create a targeted campaign for leads or store segments.
 * Campaigns are structured outreach sequences.
 */
function createCampaign({ campaignActions }, input) {
  const { name, type, targetAudience, channel, message, schedule } = input;
  if (!name || !type) return { error: "Name and type required" };

  const campaign = {
    id: `camp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    type, // "win_back", "upsell", "onboarding", "seasonal", "referral", "trial_expiry"
    targetAudience, // { segment: "at_risk", leadGrade: "A", storeIds: [...] }
    channel: channel || "email", // "email", "whatsapp", "push", "multi"
    message: message || {},
    schedule: schedule || { startImmediately: true },
    status: "active",
    stats: {
      totalTargets: 0,
      sent: 0,
      opened: 0,
      responded: 0,
      converted: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return { campaign };
}

/**
 * Suggest campaigns based on current platform state.
 * Analyzes data and recommends high-impact outreach.
 */
function suggestCampaigns({ stores, leads, retentionSnapshots }) {
  const suggestions = [];

  // Win-back: stores with declining health
  const decliningStores = stores.filter(s =>
    (s.healthScore || 50) < 40 && s.status === "active"
  );
  if (decliningStores.length > 0) {
    suggestions.push({
      type: "win_back",
      priority: "high",
      title: `Win-back ${decliningStores.length} declining store(s)`,
      description: "Personalized outreach with health improvement plan",
      channel: "email",
      estimatedImpact: `$${sum(decliningStores.map(s => s.mrr || 0))} MRR at risk`,
      targetCount: decliningStores.length,
    });
  }

  // Upsell: healthy stores with expansion opportunities
  const upsellCandidates = stores.filter(s =>
    (s.healthScore || 0) >= 60 && (s.upsellOpportunities || []).length > 0
  );
  if (upsellCandidates.length > 0) {
    suggestions.push({
      type: "upsell",
      priority: "high",
      title: `Upsell ${upsellCandidates.length} healthy store(s)`,
      description: "Feature upgrade proposal based on usage patterns",
      channel: "email",
      estimatedImpact: `+$${upsellCandidates.length * 29}/mo potential`,
      targetCount: upsellCandidates.length,
    });
  }

  // Lead nurture: hot leads not yet contacted
  const hotUntouched = (leads || []).filter(l =>
    (l.score || 0) >= 70 && l.status === "new"
  );
  if (hotUntouched.length > 0) {
    suggestions.push({
      type: "onboarding",
      priority: "critical",
      title: `Contact ${hotUntouched.length} hot lead(s)`,
      description: "Personal welcome + demo offer within 24h",
      channel: "email",
      estimatedImpact: `${hotUntouched.length} × $49/mo = $${hotUntouched.length * 49}/mo potential`,
      targetCount: hotUntouched.length,
    });
  }

  // Trial expiry: inactive stores
  const inactiveStores = stores.filter(s =>
    s.status === "active" && (s.healthScore || 50) < 30
  );
  if (inactiveStores.length > 0) {
    suggestions.push({
      type: "trial_expiry",
      priority: "medium",
      title: `Re-engage ${inactiveStores.length} inactive store(s)`,
      description: "Send value reminder + limited-time offer",
      channel: "multi",
      estimatedImpact: `${inactiveStores.length} stores recoverable`,
      targetCount: inactiveStores.length,
    });
  }

  // Seasonal: Q4 preparation (if applicable)
  const month = new Date().getMonth();
  if (month >= 9 && month <= 11) {
    // Oct-Dec: holiday season prep
    suggestions.push({
      type: "seasonal",
      priority: "high",
      title: "Holiday season preparation campaign",
      description: "Help stores prepare for Black Friday / holiday rush",
      channel: "multi",
      estimatedImpact: "2-3x revenue lift for participating stores",
      targetCount: stores.filter(s => s.status === "active").length,
    });
  }

  // Referral: happy stores that could refer others
  const referralCandidates = stores.filter(s =>
    (s.healthScore || 0) >= 75 && s.status === "active"
  );
  if (referralCandidates.length > 0) {
    suggestions.push({
      type: "referral",
      priority: "low",
      title: `Ask ${referralCandidates.length} happy store(s) for referrals`,
      description: "Referral program with mutual benefits",
      channel: "email",
      estimatedImpact: `${referralCandidates.length} × 2.3 avg referrals = ${Math.round(referralCandidates.length * 2.3)} new leads`,
      targetCount: referralCandidates.length,
    });
  }

  return suggestions.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.priority] || 9) - (order[b.priority] || 9);
  });
}

// ─── feature adoption ───────────────────────────────────────────────────────

/**
 * Track which features/tools each store uses and correlate with retention.
 * Shows which features drive engagement and which are underused.
 */
function analyzeFeatureAdoption({ stores, events }) {
  const features = [
    "live_orders", "inventory", "customers", "automations",
    "messaging", "campaigns", "competitor_radar", "seo",
    "reports", "retention", "revenue", "dynamic_pricing",
  ];

  const adoption = {};
  for (const feature of features) {
    const users = (events || []).filter(e =>
      e.event === "feature_used" && e.data?.feature === feature
    );
    const uniqueStores = new Set(users.map(u => u.storeId));
    adoption[feature] = {
      activeUsers: uniqueStores.size,
      totalEvents: users.length,
      adoptionRate: pct(uniqueStores.size, stores.length),
    };
  }

  // Features correlated with retention
  const retainedStores = stores.filter(s => s.status === "active" && (s.healthScore || 0) >= 60);
  const churnedStores = stores.filter(s => s.status === "churned" || (s.riskBand || "low") === "critical");

  const featureRetentionCorrelation = {};
  for (const feature of features) {
    const retainedUsers = (events || []).filter(e =>
      e.event === "feature_used" && e.data?.feature === feature && retainedStores.some(s => s.storeId === e.storeId)
    );
    const churnedUsers = (events || []).filter(e =>
      e.event === "feature_used" && e.data?.feature === feature && churnedStores.some(s => s.storeId === e.storeId)
    );
    featureRetentionCorrelation[feature] = {
      retainedUsers: new Set(retainedUsers.map(u => u.storeId)).size,
      churnedUsers: new Set(churnedUsers.map(u => u.storeId)).size,
      retentionLift: retainedUsers.length > 0
        ? Math.round((new Set(retainedUsers.map(u => u.storeId)).size / Math.max(1, retainedStores.length)) * 100)
        : 0,
    };
  }

  // Top features by adoption
  const topFeatures = Object.entries(adoption)
    .sort((a, b) => b[1].activeUsers - a[1].activeUsers)
    .slice(0, 5)
    .map(([name, stats]) => ({ name, ...stats }));

  // Underused features (low adoption but high retention correlation)
  const underused = Object.entries(adoption)
    .filter(([, stats]) => stats.adoptionRate < 40)
    .map(([name, stats]) => ({
      name,
      ...stats,
      retentionCorrelation: featureRetentionCorrelation[name]?.retentionLift || 0,
    }))
    .sort((a, b) => b.retentionCorrelation - a.retentionCorrelation)
    .slice(0, 5);

  return {
    adoption,
    topFeatures,
    underusedFeatures: underused,
    featureRetentionCorrelation,
    totalStores: stores.length,
  };
}

// ─── exports ────────────────────────────────────────────────────────────────

module.exports = {
  generateCEOBrief,
  generateRevenueForecast,
  captureLead,
  scoreLeadsBehavioral,
  detectTrialExpiry,
  createCampaign,
  suggestCampaigns,
  analyzeFeatureAdoption,
};
