'use strict';

/**
 * Route context — the shared helpers every domain module receives.
 *
 * Extracted from apiRoutes.js (F4). `wrap` was module-level there; the rest
 * closed over `platform`. Passing one context object keeps every module's
 * signature identical and makes the dependency explicit instead of ambient.
 */

/**
 * Wrap an async route handler.
 *
 * Express 4 does not catch a rejected async handler — `Layer.handle_request`
 * only wraps the synchronous call — so an unguarded rejection leaves the
 * request unanswered AND raises an unhandled rejection, which terminates the
 * process by default. Every API route goes through this.
 */
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
 * Build the context handed to every domain module.
 *
 * `defaultStore` resolves the store a request acts on. Tenants are pinned to
 * their own store, so a request that names no store (or names someone else's)
 * can never fall through to the platform default — which previously exposed
 * demo/other tenants' data. Platform operators stay unscoped so the console
 * can span tenants.
 */
function createRouteContext(platform,) {
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

  const isOperator = (req,) => req.authUser?.platform_admin === true;

  return { platform, wrap, defaultStore, paginate, isOperator, };
}

module.exports = { wrap, createRouteContext, };