'use strict';

/**
 * Layer 1 — tracking ingest, customers, events.
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, paginate, } = ctx;

  // ── Layer 1: Data Foundation ────────────────────────────────────────

  router.post(
    '/track',
    // Authenticated by the WRITE-ONLY INGEST KEY, not by an HMAC. This is the
    // endpoint the storefront snippet calls — via `navigator.sendBeacon`, from
    // a browser, on page unload. A browser has no access to `WEBHOOK_SECRET`
    // and cannot compute a signature, so requiring one here would have blocked
    // every real tracking request.
    //
    // There was previously a `webhookVerifier` on this route. It failed open
    // when `WEBHOOK_SECRET` was unset, which is why the test suite never
    // noticed; with the secret configured (as it is in production) it would
    // have 401'd the entire tracker. `webhookVerifier` is the right tool for a
    // server-to-server webhook, not for a browser ingest endpoint.
    //
    // What actually constrains this route: the ingest key is write-only
    // (`ingestOnly`), restricted to `/track` and `/track/batch` by the RBAC
    // gate above, and every request passes the rate limiters.
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
    // Same authentication as /track — ingest key, no HMAC (see above).
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

}

module.exports = { register, };
