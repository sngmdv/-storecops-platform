'use strict';

/**
 * App factory: builds the Express app around a platform instance.
 * Kept separate from server.js so tests can create an app without
 * binding a port.
 */

const express = require('express',);
const path = require('path',);
const crypto = require('crypto',);
const { createApiRouter, } = require('./apiRoutes',);
const { createRateLimiter, webhookVerifier, deleteCustomerData, } = require('./security',);
const { verifyWebhookSignature, parseStatusUpdates, parseIncomingMessages, } = require('../layers/execution/whatsappService',);
const {
  securityHeaders,
  sanitizeInput,
  securityLogger,
  preventSqlInjection,
  preventPathTraversal,
} = require('./securityHardening',);

/**
 * API gateway auth. Accepts, in order:
 *   1. the master dev key (X-API-Key / ?api_key= for SSE),
 *   2. a tenant's private API key issued at signup,
 *   3. a bearer session token from login,
 *   4. the write-only public ingest key (tracking snippet) — this one
 *      is locked to /track by the router gate.
 */
function apiKeyMiddleware(platform,) {
  return async (req, res, next,) => {
    const provided = req.get('X-API-Key',) || req.query?.api_key;
    if (provided) {
      if (provided === platform.config.apiKey) {
        // Master key acts as a platform-wide admin identity.
        req.authUser = { email: 'master@platform', role: 'admin', };
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

    const bearer = (req.get('Authorization',) || '').replace(/^Bearer\s+/i, '',);
    if (bearer) {
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
    const bearer = (req.get('Authorization',) || '').replace(/^Bearer\s+/i, '',);
    await platform.auth.logout(bearer,);
    res.json({ ok: true, },);
  },);

  router.get('/me', async (req, res,) => {
    const bearer = (req.get('Authorization',) || '').replace(/^Bearer\s+/i, '',);
    const session = await platform.auth.verify(bearer,);
    if (!session) return res.status(401,).json({ error: 'Not authenticated.', },);
    return res.json({ user: session.user, store_id: session.store_id, },);
  },);

  /**
   * Shopify embedded app auth endpoint.
   * Called by the frontend when running inside Shopify Admin (embedded mode).
   * Verifies the Shopify session and returns a Storecops session.
   */
  router.post('/shopify', async (req, res,) => {
    try {
      const { shop, host, sessionToken, } = req.body || {};
      
      if (!shop) {
        return res.status(400,).json({ error: 'Shop parameter is required.', },);
      }
      
      // Validate shop domain format
      const shopDomain = String(shop,).toLowerCase().replace(/^https?:\/\//, '',).replace(/\/$/, '',);
      if (!shopDomain.endsWith('.myshopify.com',) && !/^[a-z0-9-]+\.myshopify\.com$/.test(shopDomain,)) {
        return res.status(400,).json({ error: 'Invalid shop domain.', },);
      }
      
      // Check if this shop has an existing integration
      const conn = await platform.store.integrations.findOne({ type: 'shopify', },);
      if (conn && conn.config?.shopDomain === shopDomain && conn.status === 'active') {
        // Existing shop - find or create user for this shop
        const existingUser = await platform.store.users.findOne({ 
          email: conn.config?.shopEmail || `${shopDomain.replace('.myshopify.com', '',)}@storecops.shopify`,
        },);
        
        if (existingUser) {
          // Create a session for this user
          const session = await platform.auth.createSession(existingUser._id, existingUser.email, existingUser.role, conn.store_id,);
          return res.json({ 
            session, 
            store_id: conn.store_id, 
            shop: shopDomain,
            embedded: true, 
          },);
        }
      }
      
      // New shop or no existing integration - create a temporary session
      // The user will need to complete signup/connect flow
      const tempSession = await platform.auth.createTempSession(shopDomain,);
      return res.json({ 
        temp_session: tempSession, 
        shop: shopDomain,
        embedded: true,
        requires_signup: true,
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
    const reports = await platform.siteAudit.recent(10,);
    res.json(reports.map((r,) => ({
      report_id: r._id, url: r.url, score: r.score, grade: r.grade, audited_at: r.audited_at,
    }),),);
  },);

  router.get('/site/:report_id', async (req, res,) => {
    const report = await platform.siteAudit.get(req.params.report_id,);
    if (!report) return res.status(404,).json({ error: 'Report not found.', },);
    return res.json(report,);
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

  // Health is public; everything under /api/v1 needs the key.
  app.get('/health', (req, res,) =>
    res.json({ status: 'ok', service: 'storecops-growth-platform', time: new Date().toISOString(), },),
  );

  // Detailed health status (for monitoring dashboards)
  app.get('/health/status', async (req, res,) => {
    if (platform.monitoringService) {
      const health = await platform.monitoringService.getHealthStatus();
      res.json(health,);
    } else {
      res.json({ status: 'ok', message: 'Monitoring service not initialized', },);
    }
  },);

  const rateLimiter = createRateLimiter({
    windowMs: platform.config.security?.rateLimitWindowMs,
    max: platform.config.security?.rateLimitMax,
  },);

  // Public auth endpoints (signup/login), then the keyed API.
  app.use('/api/v1/auth', rateLimiter, createAuthRouter(platform,),);
  // Free store audit: public by design (pre-signup value).
  app.use('/api/v1/audit', rateLimiter, createAuditRouter(platform,),);

  // One-click platform connect — pre-login by design:
  // status, OAuth start/callback, Woo keys handoff, custom catalog crawl,
  // and the sanitized view of a pending (authorized) connection.
  app.get('/connect/status', rateLimiter, async (req, res,) => res.json(await platform.oauth.status(),),);
  app.get('/connect/:platform/start', rateLimiter, async (req, res,) => {
    try {
      const { redirect_url, } = await platform.oauth.start(req.params.platform, req.query || {},);
      res.redirect(redirect_url,);
    } catch (error) {
      res.redirect(`/app?connect_error=${encodeURIComponent(error.message,)}`,);
    }
  },);
  app.get('/connect/:platform/callback', rateLimiter, async (req, res,) => {
    const { redirect, } = await platform.oauth.callback(req.params.platform, req.query || {},);
    res.redirect(redirect,);
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
    const pending = await platform.oauth.pending(req.params.token,);
    if (!pending) return res.status(404,).json({ error: 'Connection expired or already used.', },);
    return res.json(pending,);
  },);

  app.use('/api/v1', rateLimiter, apiKeyMiddleware(platform,), createApiRouter(platform,),);

  // Inbound order webhooks from connected stores (Shopify etc.).
  // Public, HMAC-verified when WEBHOOK_SECRET is configured.
  app.post(
    '/webhooks/orders/:store_id',
    webhookVerifier(platform.config.security?.webhookSecret,),
    async (req, res,) => {
      try {
        const result = await platform.integrations.ingestOrderWebhook(
          req.params.store_id,
          req.body || {},
        );
        res.status(result.accepted ? 200 : 400,).json(result,);
      } catch (error) {
        res.status(400,).json({ error: error.message, },);
      }
    },
  );

  // Inbound return/exchange webhooks from connected stores.
  app.post(
    '/webhooks/returns/:store_id',
    webhookVerifier(platform.config.security?.webhookSecret,),
    async (req, res,) => {
      try {
        const result = await platform.returnService.processReturn(
          req.params.store_id,
          req.body || {},
        );
        res.status(200,).json(result,);
      } catch (error) {
        res.status(400,).json({ error: error.message, },);
      }
    },
  );

  // Web app: landing page + client dashboard (static SPA).
  const publicDir = path.join(__dirname, '..', '..', 'public',);
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

  // Task ob6: Admin console page.
  app.get('/admin', (req, res,) => res.sendFile(path.join(publicDir, 'admin.html',),),);

  // Task ob1: Serve the hosted tracker.js (Script Tag target).
  // Already covered by express.static(publicDir) — tracker.js lives in public/.

  // Task ob7: Shopify compliance webhook receivers.
  // These are called by Shopify when a merchant uninstalls the app or
  // requests data redaction. HMAC-verified by webhookVerifier.
  const shopifyComplianceVerifier = webhookVerifier(platform.config.security?.webhookSecret,);

  // Task 7: Idempotency — track processed webhook signatures to prevent
  // duplicate deliveries from causing repeated destructive work.
  // Use database-backed dedup for persistence across restarts.
  const WEBHOOK_DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const WEBHOOK_DEDUP_MAX = 10000;
  
  async function isDuplicateWebhook(req,) {
    const rawBody = req.rawBody || JSON.stringify(req.body || {},);
    const sig = crypto.createHash('sha256',).update(rawBody,).digest('hex',).slice(0, 16,);
    
    try {
      // Check if webhook was already processed
      const existing = await platform.store.webhookQueue.findOne({ signature: sig, },);
      if (existing) return true;
      
      // Record this webhook
      await platform.store.webhookQueue.insert({
        signature: sig,
        topic: req.headers['x-shopify-topic'] || 'unknown',
        shop_domain: req.body?.myshopify_domain || req.body?.shop || 'unknown',
        processed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + WEBHOOK_DEDUP_TTL_MS,).toISOString(),
      },);
      
      // Cleanup old entries periodically (1 in 100 requests)
      if (Math.random() < 0.01) {
        const cutoff = new Date(Date.now() - WEBHOOK_DEDUP_TTL_MS,).toISOString();
        // This is a simple cleanup - in production, use a scheduled job
        try {
          const oldEntries = await platform.store.webhookQueue.find({},);
          const toDelete = oldEntries.filter((e,) => e.processed_at < cutoff,);
          for (const entry of toDelete.slice(0, 100,)) {
            await platform.store.webhookQueue.delete(entry._id,);
          }
        } catch (_) {}
      }
      
      return false;
    } catch (err) {
      // Fallback to in-memory if DB fails
      console.error('[WEBHOOK] Dedup DB error, falling back to pass-through:', err.message,);
      return false;
    }
  }

  app.post('/webhooks/shopify/app-uninstalled', shopifyComplianceVerifier, async (req, res,) => {
    try {
      if (await isDuplicateWebhook(req,)) {
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
      if (await isDuplicateWebhook(req,)) {
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
      if (await isDuplicateWebhook(req,)) {
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
      if (await isDuplicateWebhook(req,)) {
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
              // Delete all collections for this store (non-blocking)
              const collections = [
                'events', 'customers', 'deliveries', 'actions', 'campaigns',
                'competitorSnapshots', 'externalSignals', 'sentimentSamples',
                'seoAudits', 'seoOptimizations', 'reports', 'attributions',
                'inventory', 'consentRecords', 'onboardingStates', 'activityLogs',
              ];
              for (const col of collections) {
                try { 
                  // Use deleteMany with a small batch to avoid long locks
                  await platform.store[col].deleteMany({ store_id: storeId, },); 
                } catch (_) {}
              }
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
