'use strict';

/**
 * Admin UI extensions (shop-scoped and addressed).
 *
 * Extracted from apiRoutes.js (F4): that file had grown to 3,065 lines and
 * 289 routes, which is where the next unguarded-handler defect hides. Routes
 * here register onto the SAME router in the SAME order as before — the tenant
 * gates live in apiRoutes.js and run first, so behaviour is unchanged.
 */

const { wrap, } = require('./shared',);

function register(router, ctx,) {
  const { platform, } = ctx;

  // ── Admin UI Extensions ─────────────────────────────────────────────
  //
  // Consumed by the in-admin blocks and actions under
  // shopify-app/extensions/storecops-admin.
  //
  // Two families of routes exist:
  //
  //   /ext/shop/...          resolves the tenant from the App Bridge
  //                          session token. This is what the extensions
  //                          actually call, because an embedded
  //                          extension has no idea what our internal
  //                          store_id is.
  //   /ext/.../:store_id/... the same payloads, addressed explicitly.
  //                          Kept for API-key clients and tests; the
  //                          :store_id guard pins them to the caller.
  //
  // Both families share the payload builders below so they cannot drift.

  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Whole days between an ISO timestamp and now, or null. */
  const daysSince = (iso,) => {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso,).getTime();
    return Number.isFinite(ms,) ? Math.max(0, Math.floor(ms / DAY_MS,),) : null;
  };

  /**
   * Shopify hands extensions GIDs (`gid://shopify/Customer/123`) while
   * our profiles are keyed by the bare numeric id. Normalize either form
   * (or a plain email) to a lookup key.
   */
  const normalizeCustomerRef = (value,) => {
    const raw = String(value || '',).trim();
    const gid = raw.match(/^gid:\/\/shopify\/[a-z]+\/(\d+)$/i,);
    return gid ? gid[1] : raw;
  };

  /** Look a customer profile up by GID, bare id, or email. */
  async function findCustomer(store_id, ref,) {
    const key = normalizeCustomerRef(ref,);
    if (!key) return null;
    const byIdentity = await platform.store.customers.findOne({ store_id, identity: key, },);
    if (byIdentity) return byIdentity;
    // GIDs and emails both fall back to an email match.
    return platform.store.customers.findOne({ store_id, email: key, },);
  }

  /** Customer insight payload — shared by both route families. */
  async function customerInsights(store_id, ref,) {
    const profile = await findCustomer(store_id, ref,);
    const churn = profile
      ? await platform.churnScoring.scoreCustomer(store_id, profile.identity,)
      : null;

    if (!profile && !churn) {
      return { found: false, customer_id: normalizeCustomerRef(ref,), };
    }

    const days = daysSince(profile?.last_purchase_at,);
    const churnScore = churn?.churn_score ?? 0;
    const hasChannel = Boolean(profile?.email || profile?.phone,);

    // Only nudge a customer we can actually reach, and only when the
    // engine genuinely sees risk — otherwise the button is noise.
    const winbackEligible = Boolean(
      hasChannel && churnScore >= 25 && (days === null || days >= 14),
    );

    return {
      found: true,
      customer_id: profile?.identity || normalizeCustomerRef(ref,),
      store_id,
      churn_score: churnScore,
      risk_band: churn?.risk_band || 'LOW',
      factors: churn?.factors || [],
      revenue_at_risk: profile?.total_spent || 0,
      lifetime_value: profile?.total_spent || 0,
      purchases: profile?.purchases || 0,
      abandoned_carts: profile?.abandoned_carts || 0,
      last_purchase_at: profile?.last_purchase_at || null,
      days_since_purchase: days,
      has_email: Boolean(profile?.email,),
      has_phone: Boolean(profile?.phone,),
      winback_eligible: winbackEligible,
      scored_at: churn?.scored_at || null,
    };
  }

  /** Product insight payload — shared by both route families. */
  async function productInsights(store_id, product_id, windowDays = 30,) {
    const [stock, velocityMap, snapshots,] = await Promise.all([
      platform.inventoryLedger.get(store_id, product_id,),
      platform.inventoryIntelligence.velocity(store_id, windowDays,),
      platform.store.competitorSnapshots.find({ store_id, },),
    ],);

    const velocity = velocityMap?.[product_id] || { units_sold: 0, orders: 0, units_per_day: 0, };
    const perDay = Number(velocity.units_per_day,) || 0;
    const stockOnHand = Number(stock?.stock,) || 0;
    const leadTime = Number(stock?.lead_time_days,) || 7;

    const daysUntilStockout = perDay > 0 ? Math.floor(stockOnHand / perDay,) : null;
    const reorderPoint = perDay * leadTime * 1.5;
    const suggestedReorder = perDay > 0 && stockOnHand <= reorderPoint
      ? Math.max(0, Math.ceil(perDay * leadTime * 2 - stockOnHand,),)
      : 0;

    let status = 'HEALTHY';
    if (stockOnHand <= 0) status = 'STOCKOUT';
    else if (daysUntilStockout !== null && daysUntilStockout <= leadTime) status = 'STOCKOUT_RISK';
    else if (suggestedReorder > 0) status = 'REORDER_SOON';

    // Cheapest competitor price for this product, if we track any.
    let competitorPrice = null;
    let competitorName = null;
    for (const snapshot of snapshots) {
      for (const item of snapshot.products || []) {
        if (String(item.product_id,) !== String(product_id,)) continue;
        const price = Number(item.price,);
        if (!Number.isFinite(price,)) continue;
        if (competitorPrice === null || price < competitorPrice) {
          competitorPrice = price;
          competitorName = snapshot.competitor || snapshot.competitor_name || null;
        }
      }
    }

    return {
      found: Boolean(stock,) || perDay > 0,
      product_id,
      store_id,
      window_days: windowDays,
      name: stock?.name || null,
      units_sold: velocity.units_sold || 0,
      orders: velocity.orders || 0,
      units_per_day: perDay,
      stock_on_hand: stockOnHand,
      lead_time_days: leadTime,
      days_until_stockout: daysUntilStockout,
      reorder_point: Math.ceil(reorderPoint,),
      suggested_reorder_qty: suggestedReorder,
      status,
      competitor_price: competitorPrice,
      competitor_name: competitorName,
      has_competitor_data: competitorPrice !== null,
    };
  }

  /** Queue and deliver a win-back message to one customer. */
  async function sendWinback(store_id, ref, options = {},) {
    const { channel = 'email', message, offer, dryRun = false, } = options;

    const profile = await findCustomer(store_id, ref,);
    if (!profile) throw new Error('Customer not found.',);

    if (channel === 'email' && !profile.email) throw new Error('Customer has no email address.',);
    if (channel === 'whatsapp' && !profile.phone) throw new Error('Customer has no phone number.',);

    const churn = await platform.churnScoring.scoreCustomer(store_id, profile.identity,);

    // Don't spam: skip if we already sent a win-back in the last 24h.
    const cutoff = new Date(Date.now() - DAY_MS,).toISOString();
    const recent = await platform.store.actions.find(
      (a,) =>
        a.store_id === store_id &&
        a.customer_id === profile.identity &&
        a.type === 'winback_offer' &&
        a.created_at >= cutoff,
    );
    if (recent.length > 0 && !dryRun) {
      return {
        ok: false,
        skipped: true,
        reason: 'A win-back was already sent to this customer in the last 24 hours.',
      };
    }

    const action = {
      store_id,
      customer_id: profile.identity,
      rule_id: 'ext_winback',
      rule_name: 'Win-back (sent from Shopify admin)',
      type: 'winback_offer',
      channel,
      urgency: 'high',
      params: { offer: offer || 'we saved your cart', ...(message ? { message, } : {}), },
      context: { churn_score: churn?.churn_score ?? null, source: 'admin_extension', },
      source: 'admin_extension',
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    if (dryRun) return { ok: true, dry_run: true, would_send: action, };

    const saved = await platform.store.actions.insert(action,);

    // executeAction resolves to the updated action record, whose
    // `status` becomes 'delivered' on success (or 'blocked'/'failed').
    let outcome;
    try {
      outcome = await platform.executionService.executeAction(saved,);
    } catch (error) {
      outcome = { status: 'failed', error: error.message, };
    }

    return {
      ok: outcome?.status === 'delivered',
      action_id: saved._id,
      channel,
      customer_id: profile.identity,
      churn_score: churn?.churn_score ?? null,
      status: outcome?.status || 'unknown',
      delivery: {
        status: outcome?.status || 'unknown',
        channel: outcome?.channel || channel,
        error: outcome?.error || null,
      },
    };
  }

  /** Export a store's customer list as JSON or CSV. */
  async function exportCustomers(store_id, options = {},) {
    const { format: outputFormat = 'json', minChurn, limit, } = options;

    const profiles = await platform.store.customers.find({ store_id, },);
    let rows = profiles
      .filter((p,) => !p.merged_into,)
      .map((p,) => ({
        customer_id: p.identity,
        email: p.email || '',
        phone: p.phone || '',
        purchases: p.purchases || 0,
        abandoned_carts: p.abandoned_carts || 0,
        total_spent: p.total_spent || 0,
        last_purchase_at: p.last_purchase_at || '',
      }),);

    if (Number.isFinite(Number(minChurn,),)) {
      const scores = await platform.churnScoring.scoreStore(store_id,);
      const byId = new Map(scores.map((s,) => [s.customer_id, s.churn_score,],),);
      const floor = Number(minChurn,);
      rows = rows
        .map((r,) => ({ ...r, churn_score: byId.get(r.customer_id,) ?? 0, }),)
        .filter((r,) => r.churn_score >= floor,);
    }

    const capped = Number(limit,) > 0 ? rows.slice(0, Number(limit,),) : rows;

    if (outputFormat === 'csv') {
      const columns = ['customer_id', 'email', 'phone', 'purchases', 'abandoned_carts', 'total_spent', 'last_purchase_at', 'churn_score',];
      const escape = (value,) => `"${String(value ?? '',).replace(/"/g, '""',)}"`;
      const csv = [
        columns.join(',',),
        ...capped.map((row,) => columns.map((c,) => escape(row[c],),).join(',',),),
      ].join('\n',);
      return {
        ok: true,
        format: 'csv',
        count: capped.length,
        filename: `storecops-customers-${store_id}.csv`,
        content: csv,
      };
    }

    return {
      ok: true,
      format: 'json',
      count: capped.length,
      filename: `storecops-customers-${store_id}.json`,
      customers: capped,
    };
  }

  /** Shop-scoped guard: a session token must have resolved a tenant. */
  const requireShop = (req, res, next,) => {
    if (!req.authUser?.store_id) {
      return res.status(403,).json({ error: 'No shop is bound to this session.', },);
    }
    return next();
  };

  // ── Shop-scoped routes (used by the Admin UI Extensions) ────────────

  /** Which store is this embedded session acting for? */
  router.get(
    '/ext/shop/me',
    requireShop,
    wrap(async (req,) => ({
      store_id: req.authUser.store_id,
      shop_domain: req.authUser.shop_domain || null,
      authenticated_via: req.authUser.via_session_token ? 'session_token' : 'api_key',
    }),),
  );

  router.get(
    '/ext/shop/customer/:customer_ref/insights',
    requireShop,
    wrap(async (req,) => customerInsights(req.authUser.store_id, req.params.customer_ref,),),
  );

  router.get(
    '/ext/shop/product/:product_id/insights',
    requireShop,
    wrap(async (req,) => {
      const windowDays = Math.min(Number(req.query.window_days,) || 30, 365,);
      return productInsights(req.authUser.store_id, req.params.product_id, windowDays,);
    },),
  );

  router.post(
    '/ext/shop/customer/:customer_ref/winback',
    requireShop,
    wrap(async (req,) => {
      const body = req.body || {};
      return sendWinback(req.authUser.store_id, req.params.customer_ref, {
        channel: body.channel,
        message: body.message,
        offer: body.offer,
        dryRun: body.dry_run,
      },);
    },),
  );

  router.post(
    '/ext/shop/customers/export',
    requireShop,
    wrap(async (req,) => {
      const body = req.body || {};
      return exportCustomers(req.authUser.store_id, {
        format: body.format,
        minChurn: body.min_churn_score,
        limit: body.limit,
      },);
    },),
  );

  // ── Explicitly-addressed routes (API-key clients and tests) ─────────

  router.get(
    '/ext/customer/:store_id/:customer_id/insights',
    wrap(async (req,) => customerInsights(req.params.store_id, req.params.customer_id,),),
  );

  router.get(
    '/ext/product/:store_id/:product_id/insights',
    wrap(async (req,) => {
      const windowDays = Math.min(Number(req.query.window_days,) || 30, 365,);
      return productInsights(req.params.store_id, req.params.product_id, windowDays,);
    },),
  );

  router.post(
    '/ext/customer/:store_id/:customer_id/winback',
    wrap(async (req,) => {
      const body = req.body || {};
      return sendWinback(req.params.store_id, req.params.customer_id, {
        channel: body.channel,
        message: body.message,
        offer: body.offer,
        dryRun: body.dry_run,
      },);
    },),
  );

  router.post(
    '/ext/customers/:store_id/export',
    wrap(async (req,) => {
      const body = req.body || {};
      return exportCustomers(req.params.store_id, {
        format: body.format,
        minChurn: body.min_churn_score,
        limit: body.limit,
      },);
    },),
  );
}

module.exports = { register, };
