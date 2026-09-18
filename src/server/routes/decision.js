'use strict';

/**
 * Layer 3 — orchestrator, segmentation, campaigns.
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, defaultStore, } = ctx;

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
      const products = await platform.store.events.find({ store_id, type: 'product', },) || [];
      const recommendations = [];

      for (const product of products.slice(0, 20,)) {
        try {
          const rec = await platform.dynamicPricing.recommend({
            store_id,
            product_id: product.product_id || product.id,
            current_price: product.price || product.current_price,
          },);
          recommendations.push(rec,);
        } catch {
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

}

module.exports = { register, };
