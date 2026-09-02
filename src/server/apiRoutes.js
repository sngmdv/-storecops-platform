'use strict';

/**
 * API v1 routes — one section per architecture layer, plus the
 * cross-layer growth-cycle endpoint. Every handler delegates straight
 * to the platform object; no business logic lives here.
 */

const express = require('express',);
const { webhookVerifier, exportCustomerData, deleteCustomerData, } = require('./security',);
const { safeUser, } = require('./auth',);

function wrap(handler,) {
  return async (req, res,) => {
    try {
      const result = await handler(req, res,);
      if (result !== undefined && !res.headersSent) res.json(result,);
    } catch (error) {
      res.status(400,).json({ error: error.message, },);
    }
  };
}

/**
 * Build the HTML email body for a report delivery.
 */
function buildReportEmailHtml(report, email,) {
  const scoreColor = report.overall_score >= 70 ? '#38a169' : report.overall_score >= 50 ? '#d69e2e' : '#e53e3e';
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a2e;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Your Store Health Report</h1>
    <p style="color: #c4b5fd; margin: 8px 0 0;">Storecops Growth Platform</p>
  </div>
  <div style="padding: 30px; background: #f8f9fa; border-radius: 0 0 12px 12px;">
    <p style="font-size: 16px;">Hi there,</p>
    <p style="font-size: 16px;">We've analyzed <strong>${report.url}</strong> and here's your store's health snapshot:</p>
    
    <div style="text-align: center; margin: 30px 0;">
      <div style="font-size: 48px; font-weight: bold; color: ${scoreColor};">${report.overall_score}<span style="font-size: 24px;">/100</span></div>
      <div style="font-size: 14px; color: #666;">Overall Health Score — Grade: <strong>${report.grade}</strong></div>
    </div>

    <div style="display: flex; gap: 10px; margin: 20px 0;">
      <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
        <div style="font-size: 20px; font-weight: bold; color: #667eea;">${report.categories.seo.score}%</div>
        <div style="font-size: 12px; color: #666;">SEO</div>
      </div>
      <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
        <div style="font-size: 20px; font-weight: bold; color: #667eea;">${report.categories.performance.score}%</div>
        <div style="font-size: 12px; color: #666;">Performance</div>
      </div>
      <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
        <div style="font-size: 20px; font-weight: bold; color: #667eea;">${report.categories.security.score}%</div>
        <div style="font-size: 12px; color: #666;">Security</div>
      </div>
      <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
        <div style="font-size: 20px; font-weight: bold; color: #667eea;">${report.ai_readiness.score}%</div>
        <div style="font-size: 12px; color: #666;">AI Ready</div>
      </div>
    </div>

    <p style="font-size: 14px; margin: 20px 0;"><strong>Your full report is attached as a PDF.</strong></p>
    <p style="font-size: 14px; color: #666;">It includes detailed findings, prioritized issues to fix, and actionable recommendations to grow your store's online presence.</p>

    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea;">
      <p style="font-size: 14px; font-weight: bold; color: #667eea; margin: 0 0 10px;">Ready to fix these issues automatically?</p>
      <p style="font-size: 13px; color: #666; margin: 0;">Storecops can implement all recommendations with one click — SEO fixes, AI search optimization, competitor tracking, and more.</p>
      <p style="text-align: center; margin: 15px 0 0;">
        <a href="#" style="background: #667eea; color: white; padding: 10px 25px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;">Start Free Trial</a>
      </p>
    </div>

    <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
    <p style="font-size: 12px; color: #999;">This report was sent to ${email}. If you believe this was sent in error, please ignore it.</p>
    <p style="font-size: 12px; color: #999;">Storecops Growth Platform — AI-driven e-commerce intelligence.</p>
  </div>
</body>
</html>`;
}

function createApiRouter(platform,) {
  const router = express.Router();
  /**
   * Resolve the store a request acts on.
   *
   * Tenants are pinned to their own store, so a request that names no
   * store (or names someone else's) can never fall through to the
   * platform default — which previously exposed demo/other tenants' data.
   * Platform operators stay unscoped so the console can span tenants.
   */
  const defaultStore = (req,) => {
    if (req.authUser && !req.authUser.platform_admin) {
      return req.authUser.store_id || platform.config.defaultStoreId;
    }
    return req.params.store_id || req.body?.store_id || platform.config.defaultStoreId;
  };

  /** Extract pagination params from query string and apply to an array. */
  function paginate(arr, req, { maxDefault = 50, maxCap = 200, } = {},) {
    const limit = Math.min(Number(req.query.limit,) || maxDefault, maxCap,);
    const offset = Math.max(Number(req.query.offset,) || 0, 0,);
    const total = arr.length;
    return {
      total,
      limit,
      offset,
      has_more: offset + limit < total,
      data: arr.slice(offset, offset + limit,),
    };
  }

  // ── Tenant isolation ────────────────────────────────────────────────
  // A tenant may only ever touch its own store; platform operators
  // (master key, or users listed in PLATFORM_ADMIN_EMAILS) are unscoped
  // by design and are the only identities that reach /admin/*.

  const isOperator = (req,) => req.authUser?.platform_admin === true;

  // 1. Platform-wide operator surfaces are closed to tenants.
  router.use((req, res, next,) => {
    if (req.path === '/admin' || req.path.startsWith('/admin/',)) {
      if (!isOperator(req,)) {
        return res.status(403,).json({ error: 'Operator access required.', },);
      }
    }
    return next();
  },);

  // 2. Any route carrying :store_id must name a store the caller owns.
  //    router.param is the only hook guaranteed to see route params before
  //    the handler runs (router.use sees an empty req.params).
  router.param('store_id', (req, res, next, storeId,) => {
    if (!req.authUser) return next();
    if (isOperator(req,)) return next();
    if (!req.authUser.store_id || storeId !== req.authUser.store_id) {
      return res.status(403,).json({
        error: 'Access denied: that store does not belong to this account.',
      },);
    }
    return next();
  },);

  // RBAC gate: reads need `read`, everything else needs `mutate` (10.1).
  // With zero users registered (fresh install) the gate is open.
  // Machine/browser routes are exempt: /track authenticates via API key +
  // webhook HMAC, and SSE (/live/*) can't send custom headers at all.
  router.use((req, res, next,) => {
    // Write-only ingest keys (tracking snippet) may only post events.
    if (req.ingestOnly && !(req.path === '/track' || req.path.startsWith('/track/batch',))) {
      return res.status(403,).json({ error: 'This key is write-only (event ingestion).', },);
    }
    if (req.path === '/track' || req.path.startsWith('/live/',)) return next();
    const permission = req.method === 'GET' ? 'read' : 'mutate';
    return platform.rbac.middleware(permission,)(req, res, next,);
  },);

  // ── Layer 1: Data Foundation ────────────────────────────────────────

  router.post(
    '/track',
    webhookVerifier(platform.config.security?.webhookSecret,),
    wrap(async (req,) => {
      const result = await platform.trackAndReact(req.body || {},);
      if (!result.accepted) {
        const error = new Error(result.errors.join(' ',),);
        error.errors = result.errors;
        throw error;
      }
      return result;
    },),
  );

  router.post(
    '/track/batch',
    wrap(async (req,) => platform.eventTracker.trackBatch(req.body?.events || [],),),
  );

  router.get(
    '/customers/:store_id',
    wrap(async (req,) => {
      const all = await platform.customerProfiles.list(req.params.store_id,);
      return paginate(all, req,);
    },),
  );

  router.get(
    '/customers/:store_id/:customer_id',
    wrap(async (req,) => {
      const profile = await platform.customerProfiles.get(req.params.store_id, req.params.customer_id,);
      if (!profile) return { error: 'Customer not found.', found: false, };
      const history = await platform.customerProfiles.history(req.params.store_id, req.params.customer_id,);
      return { profile, event_count: history.length, };
    },),
  );

  router.post(
    '/competitors/snapshots',
    wrap(async (req,) => platform.competitorIngestor.ingestSnapshot(req.body || {},),),
  );

  router.post(
    '/signals',
    wrap(async (req,) => platform.externalSignals.ingest(req.body || {},),),
  );

  router.post(
    '/signals/batch',
    wrap(async (req,) => platform.externalSignals.ingestBatch(req.body?.signals || [],),),
  );

  router.post(
    '/sentiment/samples',
    wrap(async (req,) => platform.sentimentCollector.collect(req.body || {},),),
  );

  // Search Console & SEO data integrator.
  router.post(
    '/search-console/:store_id/performance',
    wrap(async (req,) =>
      platform.searchConsole.ingestPerformance({ store_id: req.params.store_id, rows: req.body?.rows || [], },),
    ),
  );

  router.post(
    '/search-console/:store_id/rankings',
    wrap(async (req,) =>
      platform.searchConsole.ingestRankings({ store_id: req.params.store_id, rankings: req.body?.rankings || [], },),
    ),
  );

  router.get(
    '/search-console/:store_id/performance',
    wrap(async (req,) => platform.searchConsole.performance(req.params.store_id,),),
  );

  // Competitor ad intelligence.
  router.post(
    '/ads/:store_id/ingest',
    wrap(async (req,) =>
      platform.adIntelligence.ingest({ store_id: req.params.store_id, ads: req.body?.ads || [], },),
    ),
  );

  router.get(
    '/ads/:store_id',
    wrap(async (req,) => platform.adIntelligence.analyze(req.params.store_id,),),
  );

  // ── Layer 2: Intelligence ───────────────────────────────────────────

  router.get(
    '/recommendations/:store_id/:customer_id',
    wrap(async (req,) =>
      platform.recommendationEngine.recommend(
        req.params.store_id,
        req.params.customer_id,
        Number(req.query.limit,) || 5,
      ),
    ),
  );

  router.get(
    '/churn/:store_id',
    wrap(async (req,) => platform.churnScoring.scoreStore(req.params.store_id,),),
  );

  router.get(
    '/churn/:store_id/:customer_id',
    wrap(async (req,) => {
      const score = await platform.churnScoring.scoreCustomer(req.params.store_id, req.params.customer_id,);
      return score || { error: 'Customer not found.', found: false, };
    },),
  );

  router.get(
    '/competitors/:store_id',
    wrap(async (req,) => platform.competitorIntelligence.analyzeStore(req.params.store_id,),),
  );

  router.get(
    '/trends/:store_id',
    wrap(async (req,) => platform.trendIntelligence.analyze(req.params.store_id, Number(req.query.limit,) || 10,),),
  );

  router.get(
    '/sentiment/:store_id',
    wrap(async (req,) => platform.brandSentiment.analyze(req.params.store_id,),),
  );

  router.post(
    '/seo/audit',
    wrap(async (req,) => {
      const { url, } = req.body || {};
      if (!url) throw new Error('url is required.',);
      return platform.seoAuditEngine.auditUrl(url,);
    },),
  );

  router.post(
    '/inventory/:store_id/analyze',
    wrap(async (req,) =>
      platform.inventoryIntelligence.analyze(
        req.params.store_id,
        req.body?.inventory || [],
        Number(req.query.window_days,) || 30,
      ),
    ),
  );

  // ── Live orders & stock ledger ──────────────────────────────────────

  router.get(
    '/orders/:store_id/live',
    wrap(async (req,) =>
      platform.liveOrders.recent(req.params.store_id, Number(req.query.limit,) || 20,),
    ),
  );

  router.get(
    '/orders/:store_id/customer/:customer_id',
    wrap(async (req,) =>
      platform.liveOrders.customerPurchases(req.params.store_id, req.params.customer_id,),
    ),
  );

  router.post(
    '/inventory/:store_id/stock',
    wrap(async (req,) =>
      platform.inventoryLedger.setStock({ store_id: req.params.store_id, ...req.body, },),
    ),
  );

  router.post(
    '/inventory/:store_id/stock/batch',
    wrap(async (req,) => platform.inventoryLedger.setStockBatch(req.params.store_id, req.body?.items || [],),),
  );

  router.post(
    '/inventory/:store_id/restock',
    wrap(async (req,) =>
      platform.inventoryLedger.restock({ store_id: req.params.store_id, ...req.body, },),
    ),
  );

  router.get(
    '/inventory/:store_id/levels',
    wrap(async (req,) => platform.inventoryLedger.levels(req.params.store_id,),),
  );

  /**
   * Real-time purchase stream (Server-Sent Events). Browsers get a
   * `purchase` event the instant a sale lands — powers the live order
   * ticker on the dashboard.
   */
  router.get('/live/:store_id', (req, res,) => {
    const { store_id, } = req.params;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },);
    res.write(`event: connected\ndata: ${JSON.stringify({ store_id, },)}\n\n`,);

    const onPurchase = (payload,) => {
      if (payload.store_id !== store_id) return;
      res.write(`event: purchase\ndata: ${JSON.stringify(payload,)}\n\n`,);
    };
    platform.live.on('purchase', onPurchase,);

    const heartbeat = setInterval(() => res.write(': ping\n\n',), 25000,);

    req.on('close', () => {
      clearInterval(heartbeat,);
      platform.live.off('purchase', onPurchase,);
    },);
  },);

  // ── Product insights (sell-fast / restock suggestions) ──────────────

  router.get(
    '/insights/:store_id/products',
    wrap(async (req,) =>
      platform.productInsights.analyze(req.params.store_id, Number(req.query.window_days,) || 30,),
    ),
  );

  // ── SEO growth (intent gap, content, auto-fix, rankings) ──────────

  router.post(
    '/seo/:store_id/intent-gap',
    wrap(async (req,) =>
      platform.seoGrowth.intentGap(req.params.store_id, req.body?.covered_keywords || [],),
    ),
  );

  router.post(
    '/seo/:store_id/content-ideas',
    wrap(async (req,) =>
      platform.seoGrowth.contentOpportunities(
        req.params.store_id,
        req.body?.covered_keywords || [],
        Number(req.query.limit,) || 10,
      ),
    ),
  );

  router.post(
    '/seo/autofix',
    wrap(async (req,) => {
      const { url, brand, keywords, } = req.body || {};
      if (!url) throw new Error('url is required.',);
      const audit = await platform.seoAuditEngine.auditUrl(url,);
      return platform.seoGrowth.autoFixSuggestions(audit, { brand, keywords, },);
    },),
  );

  // ── SEO Optimizer (one-click fix + AI visibility) ────────────────

  router.post(
    '/seo/optimize',
    wrap(async (req,) => {
      const { url, brand, domain, keywords, description, category, socialProfiles, } = req.body || {};
      if (!url) throw new Error('url is required.',);
      const audit = await platform.seoAuditEngine.auditUrl(url,);
      const optimization = platform.seoAutoFix.generateFullOptimization(audit, {
        brand: brand || audit.url,
        domain,
        storeUrl: audit.url,
        keywords: keywords || [],
        description: description || '',
        category: category || '',
        socialProfiles: socialProfiles || {},
      },);
      optimization.store_id = req.body?.store_id || null;
      optimization.audit_id = audit.audited_at;
      const saved = await platform.store.seoOptimizations.insert(optimization,);
      return { ...optimization, _id: saved._id, };
    },),
  );

  router.get(
    '/seo/optimization/:id',
    wrap(async (req,) => platform.store.seoOptimizations.findById(req.params.id,),),
  );

  router.get(
    '/seo/optimizations/:store_id',
    wrap(async (req,) => {
      const all = await platform.store.seoOptimizations.find(
        (o,) => o.store_id === req.params.store_id,
      );
      return all.sort((a, b,) => (b.generated_at || '').localeCompare(a.generated_at || '',),);
    },),
  );

  router.post(
    '/seo/ai-optimize',
    wrap(async (req,) => {
      const { brand, domain, storeUrl, keywords, description, category, socialProfiles, } = req.body || {};
      return platform.seoAutoFix.generateAiOptimization({
        brand: brand || 'Our Store',
        domain,
        storeUrl,
        keywords: keywords || [],
        description: description || '',
        category: category || '',
        socialProfiles: socialProfiles || {},
      },);
    },),
  );

  // Get connected store URL/domain for auto-fill
  router.get(
    '/seo/store-info/:store_id',
    wrap(async (req,) => {
      const { store_id, } = req.params;
      // Try to find the store domain from integrations
      const integration = await platform.store.integrations.findOne({ store_id, },);
      const domain = integration?.config?.shopDomain || integration?.config?.storeUrl || null;
      const storeUrl = domain ? `https://${domain.replace(/^https?:\/\//, '',)}` : null;
      return {
        store_id,
        store_url: storeUrl,
        domain: domain || null,
        brand: store_id.replace(/[_-]/g, ' ',),
        connected: !!integration,
        type: integration?.type || null,
      };
    },),
  );

  // One-click: analyze + fix in a single call
  router.post(
    '/seo/one-click-fix',
    wrap(async (req,) => {
      const { store_id, url, brand, keywords, category, } = req.body || {};
      if (!url) throw new Error('url is required.',);

      // Step 1: Run the audit
      const audit = await platform.seoAuditEngine.auditUrl(url,);

      // Step 2: Generate full optimization (SEO + AI)
      const optimization = platform.seoAutoFix.generateFullOptimization(audit, {
        brand: brand || audit.url,
        domain: new URL(audit.url,).hostname,
        storeUrl: audit.url,
        keywords: keywords || [],
        description: '',
        category: category || '',
      },);

      optimization.store_id = store_id || null;
      optimization.audit_id = audit.audited_at;
      optimization.one_click = true;
      const saved = await platform.store.seoOptimizations.insert(optimization,);
      return { ...optimization, _id: saved._id, };
    },),
  );

  router.get(
    '/seo/:store_id/rankings',
    wrap(async (req,) =>
      platform.seoGrowth.rankingComparison(req.params.store_id, req.query.brand || 'us',),
    ),
  );

  router.post(
    '/seo/product-content',
    wrap(async (req,) => platform.seoGrowth.generateProductContent(req.body || {},),),
  );

  // ── Defection & seasonal opportunities ────────────────────────────

  router.get(
    '/defection/:store_id',
    wrap(async (req,) => platform.defectionDetector.detect(req.params.store_id,),),
  );

  router.get(
    '/seasonal/:store_id',
    wrap(async (req,) =>
      platform.seasonalAlerts.upcoming({
        store_id: req.params.store_id,
        categories: req.query.categories ? String(req.query.categories,).split(',',) : ['all',],
        horizonDays: Number(req.query.horizon_days,) || 45,
      },),
    ),
  );

  router.post(
    '/forecast',
    wrap(async (req,) =>
      platform.demandForecastEngine.forecast({
        store_id: defaultStore(req,),
        product_id: req.body?.product_id || null,
        horizonDays: Number(req.body?.horizon_days,) || 7,
      },),
    ),
  );

  router.get(
    '/forecast/:store_id',
    wrap(async (req,) => platform.demandForecastEngine.history(req.params.store_id,),),
  );

  // ── Layer 3: Decision ───────────────────────────────────────────────

  router.get(
    '/rules/:store_id',
    wrap(async (req,) => platform.rulesEngine.activeRules(req.params.store_id,),),
  );

  router.post(
    '/rules/:store_id',
    wrap(async (req,) => platform.rulesEngine.addRule(req.params.store_id, req.body || {},),),
  );

  router.post(
    '/pricing/recommend',
    wrap(async (req,) =>
      platform.dynamicPricing.recommend({
        store_id: defaultStore(req,),
        product_id: req.body?.product_id,
        current_price: req.body?.current_price,
      },),
    ),
  );

  // Get pricing recommendations for all products
  router.get(
    '/pricing/recommendations',
    wrap(async (req,) => {
      const store_id = req.authUser?.store_id || req.query.store_id;
      if (!store_id) throw new Error('store_id is required',);

      // Get products from inventory
      const products = await platform.store.events.find({ store_id, type: 'product' },) || [];
      const recommendations = [];

      for (const product of products.slice(0, 20,)) {
        try {
          const rec = await platform.dynamicPricing.recommend({
            store_id,
            product_id: product.product_id || product.id,
            current_price: product.price || product.current_price,
          },);
          recommendations.push(rec,);
        } catch (e) {
          // Skip products that can't be analyzed
        }
      }

      return { recommendations, };
    },),
  );

  router.post(
    '/orchestrator/scan/:store_id',
    wrap(async (req,) => platform.orchestrator.scanStore(req.params.store_id,),),
  );

  router.get(
    '/actions/:store_id/pending',
    wrap(async (req,) => platform.orchestrator.pendingActions(req.params.store_id,),),
  );

  // ── Segmentation, campaigns, send-time optimization ────────────────

  router.get(
    '/segments/:store_id',
    wrap(async (req,) => platform.segmentation.segmentStore(req.params.store_id,),),
  );

  router.get(
    '/segments/:store_id/:customer_id',
    wrap(async (req,) => {
      const result = await platform.segmentation.segmentCustomer(req.params.store_id, req.params.customer_id,);
      return result || { error: 'Customer not found.', found: false, };
    },),
  );

  router.post(
    '/campaigns/:store_id/generate',
    wrap(async (req,) =>
      platform.campaignGenerator.generate({
        store_id: req.params.store_id,
        categories: req.body?.categories || ['all',],
        maxDrafts: Number(req.body?.max_drafts,) || 5,
      },),
    ),
  );

  router.get(
    '/campaigns/:store_id',
    wrap(async (req,) => platform.campaignGenerator.list(req.params.store_id,),),
  );

  // ── Campaign Lifecycle: Launch → Execute → Measure ─────────────────

  // List campaigns with impact data (launch/execute/measure readiness).
  router.get(
    '/campaigns/:store_id/with-impact',
    wrap(async (req,) => platform.campaignLifecycle.listWithImpact(req.params.store_id,),),
  );

  // Launch a campaign: create personalized actions for target customers.
  router.post(
    '/campaigns/:store_id/launch/:campaign_id',
    wrap(async (req,) =>
      platform.campaignLifecycle.launch(req.params.campaign_id, req.params.store_id, {
        maxTargets: Number(req.body?.max_targets,) || 100,
      },),
    ),
  );

  // Execute a launched campaign: process pending actions through delivery pipeline.
  router.post(
    '/campaigns/:store_id/execute/:campaign_id',
    wrap(async (req,) =>
      platform.campaignLifecycle.execute(req.params.campaign_id, req.params.store_id,),
    ),
  );

  // Measure campaign impact: delivery rate, revenue delta, channel breakdown.
  router.get(
    '/campaigns/:store_id/measure/:campaign_id',
    wrap(async (req,) =>
      platform.campaignLifecycle.measure(req.params.campaign_id, req.params.store_id,),
    ),
  );

  router.get(
    '/send-time/:store_id/:customer_id',
    wrap(async (req,) =>
      platform.sendTimeOptimizer.bestSendHour(
        req.params.store_id,
        req.params.customer_id,
        req.query.channel || 'email',
      ),
    ),
  );

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
    wrap(async (req,) => {
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

  // ── Layer 5: Reporting & Attribution ────────────────────────────────

  router.post(
    '/attribution/:store_id/run',
    wrap(async (req,) => platform.attribution.attributeStore(req.params.store_id,),),
  );

  router.get(
    '/attribution/:store_id',
    wrap(async (req,) => {
      const report = await platform.attribution.latest(req.params.store_id,);
      return report || { store_id: req.params.store_id, report: null, };
    },),
  );

  router.get(
    '/attribution/:store_id/forecast-accuracy',
    wrap(async (req,) => platform.attribution.forecastAccuracy(req.params.store_id,),),
  );

  router.get(
    '/report/:store_id',
    wrap(async (req,) => platform.reporting.storeReport(req.params.store_id,),),
  );

  router.get(
    '/report/:store_id/history',
    wrap(async (req,) => platform.reporting.history(req.params.store_id,),),
  );

  router.get(
    '/report/:store_id/roi',
    wrap(async (req,) => platform.reporting.roi(req.params.store_id,),),
  );

  router.get(
    '/report/:store_id/maturity',
    wrap(async (req,) => platform.reporting.maturityScore(req.params.store_id,),),
  );

  router.get(
    '/report/:store_id/weekly-digest',
    wrap(async (req,) => platform.reporting.weeklyDigest(req.params.store_id,),),
  );

  router.post(
    '/report/:store_id/custom',
    wrap(async (req,) =>
      platform.reporting.customReport({
        store_id: req.params.store_id,
        from: req.body?.from || null,
        to: req.body?.to || null,
        event_types: req.body?.event_types || null,
        format: req.body?.format || 'json',
      },),
    ),
  );

  router.get(
    '/competitors/:store_id/landscape',
    wrap(async (req,) => platform.competitorIntelligence.landscapeReport(req.params.store_id,),),
  );

  // ── Competitor tracking & auto-scraping ────────────────────────────

  // List all tracked competitors for a store
  router.get(
    '/competitors/:store_id/tracked',
    wrap(async (req,) => {
      const all = await platform.store.trackedCompetitors.find({ store_id: req.params.store_id, },);
      return { store_id: req.params.store_id, competitors: all, };
    },),
  );

  // Add a competitor to track
  router.post(
    '/competitors/:store_id/tracked',
    wrap(async (req,) => {
      const { competitor, url, meta_page_id, } = req.body || {};
      if (!competitor || !url) throw new Error('competitor name and url are required.',);

      // Check for duplicates
      const existing = await platform.store.trackedCompetitors.findOne({
        store_id: req.params.store_id,
        competitor,
      },);
      if (existing) throw new Error(`Competitor "${competitor}" is already tracked.`,);

      const record = await platform.store.trackedCompetitors.insert({
        store_id: req.params.store_id,
        competitor,
        url: url.replace(/\/+$/, '',),
        meta_page_id: meta_page_id || null,
        enabled: true,
        added_at: new Date().toISOString(),
        last_scrape_at: null,
        last_scrape_status: null,
        last_product_count: 0,
        platform_detected: null,
      },);
      return record;
    },),
  );

  // Update a tracked competitor (URL, page ID, enable/disable)
  router.put(
    '/competitors/:store_id/tracked/:id',
    wrap(async (req,) => {
      const { url, meta_page_id, enabled, competitor, } = req.body || {};
      const patch = {};
      if (url !== undefined) patch.url = url.replace(/\/+$/, '',);
      if (meta_page_id !== undefined) patch.meta_page_id = meta_page_id;
      if (enabled !== undefined) patch.enabled = !!enabled;
      if (competitor !== undefined) patch.competitor = competitor;
      return platform.store.trackedCompetitors.update(req.params.id, patch,);
    },),
  );

  // Remove a tracked competitor
  router.delete(
    '/competitors/:store_id/tracked/:id',
    wrap(async (req,) => {
      // Soft-delete by disabling; data stays in case they re-add it
      return platform.store.trackedCompetitors.update(req.params.id, { enabled: false, },);
    },),
  );

  // Scrape a single competitor now
  router.post(
    '/competitors/:store_id/scrape/:id',
    wrap(async (req,) => {
      const config = await platform.store.trackedCompetitors.findById(req.params.id,);
      if (!config || config.store_id !== req.params.store_id) {
        throw new Error('Competitor not found.',);
      }
      const result = await platform.competitorScraper.scrapeCompetitor(
        req.params.store_id,
        config,
      );

      // Update tracking record
      await platform.store.trackedCompetitors.update(config._id, {
        last_scrape_at: new Date().toISOString(),
        last_scrape_status: result.status,
        last_product_count: result.products_scraped,
        platform_detected: result.platform_detected,
      },);

      return result;
    },),
  );

  // Scrape ALL tracked competitors for a store
  router.post(
    '/competitors/:store_id/scrape-all',
    wrap(async (req,) => platform.competitorScraper.scrapeAll(req.params.store_id,),),
  );

  // Scrape Meta Ad Library for all competitors with page IDs
  router.post(
    '/competitors/:store_id/scrape-ads',
    wrap(async (req,) => platform.metaAdLibrary.scrapeAllCompetitors(platform.store,),),
  );

  // Check if a URL is a Shopify store (probe endpoint)
  router.post(
    '/competitors/probe',
    wrap(async (req,) => {
      const { url, } = req.body || {};
      if (!url) throw new Error('url is required.',);
      const probe = await platform.competitorScraper.probeShopify(url,);
      return { url, is_shopify: !!probe?.isShopify, };
    },),
  );

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
    async (req, res,) => {
      const token = req.query.token;
      const parsed = platform.consentService.parseUnsubscribeToken(token,);
      if (!parsed) return res.status(400,).json({ error: 'Invalid or expired unsubscribe link.', },);

      await platform.consentService.suppressEmailGlobally(parsed.email, {
        reason: 'UNSUBSCRIBE',
        source: 'SELF_SERVICE',
        shopInstallationId: parsed.shopInstallationId || null,
      },);

      return res.json({ success: true, message: 'You have been unsubscribed. You will no longer receive marketing emails.', },);
    },
  );

  // ── Billing & Entitlements (Tasks 41-45) ────────────────────────────

  router.get(
    '/billing/:store_id/entitlement',
    wrap(async (req,) => platform.billingService.getEntitlement(req.params.store_id,),),
  );

  router.get(
    '/billing/plans',
    wrap(async () => platform.billingService.PLANS,),
  );

  router.get(
    '/billing/:store_id/price/:currency',
    wrap(async (req,) => {
      const planId = req.query.plan || 'growth';
      return platform.billingService.getRegionalPrice(planId, req.params.currency,);
    },),
  );

  router.post(
    '/billing/:store_id/subscription',
    wrap(async (req,) =>
      platform.billingService.upsertSubscription(req.params.store_id, req.body || {},),
    ),
  );

  router.post(
    '/billing/webhook',
    wrap(async (req,) => platform.billingService.handleSubscriptionEvent(req.body || {},),),
  );

  // Task 41: Create a Shopify recurring application charge.
  router.post(
    '/billing/:store_id/charge',
    wrap(async (req,) => {
      const { shop_domain, access_token, plan_id, currency, test, } = req.body || {};
      if (!shop_domain || !access_token) throw new Error('shop_domain and access_token are required.',);
      return platform.billingService.createShopifyCharge(shop_domain, access_token, plan_id || 'growth', {
        shopInstallationId: req.params.store_id,
        return_url: req.body?.return_url,
        currency,
        test,
      },);
    },),
  );

  // Task 43: Shopify app_subscriptions/update webhook handler.
  // This is called by Shopify when a merchant accepts/declines/cancels
  // a recurring charge. HMAC-verified by the webhookVerifier middleware.
  router.post(
    '/billing/shopify-webhook',
    webhookVerifier(platform.config.security?.webhookSecret,),
    wrap(async (req,) => platform.billingService.handleShopifySubscriptionWebhook(req.body || {},),),
  );

  // ── Referral & Affiliate System ──────────────────────────────────

  // Get referral code for merchant
  router.get(
    '/referral/:store_id/code',
    wrap(async (req,) => {
      const merchant = await platform.store.users.findOne({ store_id: req.params.store_id, },);
      if (!merchant) throw new Error('Merchant not found',);
      return platform.referralService.getOrCreateReferralCode(merchant._id, req.params.store_id,);
    },),
  );

  // Get referral stats for merchant
  router.get(
    '/referral/:store_id/stats',
    wrap(async (req,) => {
      const merchant = await platform.store.users.findOne({ store_id: req.params.store_id, },);
      if (!merchant) throw new Error('Merchant not found',);
      return platform.referralService.getStats(merchant._id,);
    },),
  );

  // Validate referral code (used during signup)
  router.post(
    '/referral/validate',
    wrap(async (req,) => {
      const { code, merchant_id, store_id, ip, } = req.body || {};
      if (!code || !merchant_id || !store_id) throw new Error('code, merchant_id, and store_id are required',);
      return platform.referralService.validateReferral(code, merchant_id, store_id, { ip, },);
    },),
  );

  // Apply referral discount
  router.post(
    '/referral/:store_id/apply',
    wrap(async (req,) => {
      const merchant = await platform.store.users.findOne({ store_id: req.params.store_id, },);
      if (!merchant) throw new Error('Merchant not found',);
      return platform.referralService.applyReferralDiscount(merchant._id,);
    },),
  );

  // Check referral eligibility
  router.get(
    '/referral/:store_id/eligibility',
    wrap(async (req,) => {
      const merchant = await platform.store.users.findOne({ store_id: req.params.store_id, },);
      if (!merchant) throw new Error('Merchant not found',);
      return platform.referralService.checkEligibility(merchant._id,);
    },),
  );

  // List all referrals (admin)
  router.get(
    '/admin/referrals',
    wrap(async (req,) => platform.referralService.listAll(Number(req.query.limit,) || 100,),),
  );

  // ── Trial Management ────────────────────────────────────────────

  // Start trial
  router.post(
    '/trial/:store_id/start',
    wrap(async (req,) => {
      const { plan, } = req.body || {};
      return platform.trialService.startTrial(req.params.store_id, req.params.store_id, plan || 'growth',);
    },),
  );

  // Get trial status
  router.get(
    '/trial/:store_id/status',
    wrap(async (req,) => platform.trialService.getTrialStatus(req.params.store_id,),),
  );

  // Check feature access during trial
  router.get(
    '/trial/:store_id/feature/:feature',
    wrap(async (req,) => platform.trialService.canAccessFeature(req.params.store_id, req.params.feature,),),
  );

  // Convert trial to paid
  router.post(
    '/trial/:store_id/convert',
    wrap(async (req,) => {
      const { subscription_id, } = req.body || {};
      return platform.trialService.convertTrial(req.params.store_id, subscription_id,);
    },),
  );

  // Cancel trial
  router.post(
    '/trial/:store_id/cancel',
    wrap(async (req,) => platform.trialService.cancelTrial(req.params.store_id,),),
  );

  // Get trial analytics (admin)
  router.get(
    '/admin/trial/analytics',
    wrap(async () => platform.trialService.getAnalytics(),),
  );

  // Get expiring trials (admin)
  router.get(
    '/admin/trial/expiring',
    wrap(async (req,) => platform.trialService.getExpiringTrials(Number(req.query.days,) || 3,),),
  );

  // ── Regional Pricing (PPP) ──────────────────────────────────────

  // Get regional price for a plan
  router.get(
    '/pricing/regional/:country',
    wrap(async (req,) => {
      const { plan, cycle, } = req.query;
      return platform.regionalPricing.getRegionalPrice(plan || 'growth', req.params.country, cycle || 'monthly',);
    },),
  );

  // Get all prices for a region
  router.get(
    '/pricing/all/:country',
    wrap(async (req,) => platform.regionalPricing.getAllPrices(req.params.country,),),
  );

  // Detect country from IP
  router.get(
    '/pricing/detect-country',
    wrap(async (req,) => {
      const ip = req.headers['x-forwarded-for'] || req.ip;
      return platform.regionalPricing.detectCountry(ip,);
    },),
  );

  // Validate regional pricing
  router.post(
    '/pricing/validate',
    wrap(async (req,) => {
      const { merchant_id, country, ip, billing_address, } = req.body || {};
      return platform.regionalPricing.validateRegionalPricing(merchant_id, country, ip, billing_address,);
    },),
  );

  // Get PPP stats (admin)
  router.get(
    '/admin/pricing/stats',
    wrap(async () => platform.regionalPricing.getStats(),),
  );

  // ── Monitoring & Health (Task 65) ───────────────────────────────────

  router.get(
    '/monitoring/health',
    wrap(async (req,) =>
      platform.monitoringService.getHealthSummary(Number(req.query.hours,) || 24,),
    ),
  );

  router.get(
    '/monitoring/events',
    wrap(async (req,) =>
      platform.monitoringService.getRecentEvents({
        type: req.query.type,
        shopInstallationId: req.query.shopInstallationId,
        severity: req.query.severity,
        limit: Number(req.query.limit,) || 50,
      },),
    ),
  );

  router.get(
    '/monitoring/counters',
    wrap(async () => platform.monitoringService.getCounters(),),
  );

  // ── Secret Rotation (Task 27) ───────────────────────────────────────

  router.get(
    '/secrets/:store_id',
    wrap(async (req,) => platform.secretRotation.listSecrets(req.params.store_id,),),
  );

  router.post(
    '/secrets/:store_id/rotate/shopify',
    wrap(async (req,) =>
      platform.secretRotation.rotateShopifyToken(req.params.store_id, req.body?.new_token || '', {
        rotated_by: req.authUser?.email || 'admin',
        reason: req.body?.reason || 'manual',
      },),
    ),
  );

  router.post(
    '/secrets/:store_id/rotate/api-key',
    wrap(async (req,) =>
      platform.secretRotation.rotateApiKey(req.params.store_id, {
        rotated_by: req.authUser?.email || 'admin',
        reason: req.body?.reason || 'manual',
      },),
    ),
  );

  router.get(
    '/secrets/expiring',
    wrap(async (req,) =>
      platform.secretRotation.getExpiringSecrets(Number(req.query.within_days,) || 14,),
    ),
  );

  // ── Demo data (powers the web app's instant-live experience) ──────────

  router.post(
    '/demo/seed',
    wrap(async (req,) => platform.demoSeed.seed(req.body?.store_id || platform.config.defaultStoreId,),),
  );

  // ── Task ob5: Admin store management ───────────────────────────────

  // List all connected stores with health status.
  router.get(
    '/admin/stores',
    wrap(async () => {
      const stores = await platform.integrations.listAllStores();
      return { stores, count: stores.length, };
    },),
  );

  // Trigger a manual re-sync for a specific store.
  router.post(
    '/admin/stores/:store_id/resync',
    wrap(async (req,) => {
      const result = await platform.integrations.resyncStore(req.params.store_id,);
      return { store_id: req.params.store_id, ...result, };
    },),
  );

  // Get onboarding state for a store.
  router.get(
    '/admin/stores/:store_id/onboarding',
    wrap(async (req,) => {
      const onboarding = await platform.integrations.getOnboardingState(req.params.store_id,);
      return { store_id: req.params.store_id, onboarding, };
    },),
  );

  // Update an onboarding step.
  router.post(
    '/admin/stores/:store_id/onboarding',
    wrap(async (req,) => {
      const { step, value, } = req.body || {};
      if (!step) throw new Error('step is required.',);
      const onboarding = await platform.integrations.updateOnboardingStep(req.params.store_id, step, value !== false,);
      return { store_id: req.params.store_id, onboarding, };
    },),
  );

  // ── Store Connections (how real shops plug in) ─────────────────────

  router.get(
    '/integrations/:store_id',
    wrap(async (req,) => platform.integrations.status(req.params.store_id,),),
  );

  router.get(
    '/integrations/:store_id/snippet',
    wrap(async (req,) => {
      // Prefer the tenant's write-only ingest key; fall back to the
      // presented API key (dev/demo flows).
      const owner = req.authUser?.email
        ? await platform.store.users.findOne({ email: req.authUser.email, },)
        : null;
      const ingest = owner?.ingest_key || req.get('X-API-Key',) || platform.config.apiKey;
      return {
        store_id: req.params.store_id,
        snippet: platform.integrations.generateSnippet(req.params.store_id, ingest,),
        webhook_url: platform.integrations.webhookUrl(req.params.store_id,),
        csv_format: {
          products: 'product_id,name,stock,lead_time_days,price',
          orders: 'customer_id,email,total,product_id,quantity,timestamp',
        },
      };
    },),
  );

  router.post(
    '/integrations/:store_id/csv',
    wrap(async (req,) =>
      platform.integrations.importCSV(req.params.store_id, req.body?.type, req.body?.csv,),
    ),
  );

  router.post(
    '/integrations/:store_id/shopify',
    wrap(async (req,) => platform.integrations.syncShopify(req.params.store_id, req.body || {},),),
  );

  router.post(
    '/integrations/:store_id/woocommerce',
    wrap(async (req,) => platform.integrations.syncWooCommerce(req.params.store_id, req.body || {},),),
  );

  // One-click connect for a signed-in tenant: returns the platform's
  // OAuth authorize URL; the callback syncs straight into this store.
  router.post(
    '/integrations/:store_id/connect/:platform/start',
    wrap(async (req,) => {
      if (!req.authUser?.email) throw new Error('Sign in with an account to use one-click connect.',);
      return platform.oauth.startLink(req.params.platform, req.authUser.email, req.body || {},);
    },),
  );

  // Custom stores: prove ownership first (challenge), then finalize after verify.
  router.post(
    '/integrations/:store_id/connect/custom',
    wrap(async (req,) => platform.oauth.startCustomLink(req.body || {},),),
  );
  router.post(
    '/integrations/:store_id/connect/custom/finalize',
    wrap(async (req,) => platform.oauth.completeCustomLink(req.params.store_id, req.body || {},),),
  );

  // Platform connector credentials (Shopify/BigCommerce app client ids).
  router.get('/connectors', wrap(async () => platform.oauth.status(),),);

  router.put(
    '/connectors/:platform',
    platform.rbac.middleware('administer',),
    wrap(async (req,) => {
      await platform.oauth.setConfig(
        req.params.platform,
        req.body?.client_id,
        req.body?.client_secret,
      );
      await platform.auditLog.record(req.get('X-User',) || req.authUser?.email || 'admin', 'connector_configured', {
        platform: req.params.platform,
      },);
      return { ok: true, platform: req.params.platform, };
    },),
  );

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
      const subs = await platform.store.subscriptions.find({},);
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

      const existing = await store.customers?.findOne({ store_id, },);
      if (existing) {
        await store.customers.update(existing._id, {
          brand_keywords: keywords.map((k,) => k.toLowerCase().trim(),),
          brand_keywords_updated_at: new Date().toISOString(),
        },);
      } else {
        await store.customers?.insert({
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
      const existing = await store.customers?.findOne({ store_id, },);
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
      return {
        invoices: [
          { id: 'inv_001', date: '2026-08-01', amount: 49, status: 'paid', plan: 'Growth', },
          { id: 'inv_002', date: '2026-07-01', amount: 49, status: 'paid', plan: 'Growth', },
          { id: 'inv_003', date: '2026-06-01', amount: 49, status: 'paid', plan: 'Growth', },
          { id: 'inv_004', date: '2026-05-01', amount: 29, status: 'paid', plan: 'Starter', },
          { id: 'inv_005', date: '2026-04-01', amount: 29, status: 'paid', plan: 'Starter', },
        ],
      };
    },),
  );

  router.post(
    '/billing/:store_id/upgrade',
    wrap(async (req,) => {
      const { plan, } = req.body;
      return { success: true, message: `Upgraded to ${plan} plan`, plan, };
    },),
  );

  router.post(
    '/billing/:store_id/cancel',
    wrap(async (req,) => {
      return { success: true, message: 'Subscription cancelled', };
    },),
  );

  router.get(
    '/billing/:store_id/usage',
    wrap(async (req,) => {
      return {
        currentPeriod: { start: '2026-08-01', end: '2026-08-31', },
        apiCalls: { used: 1247, limit: 10000, },
        emails: { sent: 3456, limit: 10000, },
        storage: { used: 0.5, limit: 5, unit: 'GB', },
        competitors: { tracked: 3, limit: 5, },
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
      return {
        history: [
          { date: '2026-08-28', competitor: 'Competitor A', product: 'Widget Pro', oldPrice: 49.99, newPrice: 44.99, change: -10, },
          { date: '2026-08-25', competitor: 'Competitor B', product: 'Gadget X', oldPrice: 29.99, newPrice: 34.99, change: 16.7, },
          { date: '2026-08-20', competitor: 'Competitor A', product: 'Bundle Pack', oldPrice: 89.99, newPrice: 79.99, change: -11.1, },
          { date: '2026-08-15', competitor: 'Competitor C', product: 'Widget Pro', oldPrice: 52.99, newPrice: 47.99, change: -9.4, },
          { date: '2026-08-10', competitor: 'Competitor B', product: 'Premium Set', oldPrice: 129.99, newPrice: 119.99, change: -7.7, },
        ],
      };
    },),
  );

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
      if (min_risk_score) filters.min_risk_score = Number(min_risk_score);
      if (page) filters.page = Number(page);
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
      const days = Number(req.query.days) || 30;
      return await platform.returnAnalytics.getReturnReasonAnalysis(req.params.store_id, days,);
    },),
  );

  router.get(
    '/returns/:store_id/analytics/top-skus',
    wrap(async (req,) => {
      const limit = Number(req.query.limit) || 10;
      return await platform.returnAnalytics.getTopReturnedSKUs(req.params.store_id, limit,);
    },),
  );

  router.get(
    '/returns/:store_id/analytics/cost',
    wrap(async (req,) => {
      const days = Number(req.query.days) || 30;
      return await platform.returnAnalytics.getReturnCostAnalysis(req.params.store_id, days,);
    },),
  );

  router.get(
    '/returns/:store_id/analytics/trend',
    wrap(async (req,) => {
      const days = Number(req.query.days) || 90;
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
      const days = Number(req.query.days) || 30;
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
    wrap(async (req,) => {
      const stores = await platform.store.returns.find({},);
      const byStore = {};
      for (const r of stores) {
        if (!byStore[r.store_id]) byStore[r.store_id] = { total: 0, flagged: 0, value: 0, };
        byStore[r.store_id].total++;
        if (r.risk_score > 50) byStore[r.store_id].flagged++;
        byStore[r.store_id].value += r.return_value || 0;
      }
      return { store_count: Object.keys(byStore).length, by_store: byStore, total_returns: stores.length, };
    },),
  );

  router.get(
    '/admin/return-fraud/model-performance',
    wrap(async (req,) => {
      const allReturns = await platform.store.returns.find({},);
      const total = allReturns.length;
      const flagged = allReturns.filter((r,) => r.risk_score > 50,).length;
      const approved = allReturns.filter((r,) => r.status === 'approved',).length;
      const denied = allReturns.filter((r,) => r.status === 'denied',).length;
      const avgScore = total > 0 ? allReturns.reduce((sum, r,) => sum + (r.risk_score || 0), 0) / total : 0;
      return {
        total_returns: total,
        flagged_returns: flagged,
        auto_approved: approved,
        auto_denied: denied,
        avg_risk_score: Math.round(avgScore * 10) / 10,
        accuracy_estimate: total > 0 ? Math.round((flagged / total) * 100) : 0,
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

  return router;
}

module.exports = { createApiRouter, };
