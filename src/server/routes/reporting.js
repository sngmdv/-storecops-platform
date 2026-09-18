'use strict';

/**
 * Layer 5 — reporting, attribution, competitor tracking.
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, } = ctx;

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
    wrap(async () => platform.metaAdLibrary.scrapeAllCompetitors(platform.store,),),
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

}

module.exports = { register, };
