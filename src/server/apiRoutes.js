'use strict';

/**
 * API v1 routes — composition root.
 *
 * F4: this file was 3,065 lines carrying 289 routes, which is exactly where
 * the next unguarded-handler defect hides (items 41/42 were both found here).
 * The route bodies now live in src/server/routes/<domain>.js, one module per
 * contiguous section of the original file. Each module registers onto the SAME
 * router in the SAME order — the only thing that changed is where the code
 * lives, so middleware order, route order and match precedence are unchanged.
 *
 * What stays here, and why:
 *   - the tenant-isolation gates. router.param('store_id', ...) and the two
 *     router.use gates are registered before ANY route, on this router, so
 *     they run for every module's routes exactly as they always did;
 *   - the route context (routes/shared.js) — wrap/defaultStore/paginate;
 *   - the registration order, which is the original file order top to bottom.
 */

const express = require('express',);
const { createRouteContext, } = require('./routes/shared',);

const track = require('./routes/track',);
const intelligence = require('./routes/intelligence',);
const decision = require('./routes/decision',);
const execution = require('./routes/execution',);
const reporting = require('./routes/reporting',);
const admin = require('./routes/admin',);
const billing = require('./routes/billing',);
const adminIntel = require('./routes/adminIntel',);
const account = require('./routes/account',);
const settings = require('./routes/settings',);
const returns = require('./routes/returns',);
const ext = require('./routes/ext',);

function createApiRouter(platform,) {
  const router = express.Router();
  const ctx = createRouteContext(platform,);
  const { isOperator, } = ctx;
  // ── Tenant isolation ────────────────────────────────────────────────
  // A tenant may only ever touch its own store; platform operators
  // (master key, or users listed in PLATFORM_ADMIN_EMAILS) are unscoped
  // by design and are the only identities that reach /admin/*.


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
    // Both ingest paths verify the webhook HMAC themselves, so they skip the
    // user-RBAC gate. /track/batch was previously exempt from the bypass but
    // *not* from the signature check, so it fell through to RBAC and, on a
    // fresh install with zero users, ran wide open.
    if (
      req.path === '/track' ||
      req.path.startsWith('/track/batch',) ||
      req.path.startsWith('/live/',)
    ) {
      return next();
    }
    const permission = req.method === 'GET' ? 'read' : 'mutate';
    return platform.rbac.middleware(permission,)(req, res, next,);
  },);

  // ── Domain modules, in the original file order ──────────────────────
  track.register(router, ctx,);
  intelligence.register(router, ctx,);
  decision.register(router, ctx,);
  execution.register(router, ctx,);
  reporting.register(router, ctx,);
  admin.register(router, ctx,);
  billing.register(router, ctx,);
  adminIntel.register(router, ctx,);
  account.register(router, ctx,);
  settings.register(router, ctx,);
  returns.register(router, ctx,);
  ext.register(router, ctx,);

  return router;
}

module.exports = { createApiRouter, };
