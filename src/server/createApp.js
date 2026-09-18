'use strict';

/**
 * App factory: builds the Express app around a platform instance.
 * Kept separate from server.js so tests can create an app without
 * binding a port.
 */

const express = require('express',);
const path = require('path',);
const { createApiRouter, } = require('./apiRoutes',);
const {
  createRateLimiter,
  shopifyWebhookVerifier,
  deleteCustomerData,
} = require('./security',);
const { verifyWebhookSignature, parseStatusUpdates, parseIncomingMessages, } = require('../layers/execution/whatsappService',);
const {
  securityHeaders,
  sanitizeInput,
  securityLogger,
  preventSqlInjection,
  preventPathTraversal,
} = require('./securityHardening',);
const { createCorsMiddleware, } = require('./cors',);
const { createAppProxy, } = require('./appProxy',);
const { purgeStoreData, } = require('./privacy',);
const { createHealthProbe, } = require('./healthProbe',);
const webhookTenancy = require('./webhookTenancy',);

/**
 * Resolve a Shopify shop domain to the tenant that owns it.
 * @returns {Promise<{store_id: string, user: object}|null>}
 */
async function tenantForShop(platform, shopDomain,) {
  const integrations = await platform.store.integrations.find({ type: 'shopify', },);
  const match = integrations.find(
    (row,) => String(row.config?.shopDomain || '',).toLowerCase() === shopDomain,
  );
  if (!match?.store_id) return null;
  const users = await platform.store.users.find({ store_id: match.store_id, },);
  return { store_id: match.store_id, user: users[0] || null, };
}

/**
 * Resolve an App Bridge session token into a tenant identity.
 *
 * The returned identity is deliberately NOT a platform operator, so the
 * normal tenant-isolation guards in apiRoutes still apply: an in-admin
 * extension can only ever act on the store it was installed on.
 *
 * @returns {Promise<object|null>} authUser-shaped object, or null.
 */
async function resolveShopifySession(platform, token,) {
  const verified = await platform.sessionToken.verify(token,);
  if (!verified) return null;

  const tenant = await tenantForShop(platform, verified.shop_domain,);
  if (!tenant) return null;

  return {
    email: tenant.user?.email || `shop:${verified.shop_domain}`,
    role: tenant.user?.role || 'admin',
    store_id: tenant.store_id,
    shop_domain: verified.shop_domain,
    shopify_user_id: verified.user_id,
    platform_admin: false, // never an operator
    via_session_token: true,
  };
}

/**
 * API gateway auth. Accepts, in order:
 *   1. the master dev key (X-API-Key / ?api_key= for SSE),
 *   2. a tenant's private API key issued at signup,
 *   3. a bearer session token from login,
 *   4. a Shopify App Bridge session token (JWT) from embedded surfaces,
 *   5. the write-only public ingest key (tracking snippet) — this one
 *      is locked to /track by the router gate.
 */
function apiKeyMiddleware(platform,) {
  // Resolving an identity touches the session store, the tenant key tables and
  // Shopify token verification, so it can fail. This is the authentication gate
  // for all 280 API routes: if it rejects, Express 4 does not catch it — the
  // request goes unanswered and the process dies. Guard it so the gate answers
  // even when the thing it depends on does not.
  const resolveIdentity = async (req, res, next,) => {
    // Credentials normally travel in a header. The query-string path exists
    // only for the two callers that physically cannot set one:
    //   - EventSource (`/live/*`) has no header API.
    //   - `navigator.sendBeacon` (`/track`) has no header API either, and it is
    //     the path the storefront snippet uses to report a purchase on unload.
    // Everywhere else the key must be a header, so it cannot end up in access
    // logs, proxy logs, browser history or a `Referer`.
    const routePath = String(req.path || '',);
    const queryCredentialsAllowed =
      routePath.startsWith('/live/',) ||
      routePath === '/track' ||
      routePath.startsWith('/track/batch',);

    let provided = req.get('X-API-Key',);
    if (!provided && queryCredentialsAllowed) {
      provided = req.query?.api_key;
    }
    if (provided) {
      if (provided === platform.config.apiKey) {
        // Master key acts as a platform-wide operator identity.
        // No store_id: it is intentionally unscoped so operators can act
        // across tenants, and it is the only key that reaches /admin/*.
        req.authUser = {
          email: 'master@platform',
          role: 'admin',
          platform_admin: true,
          store_id: null,
        };
        return next();
      }
      const tenant = await platform.auth.userByApiKey(provided,);
      if (tenant) {
        req.authUser = tenant;
        return next();
      }
      const ingest = await platform.auth.userByIngestKey(provided,);
      if (ingest) {
        req.authUser = ingest;
        req.ingestOnly = true; // restricted to event ingestion
        return next();
      }
    }

    // SSE also accepts the session token in the query — preferred over the API
    // key because it is short-lived and revocable.
    if (queryCredentialsAllowed && req.query?.token) {
      const session = await platform.auth.verify(String(req.query.token,),);
      if (session) {
        req.authUser = session.user;
        return next();
      }
    }

    const bearer = (req.get('Authorization',) || '').replace(/^Bearer\s+/i, '',);
    if (bearer) {
      // A Shopify App Bridge session token is a JWT — three segments.
      // Try it before the opaque app session token; if it fails
      // verification we fall through and ultimately 401, so a bad
      // token is never trusted.
      if (platform.sessionToken && bearer.split('.',).length === 3) {
        const shopifyUser = await resolveShopifySession(platform, bearer,);
        if (shopifyUser) {
          req.authUser = shopifyUser;
          return next();
        }
      }
      const session = await platform.auth.verify(bearer,);
      if (session) {
        req.authUser = session.user;
        return next();
      }
    }

    // Test mode accepts unauthenticated requests, but credentials
    // presented above are always resolved (RBAC needs the identity).
    if (platform.config.env === 'test') return next();

    return res.status(401,).json({ error: 'Invalid or missing credentials (API key or bearer token).', },);
  };

  return async (req, res, next,) => {
    try {
      return await resolveIdentity(req, res, next,);
    } catch (error) {
      console.error('[AUTH] credential resolution failed:', error.message,);
      // Fail **closed** — an unverifiable credential is not a credential. 503
      // rather than 401 so a correctly-authenticated client is not told to
      // discard a good token. `next()` may already have handed off, so never
      // write a second response.
      if (!res.headersSent) {
        return res.status(503,).json({ error: 'Could not verify credentials.', },);
      }
      return undefined;
    }
  };
}

/** Public auth endpoints — no key required, rate-limited. */
function createAuthRouter(platform,) {
  const router = express.Router();

  router.post('/signup', async (req, res, next,) => {
    try {
      const result = await platform.auth.signup(req.body || {},);

      // Task ob10: Send welcome email (best effort, never block signup).
      if (platform.emailService) {
        platform.emailService.sendWelcome({
          email: result.user?.email,
          name: result.user?.name,
          storeName: result.user?.store_name,
          storeId: result.store_id,
        },).catch((e,) => console.error('[EMAIL] welcome failed:', e.message,),);
      }

      // One-click connect: an authorized store was parked before signup;
      // now that the tenant exists, sync its real data.
      let connected = null;
      if (req.body?.connect_token) {
        try {
          const pendingRow = await platform.oauth.consumePending(req.body.connect_token,);
          connected = await platform.oauth.finalize(result.store_id, pendingRow,);

          // Task ob3: Post-OAuth billing charge for Shopify stores.
          // After data sync, create a charge and include the confirmation_url
          // so the frontend can redirect the merchant to approve payment.
          if (pendingRow.platform === 'shopify' && connected && pendingRow.access_token) {
            try {
              const planId = req.body?.plan_id || 'growth';
              if (planId !== 'starter') {
                const charge = await platform.billingService.createShopifyCharge(
                  pendingRow.domain,
                  pendingRow.access_token,
                  planId,
                  {
                    shopInstallationId: result.store_id,
                    return_url: `${platform.config.publicUrl || 'http://localhost:' + platform.config.port}/app#/dashboard`,
                    test: platform.config.env !== 'production',
                  },
                );
                connected.charge = charge;
              }
            } catch (chargeErr) {
              connected.charge_error = chargeErr.message; // non-fatal
            }
          }
        } catch (error) {
          connected = { error: error.message, }; // account created; connect retriable
        }
      }
      res.status(201,).json({ ...result, connected, },);
    } catch (error) {
      next(error,);
    }
  },);

  router.post('/login', async (req, res, next,) => {
    try {
      const result = await platform.auth.login(req.body || {},);
      res.json(result,);
    } catch (error) {
      // Uniform 401 for bad credentials (signup validation stays 400).
      res.status(401,).json({ error: error.message, },);
    }
  },);

  router.post('/logout', async (req, res,) => {
    // Express 4 cannot catch a rejected async handler, so an unguarded body here
    // would leave the request unanswered and terminate the process.
    try {
      const bearer = (req.get('Authorization',) || '').replace(/^Bearer\s+/i, '',);
      await platform.auth.logout(bearer,);
      res.json({ ok: true, },);
    } catch (error) {
      console.error('[AUTH] logout failed:', error.message,);
      res.status(500,).json({ error: 'Could not complete sign-out.', },);
    }
  },);

  /**
   * Begin a password reset.
   *
   * Always answers 200 with the same message. A different status or body for a
   * known vs unknown address would make this unauthenticated endpoint an
   * account enumeration oracle. The raw token is used to build the email link
   * and never appears in the response.
   */
  router.post('/forgot-password', async (req, res,) => {
    const generic = {
      ok: true,
      message: 'If an account exists for that address, a reset link has been sent.',
    };
    try {
      const result = await platform.auth.requestPasswordReset({ email: req.body?.email, },);

      if (result.token && result.user) {
        const resetUrl = `${platform.config.publicUrl}/app?reset_token=${encodeURIComponent(result.token,)}`;
        try {
          const html = platform.emailTemplates.passwordReset({
            name: result.user.name,
            resetUrl,
            expiresIn: '30 minutes',
          },);
          await platform.emailService.send({
            to: result.user.email,
            subject: 'Reset your Storecops password',
            html,
          },);
        } catch (error) {
          // A delivery failure must not change the response shape, or the
          // difference between "sent" and "could not send" leaks existence.
          console.error(`[AUTH] password reset email failed: ${error.message}`,);
        }
      }

      return res.json(generic,);
    } catch (error) {
      console.error(`[AUTH] forgot-password failed: ${error.message}`,);
      return res.json(generic,);
    }
  },);

  /**
   * Redeem a reset token and set a new password.
   *
   * Single use, and every existing session for the account is revoked on
   * success — a reset is the recovery path for a compromised account.
   */
  router.post('/reset-password', async (req, res,) => {
    try {
      const result = await platform.auth.resetPassword({
        token: req.body?.token,
        password: req.body?.password,
      },);
      return res.json(result,);
    } catch (error) {
      // 400 for a bad/expired token or a weak password. The message is
      // deliberately identical for missing, used and expired tokens.
      return res.status(400,).json({ error: error.message, },);
    }
  },);

  router.get('/me', async (req, res,) => {
    // Guarded for the same reason as /logout. A storage blip must not log the
    // user out: `verify` returning falsy is the 401 path, and anything thrown is
    // a server fault, so it answers 503 rather than pretending the token is bad.
    try {
      const bearer = (req.get('Authorization',) || '').replace(/^Bearer\s+/i, '',);
      const session = await platform.auth.verify(bearer,);
      if (!session) return res.status(401,).json({ error: 'Not authenticated.', },);
      return res.json({ user: session.user, store_id: session.store_id, },);
    } catch (error) {
      console.error('[AUTH] session lookup failed:', error.message,);
      return res.status(503,).json({ error: 'Could not verify the session.', },);
    }
  },);

  /**
   * Shopify embedded app auth endpoint.
   * Called by the frontend when running inside Shopify Admin (embedded mode).
   *
   * The caller must present a Shopify App Bridge session token. The tenant is
   * resolved from the **verified** token's shop domain — never from the request
   * body, which is entirely caller-controlled.
   *
   * SECURITY (fixed 2026-09-18). This handler used to read `shop` from the
   * body, match it against an unscoped `findOne({ type: 'shopify' })`, and mint
   * a full session for whichever tenant owned that domain — while reading
   * `sessionToken` from the body and never using it, despite the docblock
   * claiming the session was verified. Because the SPA's embedded mode is
   * triggered by URL parameters (`?embedded=1&shop=…`), a caller needed only
   * the merchant's public `.myshopify.com` domain to obtain an authenticated
   * session for that merchant's store. Verified by reproduction: a
   * credential-free POST returned a 7-day session that then read the victim's
   * `/auth/me` and `/report/:store_id`.
   */
  router.post('/shopify', async (req, res,) => {
    try {
      // App Bridge clients send the token in the body; extension-style callers
      // send it as a bearer. Both are verified identically.
      const bearer = String(req.get('Authorization',) || '',).replace(/^Bearer\s+/i, '',);
      const token = req.body?.sessionToken || bearer;

      // Verify the token directly rather than via `resolveShopifySession`:
      // that helper also resolves the tenant, so it returns null both for a bad
      // token AND for a good token whose shop has not signed up yet — which
      // would make the `requires_signup` branch below unreachable.
      const verified = await platform.sessionToken.verify(token,);
      if (!verified) {
        return res.status(401,).json({ error: 'Invalid or missing Shopify session token.', },);
      }

      // The verified domain is the only tenant selector we honour. The body's
      // `shop` is ignored entirely — it is caller-controlled.
      const tenant = await tenantForShop(platform, verified.shop_domain,);
      if (!tenant?.user) {
        // A genuine token, but no tenant has claimed this shop yet. Issue a
        // pending session so the client can route to signup — it grants no
        // access, because `user_id` is null and `store_id` is unset.
        const tempSession = await platform.auth.createTempSession(verified.shop_domain,);
        return res.json({
          temp_session: tempSession,
          shop: verified.shop_domain,
          embedded: true,
          requires_signup: true,
        },);
      }

      // createSession resolves store_id from the user document, so the session
      // is automatically scoped to that tenant.
      const session = await platform.auth.createSession(tenant.user,);
      return res.json({
        session,
        store_id: tenant.store_id,
        shop: verified.shop_domain,
        embedded: true,
      },);
    } catch (error) {
      return res.status(400,).json({ error: error.message, },);
    }
  },);

  // Map service errors to sensible statuses for signup.
  router.use((error, req, res, next,) => {
    if (error?.type === 'entity.parse.failed') return res.status(400,).json({ error: 'Invalid JSON body.', },);
    return res.status(400,).json({ error: error.message || 'Auth error.', },);
  },);

  return router;
}

/**
 * Free public store audit — no signup, no API key. Anyone can run a
 * real audit of their store and download the report.
 */

function buildReportEmailHtml(report, email,) {
  const scoreColor = report.overall_score >= 70 ? '#38a169' : report.overall_score >= 50 ? '#d69e2e' : '#e53e3e';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a2e;">
<div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:30px;border-radius:12px 12px 0 0;text-align:center;">
<h1 style="color:white;margin:0;font-size:24px;">Your Store Health Report</h1>
<p style="color:#c4b5fd;margin:8px 0 0;">Storecops Growth Platform</p></div>
<div style="padding:30px;background:#f8f9fa;border-radius:0 0 12px 12px;">
<p style="font-size:16px;">We've analyzed <strong>${report.url}</strong>:</p>
<div style="text-align:center;margin:30px 0;">
<div style="font-size:48px;font-weight:bold;color:${scoreColor};">${report.overall_score}<span style="font-size:24px;">/100</span></div>
<div style="font-size:14px;color:#666;">Grade: <strong>${report.grade}</strong></div></div>
<p style="font-size:14px;"><strong>Your full report is attached as a PDF.</strong></p>
<div style="background:white;padding:20px;border-radius:8px;margin:20px 0;border-left:4px solid #667eea;">
<p style="font-size:14px;font-weight:bold;color:#667eea;margin:0 0 10px;">Ready to fix these issues automatically?</p>
<p style="font-size:13px;color:#666;margin:0;">Storecops implements all recommendations with one click.</p>
<p style="text-align:center;margin:15px 0 0;"><a href="#" style="background:#667eea;color:white;padding:10px 25px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Start Free Trial</a></p></div>
<hr style="border:none;border-top:1px solid #ddd;margin:20px 0;">
<p style="font-size:12px;color:#999;">Sent to ${email}. Storecops Growth Platform.</p></div></body></html>`;
}

function createAuditRouter(platform,) {
  const router = express.Router();

  router.post('/site', async (req, res,) => {
    try {
      const report = await platform.siteAudit.audit((req.body || {}).url,);
      res.status(201,).json(report,);
    } catch (error) {
      res.status(400,).json({ error: error.message, },);
    }
  },);

  router.get('/recent', async (req, res,) => {
    try {
      const reports = await platform.siteAudit.recent(10,);
      res.json(reports.map((r,) => ({
        report_id: r._id, url: r.url, score: r.score, grade: r.grade, audited_at: r.audited_at,
      }),),);
    } catch (error) {
      console.error('[SITE-AUDIT] recent reports failed:', error.message,);
      res.status(503,).json({ error: 'Could not load recent reports.', },);
    }
  },);

  router.get('/site/:report_id', async (req, res,) => {
    try {
      const report = await platform.siteAudit.get(req.params.report_id,);
      if (!report) return res.status(404,).json({ error: 'Report not found.', },);
      return res.json(report,);
    } catch (error) {
      console.error('[SITE-AUDIT] report lookup failed:', error.message,);
      return res.status(503,).json({ error: 'Could not load the report.', },);
    }
  },);

  // ── Public Lead Capture (landing page, audit page, newsletter) ────
  router.post('/leads', async (req, res,) => {
    try {
      const { email, name, storeUrl, source, metadata, } = req.body || {};
      if (!email) return res.status(400,).json({ error: 'email is required', },);
      const existingLeads = await platform.store.leads.find({},);
      const result = platform.adminIntelligence.captureLead({
        leads: existingLeads,
        input: { email, name, storeUrl, source: source || 'landing', metadata, },
      },);
      if (result.created && result.lead) {
        await platform.store.leads.insert(result.lead,);
      }
      return res.json({ ok: true, created: result.created, leadId: result.lead?.id, },);
    } catch (error) {
      return res.status(400,).json({ error: error.message, },);
    }
  },);

  // ── Deep Audit & PDF Reports (public entry, gated full report) ────

  // Run deep audit — public, returns summary only
  router.post('/deep', async (req, res,) => {
    try {
      const { url, email, name, phone, store_name, } = req.body || {};
      if (!url) return res.status(400,).json({ error: 'url is required.', },);
      const report = await platform.deepAudit.audit(url,);

      // Capture lead from audit (even without email, the store URL is valuable)
      try {
        await platform.revenueIntelligence.captureLead({
          store_url: url,
          email: email || null,
          name: name || null,
          phone: phone || null,
          store_name: store_name || null,
          source: 'deep_audit',
          audit_report_id: report._id || report.report_id,
        },);
      } catch (leadErr) {
        // Lead capture failure should not block audit delivery
        console.error('[LEAD] Capture failed:', leadErr.message,);
      }

      // Return summary only — full details require authentication
      return res.json({
        report_id: report.report_id,
        url: report.url,
        overall_score: report.overall_score,
        grade: report.grade,
        passed_checks: report.passed_checks,
        total_checks: report.total_checks,
        top_issues: report.top_issues.slice(0, 3,),
        categories: {
          seo: { score: report.categories.seo.score, },
          performance: { score: report.categories.performance.score, },
          security: { score: report.categories.security.score, },
          crawlability: { score: report.categories.crawlability.score, },
        },
        ai_readiness: { score: report.ai_readiness.score, },
        full_report_available: false,
        message: 'Sign up to unlock the full report with detailed findings, PDF download, and email delivery.',
      },);
    } catch (error) {
      return res.status(400,).json({ error: error.message, },);
    }
  },);

  // Get full report — checks for auth headers inline
  router.get('/report/:id', async (req, res,) => {
    const hasAuth = req.get('X-API-Key',) || req.get('Authorization',);
    if (!hasAuth) return res.status(401,).json({ error: 'Authentication required to view full report.', },);
    try {
      const report = await platform.store.deepAudits.findById(req.params.id,);
      if (!report) return res.status(404,).json({ error: 'Report not found.', },);
      return res.json({ ...report, full_report_available: true, },);
    } catch (error) {
      return res.status(400,).json({ error: error.message, },);
    }
  },);

  // Download PDF report — checks for auth headers inline
  router.get('/report/:id/pdf', async (req, res,) => {
    const hasAuth = req.get('X-API-Key',) || req.get('Authorization',);
    if (!hasAuth) return res.status(401,).json({ error: 'Authentication required to download report.', },);
    try {
      const report = await platform.store.deepAudits.findById(req.params.id,);
      if (!report) return res.status(404,).json({ error: 'Report not found.', },);
      const pdfBuffer = await platform.pdfService.generateReportPdf(report,);
      return res.json({ pdf: pdfBuffer.toString('base64',), filename: `storecops-report-${report.report_id || report._id}.pdf`, },);
    } catch (error) {
      return res.status(400,).json({ error: error.message, },);
    }
  },);

  // Email PDF report — checks for auth headers inline
  router.post('/report/:id/email', async (req, res,) => {
    const hasAuth = req.get('X-API-Key',) || req.get('Authorization',);
    if (!hasAuth) return res.status(401,).json({ error: 'Authentication required to email report.', },);
    try {
      const { email, } = req.body || {};
      if (!email) return res.status(400,).json({ error: 'email is required.', },);
      const report = await platform.store.deepAudits.findById(req.params.id,);
      if (!report) return res.status(404,).json({ error: 'Report not found.', },);

      const pdfBuffer = await platform.pdfService.generateReportPdf(report,);

      const request = await platform.store.reportRequests.insert({
        report_id: report._id,
        url: report.url,
        email,
        delivered_at: null,
      },);

      const result = await platform.emailService.send({
        to: email,
        subject: `Your Storecops Health Report — Score: ${report.overall_score}/100`,
        html: buildReportEmailHtml(report, email,),
        attachments: [{ filename: `storecops-report-${report._id}.pdf`, content: pdfBuffer, },],
      },);

      await platform.store.reportRequests.insert({
        ...request,
        delivered_at: result.delivered ? new Date().toISOString() : null,
        delivery_status: result.delivered ? 'sent' : 'failed',
      },);

      return res.json({ delivered: result.delivered, email, report_id: report._id, },);
    } catch (error) {
      return res.status(400,).json({ error: error.message, },);
    }
  },);

  return router;
}

function createApp(platform,) {
  const app = express();

  // Must be set before anything reads req.ip. The rate limiters key on it, so
  // without this every request behind a reverse proxy shares one bucket and a
  // per-IP limit silently becomes a global one.
  app.set('trust proxy', platform.config.trustProxy,);

  // ── CORS ──────────────────────────────────────────────────────────
  // Must run first: Admin UI Extensions and storefront widgets call
  // this API from Shopify's origin, and preflight requests carry no
  // credentials, so they have to be answered before the auth chain.
  app.use(
    createCorsMiddleware({
      env: process.env,
      publicUrl: platform.config.publicUrl,
      warn: (msg,) => console.warn(`[CORS] ${msg}`,),
    },),
  );

  // ── Security Hardening Middleware ─────────────────────────────────
  // Apply security headers to all responses
  app.use(securityHeaders(),);

  // Log security-relevant events
  app.use(securityLogger(),);

  // Sanitize all input (body, query, params)
  app.use(sanitizeInput(),);

  // Prevent SQL injection attempts
  app.use(preventSqlInjection(),);

  // Prevent path traversal attacks
  app.use(preventPathTraversal(),);

  // ── Performance Monitoring ────────────────────────────────────────
  // Track request metrics for monitoring dashboard
  if (platform.monitoringService) {
    app.use((req, res, next,) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        const isError = res.statusCode >= 400;
        platform.monitoringService.trackRequest(duration, isError,);
      },);
      next();
    },);
  }

  // ── Body Parsing ──────────────────────────────────────────────────
  // Keep the raw body around for webhook signature verification (10.4).
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, res, buf,) => {
        req.rawBody = buf;
      },
    },),
  );

  const healthProbe = createHealthProbe({ store: platform.store, config: platform.config, },);

  // Liveness. Deliberately trivial and dependency-free: it answers "is this
  // process up", which is the only thing a restart policy should act on. Do not
  // add a storage check here — a slow or briefly unavailable database would then
  // trigger a restart loop instead of a traffic drain. That is what /ready is for.
  app.get('/health', (req, res,) =>
    res.json({
      status: 'ok',
      service: 'storecops-growth-platform',
      build: healthProbe.build,
      time: new Date().toISOString(),
    },),
  );

  // Readiness (DEP-003). This is what `railway.json` healthcheckPath points at,
  // so a deploy is only promoted once storage actually answers. 503 (not 500)
  // because the instance is not broken — it is not yet able to take traffic.
  app.get('/ready', async (req, res,) => {
    // `check()` is total and time-bounded, but this is the endpoint Railway's
    // healthcheck depends on, and Express 4 does not catch a rejected async
    // handler — `Layer.handle_request` wraps only the synchronous call, so a
    // rejection here would leave the probe unanswered *and* raise an unhandled
    // rejection, which terminates the process. Always answer.
    try {
      const result = await healthProbe.check();
      res.status(result.ready ? 200 : 503,).json({ ...result, build: healthProbe.build, },);
    } catch (error) {
      res.status(503,).json({
        ready: false,
        status: 'not_ready',
        error: error?.message || 'readiness probe failed',
        ping_timeout_ms: healthProbe.pingTimeoutMs,
        build: healthProbe.build,
      },);
    }
  },);

  // Detailed health status (for monitoring dashboards)
  app.get('/health/status', async (req, res,) => {
    // Same Express-4 hazard as /ready above: an async handler that rejects is
    // never answered and raises an unhandled rejection. A monitoring endpoint
    // must not be able to take the process down.
    try {
      if (platform.monitoringService) {
        const health = await platform.monitoringService.getHealthStatus();
        res.json(health,);
      } else {
        res.json({ status: 'ok', message: 'Monitoring service not initialized', },);
      }
    } catch (error) {
      res.status(503,).json({ status: 'unavailable', error: error?.message || 'health status failed', },);
    }
  },);

  const rateLimiter = createRateLimiter({
    windowMs: platform.config.security?.rateLimitWindowMs,
    max: platform.config.security?.rateLimitMax,
  },);

  // Credential endpoints get a much tighter, IP-keyed ceiling than the data
  // API. This is the coarse half of brute-force protection — it caps total
  // attempts from one source. The fine half is per-account and lives in the
  // auth service (src/server/loginThrottle.js), because a distributed attack
  // never exceeds a per-IP limit.
  const authRateLimiter = createRateLimiter({
    windowMs: platform.config.security?.authRateLimitWindowMs,
    max: platform.config.security?.authRateLimitMax,
  },);

  // Public auth endpoints (signup/login), then the keyed API.
  app.use('/api/v1/auth', authRateLimiter, createAuthRouter(platform,),);
  // Free store audit: public by design (pre-signup value).
  app.use('/api/v1/audit', rateLimiter, createAuditRouter(platform,),);

  // One-click platform connect — pre-login by design:
  // status, OAuth start/callback, Woo keys handoff, custom catalog crawl,
  // and the sanitized view of a pending (authorized) connection.
  app.get('/connect/status', rateLimiter, async (req, res,) => {
    // Expression-bodied and therefore unguarded: `await platform.oauth.status()`
    // can reject, and Express 4 cannot catch a rejected async handler. The
    // request would go unanswered *and* the rejection would terminate the
    // process — on a route that needs no credentials.
    try {
      res.json(await platform.oauth.status(),);
    } catch (error) {
      console.error('[OAUTH] status failed:', error.message,);
      res.status(503,).json({ error: 'Could not read connector status.', },);
    }
  },);
  app.get('/connect/:platform/start', rateLimiter, async (req, res,) => {
    try {
      const { redirect_url, } = await platform.oauth.start(req.params.platform, req.query || {},);
      res.redirect(redirect_url,);
    } catch (error) {
      res.redirect(`/app?connect_error=${encodeURIComponent(error.message,)}`,);
    }
  },);
  app.get('/connect/:platform/callback', rateLimiter, async (req, res,) => {
    // A browser navigation, so a failure must land the user back in the app
    // rather than return JSON. `oauth.callback` converts its own errors into a
    // `connect_error` redirect, but that is a convention inside another module —
    // and Express 4 cannot catch a rejected async handler, so a rejection here
    // would leave the navigation unanswered *and* raise an unhandled rejection,
    // which terminates the process. Reachable without credentials.
    try {
      const { redirect, } = await platform.oauth.callback(req.params.platform, req.query || {},);
      if (!res.headersSent) res.redirect(redirect,);
    } catch (error) {
      console.error('[OAUTH] callback failed:', error.message,);
      if (!res.headersSent) {
        const msg = 'The connection could not be completed — please start again.';
        res.redirect(`/app?connect_error=${encodeURIComponent(msg,)}`,);
      }
    }
  },);
  app.post('/connect/woocommerce', rateLimiter, async (req, res,) => {
    try {
      res.json(await platform.oauth.connectWooCommerce(req.body || {},),);
    } catch (error) {
      res.status(400,).json({ error: error.message, },);
    }
  },);
  app.post('/connect/custom', rateLimiter, async (req, res,) => {
    try {
      res.json(await platform.oauth.connectCustom(req.body || {},),);
    } catch (error) {
      res.status(400,).json({ error: error.message, },);
    }
  },);
  // Prove ownership of a custom store (meta tag / file / DNS TXT), then the token unlocks.
  app.post('/connect/custom/verify', rateLimiter, async (req, res,) => {
    try {
      res.json(await platform.oauth.verifyCustom(req.body || {},),);
    } catch (error) {
      res.status(400,).json({ error: error.message, },);
    }
  },);
  app.get('/api/v1/connect/pending/:token', rateLimiter, async (req, res,) => {
    // Unguarded async handler on a pre-login route — see the OAuth callback note
    // above. The error message is deliberately generic: this route is reachable
    // without credentials, and echoing a storage error would disclose internals.
    // An unknown token is already an explicit 404 below, so anything reaching the
    // catch is an unexpected failure, not a client mistake.
    try {
      const pending = await platform.oauth.pending(req.params.token,);
      if (!pending) return res.status(404,).json({ error: 'Connection expired or already used.', },);
      return res.json(pending,);
    } catch (error) {
      console.error('[OAUTH] pending connection lookup failed:', error.message,);
      return res.status(500,).json({ error: 'Could not resolve the connection.', },);
    }
  },);

  app.use(
    '/api/v1',
    rateLimiter,
    apiKeyMiddleware(platform,),
    platform.tieredRateLimiter.middleware.bind(platform.tieredRateLimiter,),
    createApiRouter(platform,),
  );

  // Inbound order webhooks from connected stores (Shopify etc.).
  // Public endpoint, but HMAC-verified against the Shopify CLIENT SECRET
  // (X-Shopify-Hmac-Sha256, base64). Fails closed with 401 when that secret
  // is unset — it is not keyed by WEBHOOK_SECRET.
  //
  // The HMAC proves the body came from Shopify; it does NOT say which store the
  // body belongs to, because the client secret is per-app rather than per-shop and
  // the Order payload carries no shop field. The `:store_id` here was therefore
  // caller-chosen, so admission additionally binds the delivery to a store and
  // makes it single-use. See src/server/webhookTenancy.js.
  app.post(
    '/webhooks/orders/:store_id',
    shopifyWebhookVerifier(platform.config.security?.shopifyClientSecret,),
    async (req, res,) => {
      const store_id = req.params.store_id;
      let admission;
      try {
        admission = await admitWebhook(req, store_id,);
        if (!admission.ok) return refuseWebhook(res, admission,);
        if (admission.duplicate) return res.json({ ok: true, duplicate: true, },);

        const result = await platform.integrations.ingestOrderWebhook(
          store_id,
          req.body || {},
        );
        // `accepted: false` is a decision (consent withheld, malformed payload), not
        // a transient failure, so the reservation is deliberately kept: Shopify's
        // retries then short-circuit instead of re-running a decision that cannot
        // change.
        return res.status(result.accepted ? 200 : 400,).json(result,);
      } catch (error) {
        // A throw IS transient, so the reservation is released — otherwise the retry
        // would be answered 200-and-dropped as a duplicate and the order lost for good.
        if (admission?.digest) {
          await webhookTenancy.releaseDelivery({ store: platform.store, digest: admission.digest, },);
        }
        return res.status(400,).json({ error: error.message, },);
      }
    },
  );

  // Inbound return/exchange webhooks from connected stores. Admission works exactly
  // as it does for orders above, and for the same reasons.
  app.post(
    '/webhooks/returns/:store_id',
    shopifyWebhookVerifier(platform.config.security?.shopifyClientSecret,),
    async (req, res,) => {
      const store_id = req.params.store_id;
      let admission;
      try {
        admission = await admitWebhook(req, store_id,);
        if (!admission.ok) return refuseWebhook(res, admission,);
        if (admission.duplicate) return res.json({ ok: true, duplicate: true, },);

        const result = await platform.returnService.processReturn(
          store_id,
          req.body || {},
        );
        return res.status(200,).json(result,);
      } catch (error) {
        if (admission?.digest) {
          await webhookTenancy.releaseDelivery({ store: platform.store, digest: admission.digest, },);
        }
        return res.status(400,).json({ error: error.message, },);
      }
    },
  );

  // Web app: landing page + client dashboard (static SPA).
  const publicDir = path.join(__dirname, '..', '..', 'public',);

  // ── Shopify app proxy ─────────────────────────────────────────────
  // Shopify forwards https://{shop}/apps/storecops/* here. This is how
  // the storefront theme extension reaches the platform without an API
  // key ever appearing in Liquid.
  const appProxy = createAppProxy({
    credentialsFor: (p,) => platform.oauth.credentialsFor(p,),
    resolveTenant: (shopDomain,) => tenantForShop(platform, shopDomain,),
    warn: (msg,) => console.warn(`[APP-PROXY] ${msg}`,),
  },);

  // The storefront tracking snippet.
  app.get('/proxy/tracker.js', appProxy.requireProxy, (req, res,) => {
    res.type('application/javascript',);
    res.sendFile(path.join(publicDir, 'tracker.js',),);
  },);

  // Storefront event ingest through the app proxy.
  //
  // This exists because the theme app extension CANNOT carry an ingest key. The
  // snippet is served from the storefront, so anything in its URL is public —
  // which is why the extension's own comment promises "no API key is ever
  // exposed to the storefront". Shopify signs every `/apps/storecops/*` request
  // with the app client secret instead, and that signature authenticates this
  // route.
  //
  // Consequence, stated plainly: a storefront visitor can reach this path (they
  // are on the storefront, so Shopify will sign for them). What they cannot do
  // is choose the tenant. The store is taken from `req.proxyStoreId` — which is
  // derived from the *signed* `shop` query — and the body's `store_id` is
  // overwritten below. Without that overwrite a visitor could post to their own
  // store's proxy URL and write events into any other tenant.
  //
  // Rate limiting is the plain IP limiter, deliberately NOT
  // `tieredRateLimiter`: that one resolves a plan from `req.authUser`, which
  // this path has no equivalent of, so it would evaluate every storefront as
  // the `free` tier and cap real tracking at 60 rpm / 1000 per day per IP.
  // A per-tenant ingest quota belongs here but needs a keyed-by-store design.
  app.post(
    '/proxy/track',
    express.json({ limit: '16kb', },),
    rateLimiter,
    appProxy.requireProxy,
    async (req, res,) => {
      try {
        const body = { ...(req.body || {}), };
        // The tenant is decided by the signature, never by the payload.
        body.store_id = req.proxyStoreId;
        const result = await platform.trackAndReact(body,);
        res.status(result.accepted ? 200 : 400,).json(result,);
      } catch (error) {
        res.status(400,).json({ error: error.message, },);
      }
    },
  );

  // Consent decisions recorded by the storefront banner.
  app.post('/proxy/consent', express.json({ limit: '16kb', },), appProxy.requireProxy, async (req, res,) => {
    try {
      const body = req.body || {};
      const status = body.consent === 'accepted' ? 'accepted' : 'declined';
      const categories = status === 'accepted'
        ? { analytics: true, marketing: true, recovery: true, essential: true, }
        : { analytics: false, marketing: false, recovery: false, essential: true, };

      const identity = body.customer_id || body.email || `session:${body.session_id || 'anonymous'}`;
      await platform.consentService.setConsent(
        req.proxyStoreId,
        identity,
        categories,
        { source: 'storefront_banner', shop: req.proxyShop, },
      );

      res.json({ ok: true, status, },);
    } catch (error) {
      res.status(400,).json({ error: error.message, },);
    }
  },);

  // Product recommendations for the storefront widget.
  app.get('/proxy/recommendations', appProxy.requireProxy, async (req, res,) => {
    try {
      const productId = String(req.query.product_id || '',);
      const limit = Math.min(Number(req.query.limit,) || 4, 12,);
      const customerId = req.query.customer_id ? String(req.query.customer_id,) : productId;

      const result = await platform.recommendationEngine.recommend(
        req.proxyStoreId,
        customerId,
        limit,
      );

      // The engine only knows product ids. Enrich with the descriptive
      // fields a storefront card needs (name, price, handle) so the
      // widget can render a real link instead of a bare id.
      const inventory = await platform.inventoryLedger.levels(req.proxyStoreId,);
      const byId = new Map(inventory.map((row,) => [String(row.product_id,), row,],),);
      const recommendations = (result.recommendations || []).map((rec,) => {
        const row = byId.get(String(rec.product_id,),);
        return {
          product_id: rec.product_id,
          strategy: rec.strategy,
          name: row?.name || null,
          price: row?.price ?? null,
          handle: row?.handle || null,
          in_stock: row ? Number(row.stock,) > 0 : null,
        };
      },);

      res.json({
        ok: true,
        product_id: productId || null,
        strategy: result.strategy,
        recommendations,
      },);
    } catch (error) {
      res.status(400,).json({ error: error.message, },);
    }
  },);

  app.use(express.static(publicDir,),);

  // Root serves the marketing landing page.
  app.get('/', (req, res,) => res.sendFile(path.join(publicDir, 'index.html',),),);

  // Free store audit page (public).
  app.get('/audit', (req, res,) => res.sendFile(path.join(publicDir, 'audit.html',),),);

  // Task 46: Serve an inline SVG favicon to prevent 404s.
  app.get('/favicon.ico', (req, res,) => {
    res.setHeader('Content-Type', 'image/svg+xml',);
    res.setHeader('Cache-Control', 'public, max-age=86400',);
    res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8b7cf6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.6 8-10V5.5L12 2 4 5.5V12c0 6.4 8 10 8 10z"/><path d="m9 11.5 2 2 4-4.5"/></svg>',);
  },);

  // Legal pages (Tasks 54-56, 59)
  app.get('/privacy', (req, res,) => res.sendFile(path.join(publicDir, 'privacy.html',),),);
  app.get('/terms', (req, res,) => res.sendFile(path.join(publicDir, 'terms.html',),),);
  app.get('/support', (req, res,) => res.sendFile(path.join(publicDir, 'support.html',),),);
  // Task 30: Tracker data disclosure page (Shopify compliance).
  app.get('/tracker-disclosure', (req, res,) => res.sendFile(path.join(publicDir, 'tracker-disclosure.html',),),);
  // COMP-004: Sub-processor register. The list itself lives in
  // `src/config/subprocessors.js` and is guarded against the code by
  // test/subprocessors.test.js — this page must not restate it by hand.
  app.get('/subprocessors', (req, res,) => res.sendFile(path.join(publicDir, 'subprocessors.html',),),);

  // Task ob6: Admin console page.
  app.get('/admin', (req, res,) => res.sendFile(path.join(publicDir, 'admin.html',),),);

  // Task ob1: Serve the hosted tracker.js.
  // Two delivery paths: the theme app extension loads it through the app proxy
  // (`/proxy/tracker.js`), and a merchant may paste it manually. The Script Tag
  // API path was removed — it is deprecated and its scopes are rejected at
  // review. Already covered by express.static(publicDir) — tracker.js lives in public/.

  // Task ob7: Shopify compliance webhook receivers.
  // These are called by Shopify when a merchant uninstalls the app or
  // requests data redaction. HMAC-verified by shopifyWebhookVerifier (the
  // X-Shopify-Hmac-Sha256 header, base64, keyed by the app client secret).
  const shopifyComplianceVerifier = shopifyWebhookVerifier(platform.config.security?.shopifyClientSecret,);

  // ── Inbound webhook admission ────────────────────────────────────────
  //
  // One gate for every signature-verified Shopify delivery. It answers the two
  // questions the HMAC cannot: *which tenant is this delivery for*, and *has this
  // exact delivery already been processed*. See src/server/webhookTenancy.js for why
  // Shopify does not sign a tenant, and what that leaves as residual risk.
  //
  // This replaces a local `isDuplicateWebhook` helper that:
  //   - recorded its dedupe rows in `webhookQueue`, the OUTBOUND delivery queue, so
  //     `webhookRetryQueue.status()` counted them in `total` while matching none of
  //     its buckets, and its cleanup walked a table that grows with order volume;
  //   - truncated the digest to 16 hex characters (64 bits) while using it as a key;
  //   - fell back to hashing `JSON.stringify(req.body)`, which strips insignificant
  //     whitespace and so collapses two distinct signed bodies onto one digest;
  //   - stored `expires_at` but never read it, making the declared 24h TTL decorative;
  //   - returned `false` on a storage error, i.e. failed OPEN on a security control;
  //   - and was never applied to `/webhooks/orders` or `/webhooks/returns`, which are
  //     precisely the routes that take their `:store_id` from the caller.

  /** Report a delivery replayed into a tenant it does not belong to. */
  async function reportCrossTenantDelivery(event,) {
    console.error(
      `[WEBHOOK] cross-tenant replay refused: a delivery attributed to ${event.attributed_to} `
      + `was presented as ${event.presented_as} (topic ${event.topic || 'unknown'}, `
      + `digest ${String(event.digest || '',).slice(0, 12,)}…)`,
    );
    if (!platform.monitoringService) return;
    try {
      await platform.monitoringService.recordEvent('webhook_cross_tenant_replay', {
        severity: 'error',
        message: 'A signed webhook body was replayed against a different store.',
      },);
    } catch (_) {
      // Reporting must never change the admission decision.
    }
  }

  /**
   * Admit a signature-verified delivery.
   *
   * @param {object} req
   * @param {string} store_id The scope the delivery is attributed to.
   * @param {object} [options]
   * @param {boolean} [options.bindTenant=true] Whether the caller-supplied scope must
   *   be reconciled against the delivery's own shop claims. False for the compliance
   *   routes, which take no tenant from the caller — they are global actions driven
   *   by the shop named in the body, so there is nothing to reconcile against and the
   *   digest is only there for idempotency.
   */
  async function admitWebhook(req, store_id, { bindTenant = true, } = {},) {
    const admission = await webhookTenancy.admitDelivery({
      store: platform.store,
      store_id,
      rawBody: req.rawBody,
      topic: req.headers['x-shopify-topic'],
      payload: req.body,
      headerShopDomain: req.headers['x-shopify-shop-domain'],
      resolveShop: bindTenant ? (domain,) => tenantForShop(platform, domain,) : undefined,
      onCrossTenant: reportCrossTenantDelivery,
    },);

    // Opportunistic expiry sweep. Throttled internally to once an hour per process,
    // keyed on an indexed day bucket, and it can never fail a delivery.
    if (admission.ok) {
      webhookTenancy.sweepExpiredDeliveries({ store: platform.store, },).catch(() => {},);
    }

    return admission;
  }

  /** Answer a refused delivery with the status admission decided on. */
  function refuseWebhook(res, admission,) {
    return res.status(admission.status || 400,).json({ ok: false, error: admission.error, },);
  }

  /**
   * The digest scope for a compliance delivery.
   *
   * These routes carry no `:store_id`, so the scope comes from the shop in the body.
   * When the shop is not a connected store the domain itself is used, so the digest
   * is still scoped to something and the replay property holds. Such a row is not
   * reachable by a store purge (which deletes by `store_id`), so it lives until the
   * expiry sweep collects it — bounded, and it holds no personal data.
   */
  async function complianceScope(req,) {
    const domain = webhookTenancy.normaliseDomain(
      req.body?.myshopify_domain || req.body?.shop_domain || req.body?.shop || req.body?.domain,
    );
    if (!domain) return 'shop:unknown';
    const tenant = await tenantForShop(platform, domain,).catch(() => null,);
    return tenant?.store_id || `shop:${domain}`;
  }

  app.post('/webhooks/shopify/app-uninstalled', shopifyComplianceVerifier, async (req, res,) => {
    try {
      const admission = await admitWebhook(req, await complianceScope(req,), { bindTenant: false, },);
      if (!admission.ok) return refuseWebhook(res, admission,);
      if (admission.duplicate) {
        console.log('[WEBHOOK] app-uninstalled duplicate — skipping',);
        return res.json({ ok: true, duplicate: true, },);
      }
      const shop = req.body?.myshopify_domain || req.body?.domain;
      const safeShop = shop ? String(shop,).split('.',)[0] + '•••' : 'unknown';
      console.log(`[WEBHOOK] App uninstalled by ${safeShop}`,);
      // Mark the specific store as disconnected (match by shop domain or type).
      const shopDomain = shop ? String(shop,).toLowerCase().replace(/^https?:\/\//, '',).replace(/\/$/, '',) : null;
      const allConns = await platform.store.integrations.find({ type: 'shopify', },);
      for (const conn of allConns) {
        // Match if: no shop domain in webhook (fallback to type), or domain matches
        if (!shopDomain || !conn.config?.shopDomain || conn.config.shopDomain === shopDomain) {
          await platform.store.integrations.update(conn._id, {
            status: 'uninstalled',
            uninstalled_at: new Date().toISOString(),
          },);
        }
      }
      if (platform.monitoringService) {
        await platform.monitoringService.recordEvent('app_uninstalled', {
          severity: 'warning',
          message: `App uninstalled by ${shop}`,
        },);
      }
    } catch (err) {
      console.error('[WEBHOOK] app-uninstalled handler error:', err.message,);
    }
    return res.json({ ok: true, },);
  },);

  app.post('/webhooks/shopify/data-request', shopifyComplianceVerifier, async (req, res,) => {
    try {
      const admission = await admitWebhook(req, await complianceScope(req,), { bindTenant: false, },);
      if (!admission.ok) return refuseWebhook(res, admission,);
      if (admission.duplicate) {
        console.log('[WEBHOOK] customers/data-request duplicate — skipping',);
        return res.json({ ok: true, duplicate: true, },);
      }
      const customerId = req.body?.customer?.id;
      const safeId = customerId ? String(customerId,).slice(0, 4,) + '•••' : 'unknown';
      console.log(`[WEBHOOK] Customer data request for ${safeId}`,);
      // GDPR: export all data for the requested customer.
      if (customerId && platform.dataExport) {
        const allStores = await platform.store.integrations.find({},);
        for (const conn of allStores) {
          try {
            const exportData = await platform.dataExport.exportCustomerData(conn.store_id, String(customerId,),);
            if (exportData) {
              console.log(`[WEBHOOK] Data export prepared for customer ${safeId} in store ${conn.store_id}`,);
            }
          } catch (_) {}
        }
      }
      if (platform.monitoringService) {
        await platform.monitoringService.recordEvent('data_request', {
          severity: 'info',
          message: `Data request for customer ${customerId || 'unknown'}`,
        },);
      }
    } catch (err) {
      console.error('[WEBHOOK] data-request handler error:', err.message,);
    }
    return res.json({ ok: true, },);
  },);

  app.post('/webhooks/shopify/customer-redact', shopifyComplianceVerifier, async (req, res,) => {
    try {
      const admission = await admitWebhook(req, await complianceScope(req,), { bindTenant: false, },);
      if (!admission.ok) return refuseWebhook(res, admission,);
      if (admission.duplicate) {
        console.log('[WEBHOOK] customers/redact duplicate — skipping',);
        return res.json({ ok: true, duplicate: true, },);
      }
      const customerId = req.body?.customer?.id;
      // Task 29b: Mask customer ID in production logs.
      const safeId = customerId ? String(customerId,).slice(0, 4,) + '•••' : 'unknown';
      console.log(`[WEBHOOK] Customer redact request for ${safeId}`,);
      // GDPR right-to-be-forgotten: delete customer data.
      if (customerId) {
        const allStores = await platform.store.integrations.find({},);
        for (const conn of allStores) {
          await deleteCustomerData(platform, conn.store_id, String(customerId,),).catch(() => {},);
        }
      }
    } catch (err) {
      console.error('[WEBHOOK] customer-redact handler error:', err.message,);
    }
    return res.json({ ok: true, },);
  },);

  app.post('/webhooks/shopify/shop-redact', shopifyComplianceVerifier, async (req, res,) => {
    // GDPR: Respond immediately and offload heavy deletion to background.
    // Shopify requires a 200 response within 5 seconds.
    try {
      const admission = await admitWebhook(req, await complianceScope(req,), { bindTenant: false, },);
      if (!admission.ok) return refuseWebhook(res, admission,);
      if (admission.duplicate) {
        console.log('[WEBHOOK] shop-redact duplicate — skipping',);
        return res.json({ ok: true, duplicate: true, },);
      }
      const shop = req.body?.myshopify_domain || req.body?.shop;
      const safeShop = shop ? String(shop,).split('.',)[0] + '•••' : 'unknown';
      console.log(`[WEBHOOK] Shop redact request for ${safeShop} — processing in background`,);

      // Schedule background deletion (non-blocking)
      if (shop) {
        const shopDomain = String(shop,).toLowerCase();
        // Use setImmediate or setTimeout(0) to defer heavy work
        setImmediate(async () => {
          try {
            const conn = await platform.store.integrations.findOne({ type: 'shopify', },);
            if (conn && conn.config?.shopDomain === shopDomain) {
              const storeId = conn.store_id;
              // Purge every store-scoped collection. The list is derived from
              // the schema in src/server/privacy.js rather than hardcoded here —
              // the previous inline list named 16 of the 52 collections, so the
              // remaining 36 survived a shop/redact indefinitely.
              const purge = await purgeStoreData(platform.store, storeId,);
              console.log(
                `[WEBHOOK] Purged ${purge.total_deleted} rows across ` +
                  `${Object.keys(purge.deleted,).length} collections for store ${storeId}`,
              );
              // Mark integration as uninstalled
              await platform.store.integrations.update(conn._id, {
                status: 'uninstalled',
                uninstalled_at: new Date().toISOString(),
                config: null, // wipe credentials
              },);
              console.log(`[WEBHOOK] Background purge completed for store ${storeId}`,);
            }
          } catch (err) {
            console.error('[WEBHOOK] shop-redact background error:', err.message,);
          }
        },);
      }
      if (platform.monitoringService) {
        platform.monitoringService.recordEvent('shop_redact', {
          severity: 'warning',
          message: `Shop data redaction initiated for ${safeShop}`,
        },).catch(() => {},);
      }
    } catch (err) {
      console.error('[WEBHOOK] shop-redact handler error:', err.message,);
    }
    // Always respond immediately
    return res.json({ ok: true, },);
  },);

  // ── Meta WhatsApp webhook ────────────────────────────────────────
  // Meta sends delivery status updates and customer replies here.
  // Two endpoints: GET for challenge verification, POST for events.
  const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';
  const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';

  // Meta webhook challenge verification (one-time setup).
  app.get('/webhooks/whatsapp', (req, res,) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN && challenge) {
      console.log('[WHATSAPP] Webhook verified successfully',);
      return res.status(200,).send(challenge,);
    }
    console.log('[WHATSAPP] Webhook verification failed — token mismatch',);
    return res.status(403,).json({ error: 'Verification failed', },);
  },);

  // Meta webhook event receiver (delivery receipts + customer replies).
  app.post('/webhooks/whatsapp', async (req, res,) => {
    try {
      // Verify signature when app secret is configured.
      if (WHATSAPP_APP_SECRET) {
        const sig = req.get('X-Hub-Signature-256',) || '';
        const rawBody = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body || {},);
        if (!verifyWebhookSignature(rawBody, sig, WHATSAPP_APP_SECRET,)) {
          console.log('[WHATSAPP] Webhook signature verification failed',);
          return res.status(401,).json({ error: 'Invalid signature', },);
        }
      }

      // Process delivery status updates.
      const statuses = parseStatusUpdates(req.body,);
      for (const status of statuses) {
        // Map Meta status to our event types for the channel optimizer.
        const eventMap = {
          delivered: 'whatsapp_read', // treat delivered as engagement
          read: 'whatsapp_read',
        };
        const eventType = eventMap[status.status];

        if (eventType && status.recipient) {
          // Find the customer by phone to record the engagement event.
          const profile = await platform.store.customers.findOne({ phone: status.recipient, },);
          if (profile) {
            await platform.eventTracker.track({
              store_id: profile.store_id,
              event_type: eventType,
              customer_id: profile.identity,
              origin: 'whatsapp_webhook',
              message_id: status.message_id,
              timestamp: new Date(Number(status.timestamp,) * 1000,).toISOString(),
            },);
          }
        }

        if (status.status === 'failed') {
          console.log(`[WHATSAPP] Message ${status.message_id} failed: ${JSON.stringify(status.errors,)}`,);
          if (platform.monitoringService) {
            await platform.monitoringService.recordEvent('whatsapp_delivery_failed', {
              severity: 'warning',
              message: `WhatsApp message ${status.message_id} failed`,
              errors: status.errors,
            },);
          }
        }
      }

      // Process incoming customer replies.
      const messages = parseIncomingMessages(req.body,);
      for (const msg of messages) {
        const profile = await platform.store.customers.findOne({ phone: msg.from, },);
        if (profile) {
          await platform.eventTracker.track({
            store_id: profile.store_id,
            event_type: 'whatsapp_replied',
            customer_id: profile.identity,
            origin: 'whatsapp_webhook',
            message_id: msg.message_id,
            reply_text: msg.text?.slice(0, 200,),
            timestamp: new Date(Number(msg.timestamp,) * 1000,).toISOString(),
          },);
        }
      }

      if (statuses.length > 0 || messages.length > 0) {
        console.log(`[WHATSAPP] Processed ${statuses.length} statuses, ${messages.length} messages`,);
      }
    } catch (err) {
      console.error('[WHATSAPP] Webhook handler error:', err.message,);
    }
    // Always 200 — Meta retries on non-200 and we don't want storms.
    return res.json({ ok: true, },);
  },);

  // ── Competitor auto-scrape scheduler ────────────────────────────────
  // Periodically scrape all tracked competitors and refresh ad library data.
  // Default: every 6 hours. Override with COMPETITOR_SCRAPE_INTERVAL_HOURS.
  const scrapeIntervalHours = Number(process.env.COMPETITOR_SCRAPE_INTERVAL_HOURS || 6,);
  const scrapeIntervalMs = scrapeIntervalHours * 60 * 60 * 1000;

  async function runCompetitorScrapeJob() {
    try {
      // Find all stores that have tracked competitors
      const allTracked = await platform.store.trackedCompetitors.find({ enabled: true, },);
      const storeIds = [...new Set(allTracked.map((c,) => c.store_id,),),];

      for (const store_id of storeIds) {
        const result = await platform.competitorScraper.scrapeAll(store_id,);
        console.log(
          `[SCRAPE] ${store_id}: ${result.results.length} competitor(s), ${result.total_products} products scraped`,
        );
      }

      // Also refresh Meta Ad Library data for stores with page IDs
      if (platform.metaAdLibrary.hasToken) {
        const adResult = await platform.metaAdLibrary.scrapeAllCompetitors(platform.store,);
        if (adResult.status === 'success') {
          console.log(`[SCRAPE] Meta ads: ${adResult.ads_scraped} ad(s) from ${adResult.competitors_scraped} competitor(s)`,);
        }
      }
    } catch (err) {
      console.error('[SCRAPE] Competitor scrape job failed:', err.message,);
    }
  }

  const scrapeTimer = setInterval(runCompetitorScrapeJob, scrapeIntervalMs,);
  // Don't keep the process alive just for the timer.
  if (scrapeTimer.unref) scrapeTimer.unref();
  console.log(`[SCRAPE] Competitor auto-scrape scheduled every ${scrapeIntervalHours}h`,);

  // SPA fallback: unknown non-API paths get the app shell.
  app.get('/app', (req, res,) => res.sendFile(path.join(publicDir, 'app.html',),),);

  // Central error handler.
  app.use((error, req, res, next,) => {
    if (error?.type === 'entity.parse.failed') {
      return res.status(400,).json({ error: 'Invalid JSON body.', },);
    }
    return res.status(500,).json({ error: error.message || 'Internal error.', },);
  },);

  return app;
}

module.exports = { createApp, apiKeyMiddleware, createAuthRouter, createAuditRouter, };
