'use strict';

/**
 * Layer 2 — intelligence, live orders, SEO, defection.
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, defaultStore, } = ctx;

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

}

module.exports = { register, };
