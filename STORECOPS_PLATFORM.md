# Storecops Growth Platform — Complete Technical Reference

> **Purpose**: This document is the single source of truth for the Storecops codebase. It is structured for AI-assisted development — paste this into any AI coding assistant to get immediate, accurate help with future development.

---

## 1. Vision & Product Summary

**Storecops** is an AI-driven SaaS growth platform for e-commerce stores (Shopify, WooCommerce, custom). It unifies customer intelligence, competitive monitoring, market trend analysis, automated messaging, SEO optimization, and revenue generation into a single 6-layer system.

**Core value proposition**: A store owner connects their store once → Storecops automatically monitors competitors, recovers abandoned carts, optimizes pricing, generates SEO fixes, forecasts demand, and sends recovery messages — all without manual intervention.

**Target users**: Shopify/WooCommerce store owners who want automated growth tools without juggling 10 separate apps.

**Business model**: Tiered SaaS subscription — Starter ($29/mo), Growth ($79/mo), Enterprise ($199/mo). Lead generation via free public audit tool that emails branded PDF reports.

---

## 2. Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js ≥ 18 (zero TypeScript, pure JavaScript) |
| Framework | Express.js 4.x |
| Database | SQLite (via Node.js experimental `node:sqlite`) for persistence; in-memory Map for tests |
| PDF Generation | PDFKit |
| Testing | Node.js built-in test runner (`node --test`) — NOT vitest, NOT jest |
| Shell | PowerShell (Windows) — use `;` not `&&` |
| Deployment | Docker (Alpine), Railway-ready with persistent volumes |
| Frontend | Vanilla JS (no React/Vue), Chart.js for visualizations |
| External APIs | Meta Ad Library, Resend (email), Meta WhatsApp Cloud API, Shopify Admin API |

**Dependencies**: Only 2 production dependencies — `express` and `pdfkit`. Everything else uses Node.js built-ins.

---

## 3. Architecture — 6-Layer Growth Loop

The platform follows a strict 6-layer architecture. Each layer only depends on layers below it. Layer 6 (the growth loop) is not a separate module — it's the wiring in `src/platform.js` that closes the loop.

```
Layer 6: Growth Loop (platform.js — orchestrates all layers)
    ↑
Layer 5: Reporting (attribution, reports, live orders)
    ↑
Layer 4: Execution (messaging, billing, consent, monitoring)
    ↑
Layer 3: Decision (rules, pricing, campaigns, segmentation)
    ↑
Layer 2: Intelligence (SEO, competitor intel, forecasting, churn, recommendations)
    ↑
Layer 1: Data Foundation (events, customers, inventory, competitors, signals)
```

**Data flow**: Layer 1 ingests raw data → Layer 2 analyzes it → Layer 3 decides what to do → Layer 4 executes actions → Layer 5 measures results → Layer 6 loops back.

---

## 4. Directory Structure

```
storecops-platform/
├── server.js                    # Entry point — boots platform, starts HTTP server
├── package.json                 # Dependencies: express, pdfkit
├── Dockerfile                   # Node 20 Alpine, production deploy
├── Procfile                     # web: node server.js
├── railway.json                 # Railway deployment config
├── .env.production              # Production env template
│
├── src/
│   ├── platform.js              # COMPOSITION ROOT — wires all layers together
│   ├── config/config.js         # All configuration from env vars
│   │
│   ├── layers/
│   │   ├── data/                # Layer 1: Data Foundation (7 files)
│   │   │   ├── customerProfile.js       # Unified customer profiles
│   │   │   ├── eventTracker.js          # Append-only event ingestion
│   │   │   ├── competitorIngestor.js    # Competitor data storage
│   │   │   ├── externalSignals.js       # Market signals (trends, news)
│   │   │   ├── sentimentCollector.js    # Brand sentiment sampling
│   │   │   ├── inventoryLedger.js       # Stock movements (purchase, sell, adjust)
│   │   │   └── searchConsole.js         # Google Search Console data
│   │   │
│   │   ├── intelligence/        # Layer 2: Intelligence (22 files)
│   │   │   ├── recommendationEngine.js  # Product recommendations (co-view + popularity)
│   │   │   ├── churnScoring.js          # Customer churn risk scoring
│   │   │   ├── channelOptimizer.js      # Best messaging channel per customer
│   │   │   ├── inventoryIntelligence.js # Stockout predictions, dead stock alerts
│   │   │   ├── seoAuditEngine.js        # Single-page SEO audit (public /audit)
│   │   │   ├── seoGrowth.js             # Search Console intent gap, content ideas
│   │   │   ├── seoAutoFix.js            # One-click SEO fix generator (HTML + Liquid)
│   │   │   ├── deepAudit.js             # Multi-page deep audit (30+ params, 5 categories)
│   │   │   ├── trendIntelligence.js     # Market trend detection + campaign drafting
│   │   │   ├── competitorIntelligence.js# Price drop/promo detection across competitors
│   │   │   ├── competitorScraper.js     # Shopify product scraper (products.json)
│   │   │   ├── demandForecast.js        # 7-day demand forecasting
│   │   │   ├── brandSentiment.js        # Brand health scoring
│   │   │   ├── productInsights.js       # Fast/slow/dead stock analysis
│   │   │   ├── defectionDetector.js     # Competitor-browsing customer detection
│   │   │   ├── seasonalAlerts.js        # Upcoming retail moment alerts
│   │   │   ├── adIntelligence.js        # Ad spend/strategy analysis
│   │   │   ├── metaAdLibrary.js         # Meta Ad Library scraper
│   │   │   ├── adminIntelligence.js     # Admin analytics & platform health
│   │   │   ├── paymentEngine.js         # Payment processing & subscription mgmt
│   │   │   ├── retentionEngine.js       # Customer retention scoring & strategies
│   │   │   └── revenueIntelligence.js   # Revenue analytics & forecasting
│   │   │
│   │   ├── decision/            # Layer 3: Decision (8 files)
│   │   │   ├── rulesEngine.js           # Custom trigger→action rules
│   │   │   ├── personalization.js       # Per-customer content personalization
│   │   │   ├── dynamicPricing.js        # Competitor-aware price recommendations
│   │   │   ├── orchestrator.js          # Event→decision routing, cooldown dedup
│   │   │   ├── segmentation.js          # Customer segmentation (VIP, new, at-risk)
│   │   │   ├── campaignGenerator.js     # Auto-draft campaigns from trends
│   │   │   ├── campaignLifecycle.js     # Campaign state machine (draft→active→complete)
│   │   │   └── sendTimeOptimizer.js     # Best time to send per customer
│   │   │
│   │   ├── execution/           # Layer 4: Execution (13 files)
│   │   │   ├── providers.js             # Multi-provider registry (email, WhatsApp, push)
│   │   │   ├── emailService.js          # Pluggable email (console/resend/smtp) + attachments
│   │   │   ├── emailTemplates.js        # HTML email templates (recovery, winback, digest)
│   │   │   ├── whatsappService.js       # Meta WhatsApp Cloud API + webhook parsing
│   │   │   ├── executionService.js      # Action queue processor
│   │   │   ├── websiteBot.js            # FAQ/intent-answering chatbot
│   │   │   ├── retargeting.js           # Cart/browse abandoner audience builder
│   │   │   ├── purchaseOrders.js        # Auto-generated supplier POs
│   │   │   ├── consentService.js        # GDPR/CCPA consent tracking
│   │   │   ├── billingService.js        # Shopify Billing integration
│   │   │   ├── monitoringService.js     # Failure detection + alerting
│   │   │   ├── notificationService.js   # Push/in-app notification dispatcher
│   │   │   └── pdfService.js            # Branded PDF report generator (PDFKit)
│   │   │
│   │   └── reporting/           # Layer 5: Reporting (3 files)
│   │       ├── attribution.js           # Revenue attribution per action/campaign
│   │       ├── reportingService.js      # ROI, maturity score, weekly digest
│   │       └── liveOrders.js            # Real-time order feed (SSE)
│   │
│   ├── server/                  # HTTP layer (15 files)
│   │   ├── createApp.js         # Express app factory — middleware, routing, public routes
│   │   ├── apiRoutes.js         # All /api/v1/* endpoints (behind API key)
│   │   ├── auth.js              # Signup, login, session management, API keys
│   │   ├── security.js          # Rate limiter, RBAC, webhook HMAC, GDPR export/delete
│   │   ├── storeAudit.js        # Public site audit (13 checks, no signup)
│   │   ├── integrations.js      # Store connection (Shopify snippet, webhook, CSV)
│   │   ├── oauthConnectors.js   # One-click OAuth connect (Shopify, WooCommerce)
│   │   ├── demoSeed.js          # Demo data seeder for dashboard testing
│   │   ├── secretRotation.js    # Secret fingerprint lifecycle tracking
│   │   ├── activityLog.js       # User activity audit trail
│   │   ├── dataExport.js        # GDPR data export endpoint
│   │   ├── onboardingService.js # New store onboarding wizard
│   │   ├── tieredRateLimiter.js # Per-plan rate limiting (Starter/Growth/Enterprise)
│   │   ├── twoFactorAuth.js     # TOTP-based 2FA for admin accounts
│   │   └── webhookRetryQueue.js # Failed webhook retry with exponential backoff
│   │
│   └── storage/
│       ├── store.js             # In-memory collection factory (Map-based CRUD)
│       └── sqliteStore.js       # SQLite adapter (same interface as in-memory)
│
├── public/                      # Frontend (vanilla JS, no framework)
│   ├── index.html               # Landing page (marketing, pricing, features)
│   ├── app.html                 # Main dashboard (SPA-like, tab-based)
│   ├── audit.html               # Public audit page (free, no signup)
│   ├── admin.html               # Admin console
│   ├── privacy.html             # Privacy policy
│   ├── terms.html               # Terms of service
│   ├── support.html             # Support center
│   ├── tracker-disclosure.html  # Tracker data disclosure (Shopify compliance)
│   ├── tracker.js               # Client-side tracking snippet (served to stores)
│   ├── favicon.svg              # Shield icon
│   ├── js/
│   │   ├── api.js               # Tiny API client (session in localStorage)
│   │   ├── app.js               # Main dashboard logic (tabs, charts, SEO optimizer)
│   │   ├── audit.js             # Audit page (deep audit, gated report, PDF download)
│   │   └── landing.js           # Landing page interactions
│   ├── styles/
│   │   ├── app.css              # Dashboard styles
│   │   └── landing.css          # Landing page styles
│   └── vendor/
│       └── chart.umd.min.js     # Chart.js (CDN-free)
│
└── test/                        # 24 test files, 200+ tests
    ├── adminIntel.test.js       # Admin intelligence analytics tests
    ├── api.test.js              # HTTP API integration tests
    ├── audit.test.js            # Public site audit tests
    ├── auth.test.js             # Auth service + HTTP auth tests
    ├── competitorScraper.test.js# Shopify scraper + Meta Ad Library tests
    ├── connect.test.js          # Store connection flow tests
    ├── deepAudit.test.js        # Deep audit engine + PDF service tests
    ├── integrations.test.js     # Integration snippet + CSV + webhook tests
    ├── layers.test.js           # All 6 layers unit tests
    ├── liveMonitoring.test.js   # Live orders SSE + insights tests
    ├── messagingRegression.test.js # Consent, suppression, dedup tests
    ├── payment.test.js          # Payment & subscription tests
    ├── persistence.test.js      # SQLite roundtrip + restart survival
    ├── pipeline.test.js         # End-to-end pipeline tests
    ├── platformFeatures.test.js # Platform feature integration tests
    ├── privacyRegression.test.js# GDPR export/delete/redact tests
    ├── queueShutdown.test.js    # Consent revocation + uninstall tests
    ├── retention.test.js        # Customer retention engine tests
    ├── revenue.test.js          # Revenue intelligence tests
    ├── securityRegression.test.js # Tenant isolation, rate limit, HMAC tests
    ├── seoOptimizer.test.js     # SEO auto-fix + AI optimization tests
    ├── toolkit.test.js          # Cross-layer feature tests
    ├── webhook.test.js          # Webhook idempotency tests
    └── whatsapp.test.js         # WhatsApp provider + webhook tests
```

---

## 5. Database Collections (42 total)

All collections use the same CRUD interface: `insert(doc)`, `findById(id)`, `find(query)`, `update(id, patch)`, `remove(id)`.

### Layer 1: Data Foundation
| Collection | Purpose |
|---|---|
| `events` | Append-only event log (page_view, add_to_cart, purchase, etc.) |
| `customers` | Unified customer profiles (merged by email/phone) |
| `competitorSnapshots` | Competitor product/price snapshots |
| `externalSignals` | Market trend signals |
| `sentimentSamples` | Brand sentiment samples |
| `inventory` | Stock ledger (movements, not just current state) |
| `searchConsole` | Google Search Console performance data |
| `competitorAds` | Meta Ad Library snapshots |
| `trackedCompetitors` | Competitor configs (URLs, page IDs, scrape status) |

### Layer 2: Intelligence
| Collection | Purpose |
|---|---|
| `seoAudits` | Single-page SEO audit results |
| `seoOptimizations` | Generated SEO + AI fix packages |
| `trendReports` | Market trend reports |
| `forecasts` | Demand forecast data |

### Layer 3: Decision
| Collection | Purpose |
|---|---|
| `rules` | Custom trigger→action rules |
| `actions` | Generated actions (messages, price changes) |
| `campaigns` | Campaign drafts |

### Layer 4: Execution
| Collection | Purpose |
|---|---|
| `deliveries` | Message delivery records |
| `purchaseOrders` | Supplier purchase orders |
| `retargetingAudiences` | Cart/browse abandoner audiences |

### Layer 5: Reporting
| Collection | Purpose |
|---|---|
| `attributions` | Revenue attribution records |
| `reports` | Generated reports |

### Security & Admin
| Collection | Purpose |
|---|---|
| `users` | RBAC accounts (signup users) |
| `auditLog` | Immutable admin action log |
| `sessions` | Bearer-token login sessions |

### Store Connections
| Collection | Purpose |
|---|---|
| `integrations` | Connected stores (Shopify/Woo/webhook/CSV) |
| `siteAudits` | Free public store audit reports |
| `connectors` | OAuth app credentials |
| `oauthStates` | In-flight OAuth CSRF states |
| `pendingConnections` | Pre-signup store connections |

### Compliance
| Collection | Purpose |
|---|---|
| `consentRecords` | Customer consent categories per installation |
| `channelSuppressions` | Per-channel opt-out |
| `emailSuppressions` | Global do-not-send list |

### Billing & Monitoring
| Collection | Purpose |
|---|---|
| `subscriptions` | Shopify Billing records |
| `monitoringEvents` | Failure events (webhook, worker, token, message) |
| `secretLedger` | Secret fingerprint lifecycle |

### Deep Audit & Reports
| Collection | Purpose |
|---|---|
| `deepAudits` | Comprehensive multi-page store audits |
| `reportRequests` | PDF report generation & delivery tracking |

---

## 6. API Endpoints

### Public Routes (no auth required)
| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/api/v1/auth/signup` | Create account |
| POST | `/api/v1/auth/login` | Login (returns bearer token) |
| POST | `/api/v1/audit/site` | Free 13-check site audit |
| GET | `/api/v1/audit/recent` | Recent audit reports |
| GET | `/api/v1/audit/site/:id` | Get specific audit |
| POST | `/api/v1/audit/deep` | **Deep audit (30+ params, summary only)** |
| GET | `/api/v1/audit/report/:id` | Full deep audit report (auth header checked inline) |
| GET | `/api/v1/audit/report/:id/pdf` | Download branded PDF (auth header checked inline) |
| POST | `/api/v1/audit/report/:id/email` | Email PDF report (auth header checked inline) |
| POST | `/api/v1/track` | Event ingestion (write-only ingest key) |
| GET | `/api/v1/connect/status` | Connection status per platform |
| POST | `/api/v1/connect/:platform/start` | Start OAuth connect |
| GET | `/api/v1/connect/pending/:token` | Check pending connection |

### Authenticated Routes (API key or bearer token)
All routes under `/api/v1` require `X-API-Key` or `Authorization: Bearer <token>`.

Key endpoints:
| Method | Path | Description |
|---|---|---|
| GET | `/dashboard/:store_id` | Full dashboard data |
| POST | `/events/track` | Track customer event |
| GET | `/customers/:store_id` | List customers |
| GET | `/recommendations/:store_id` | Product recommendations |
| GET | `/churn/:store_id` | Churn scores |
| POST | `/seo/audit` | SEO audit (single page) |
| POST | `/seo/optimize` | Full SEO optimization |
| POST | `/seo/one-click-fix` | One-click audit + fix |
| GET | `/seo/store-info/:store_id` | Auto-detect connected store |
| POST | `/seo/ai-optimize` | AI search optimization only |
| GET | `/competitors/:store_id` | List competitors |
| POST | `/competitors/:store_id` | Add competitor |
| GET | `/inventory/:store_id/analyze` | Inventory intelligence |
| POST | `/inventory/:store_id/purchase` | Record purchase |
| GET | `/orders/:store_id/live` | Live order feed |
| POST | `/rules/:store_id` | Create automation rule |
| POST | `/campaigns/:store_id/generate` | Generate campaign |
| GET | `/attribution/:store_id` | Revenue attribution |
| GET | `/reporting/:store_id` | Full report (ROI, maturity) |

---

## 7. Key Features (Built & Working)

### 7.1 Deep Audit & Branded PDF Reports
- **Public audit page** (`/audit`): Anyone enters a store URL → gets a summary score (grade A-F), category breakdowns (SEO, Performance, Security, Crawlability, AI Readiness), and top 3 issues
- **Deep crawl**: Fetches homepage, analyzes SEO (title, meta, H1, OG, JSON-LD, alt text, links), performance (TTFB, page weight, compression), security (HTTPS, 6 security headers), crawlability (robots.txt, sitemap, favicon, llms.txt), AI readiness (6 signals)
- **Gated full report**: Authenticated users see all checks, detailed findings
- **PDF download**: Multi-page branded PDF with Storecops branding, score rings, category bars, issue list, and **pricing plans page** (Starter $29, Growth $79, Enterprise $199)
- **Email delivery**: PDF attached to branded HTML email with score summary and CTA

### 7.2 One-Click SEO Optimization
- Connected store auto-detected (no manual URL entry)
- Single button: "Analyze & Fix Everything"
- Generates ready-to-apply code snippets (HTML meta tags, Shopify Liquid templates, Nginx configs)
- Covers: title, meta description, OpenGraph, JSON-LD schemas, robots.txt, security headers, viewport, heading structure, image alt text
- AI search optimization: llms.txt, FAQPage schema, entity markup (Organization/Store with sameAs), HowTo schema, BreadcrumbList schema

### 7.3 Competitor Intelligence
- Auto-scrape competitor Shopify stores via `/products.json`
- Meta Ad Library integration for ad monitoring
- Price drop and promotion detection
- Competitive positioning analysis

### 7.4 Customer Intelligence
- Unified profiles (merged by email/phone)
- Churn scoring (inactive customer detection)
- Defection detection (competitor-browsing customers)
- Segmentation (VIP, new, at-risk, browse abandoners)
- Product recommendations (co-view + popularity fallback)

### 7.5 Automated Execution
- Cart recovery (email + WhatsApp)
- Win-back campaigns (gone customers)
- Browse abandonment messages
- Dynamic pricing recommendations
- Purchase order generation
- Consent-aware messaging (GDPR/CCPA)

### 7.6 Store Connection
- Shopify: OAuth + Script Tag + Webhooks + Billing
- WooCommerce: REST API key exchange
- Custom: Webhook + tracking snippet
- CSV: Manual inventory import

### 7.7 Security & Compliance
- Multi-tenant isolation (store A can't read store B data)
- HMAC webhook verification
- Rate limiting (sliding window)
- Secret rotation with fingerprint tracking
- GDPR export/delete/customer redact
- PII masking in logs

### 7.8 Advanced Platform Features
- **Admin Intelligence** (`adminIntelligence.js`): Platform health metrics, user analytics, system performance monitoring
- **Payment Engine** (`paymentEngine.js`): Stripe/Razorpay integration, subscription lifecycle, invoice generation
- **Retention Engine** (`retentionEngine.js`): Customer lifetime value scoring, churn prevention strategies, loyalty program support
- **Revenue Intelligence** (`revenueIntelligence.js`): Revenue forecasting, cohort analysis, trend detection
- **Campaign Lifecycle** (`campaignLifecycle.js`): State machine for campaigns (draft→active→paused→completed→archived)
- **Email Templates** (`emailTemplates.js`): Pre-built HTML templates for cart recovery, win-back, welcome, and digest emails
- **Notification Service** (`notificationService.js`): Push and in-app notification dispatcher
- **Activity Log** (`activityLog.js`): Immutable user activity audit trail for compliance
- **Data Export** (`dataExport.js`): GDPR-compliant data export endpoint
- **Onboarding Service** (`onboardingService.js`): New store setup wizard with guided configuration
- **Tiered Rate Limiter** (`tieredRateLimiter.js`): Per-plan rate limits (Starter: 100/min, Growth: 300/min, Enterprise: 1000/min)
- **Two-Factor Auth** (`twoFactorAuth.js`): TOTP-based 2FA for admin accounts
- **Webhook Retry Queue** (`webhookRetryQueue.js`): Failed webhook retry with exponential backoff

---

## 8. Growth Loop (Layer 6)

The growth loop is the heartbeat of the platform, implemented in `platform.runGrowthCycle(store_id)`:

1. **Scan** (Layer 2→3): Orchestrator scans store for high-priority events
2. **Decide** (Layer 3): Rules engine, churn scoring, recommendations fire
3. **Execute** (Layer 4): Messages sent, prices adjusted, POs created
4. **Attribute** (Layer 5): Revenue attributed to actions
5. **Report** (Layer 5): ROI calculated, maturity scored
6. **Loop**: Results feed back into Layer 1 as new events

**Schedulers** (in `server/schedulers.js`):
- Growth cycle: periodic per-store
- Competitor scrape: every 6 hours
- Resync: periodic data refresh

---

## 9. Frontend Architecture

**No framework** — vanilla JavaScript with a simple tab-based SPA in `app.html`.

- `api.js`: Tiny API client. Session stored in `localStorage` as `storecops_session` (JSON: `{ storeId, apiKey, token, email }`). All requests include auth headers.
- `app.js`: Main dashboard. Tabs: Overview, Customers, Competitors, Inventory, SEO, Reports, Settings. SEO tab has the one-click optimizer.
- `audit.js`: Public audit page. Calls `POST /api/v1/audit/deep` (public), shows summary. If authenticated, fetches full report + enables PDF download + email.
- `landing.js`: Landing page interactions.

---

## 10. Testing

**Command**: `node --test "test/**/*.test.js"` (Node.js built-in test runner — NOT vitest/jest)

**200+ tests across 24 files**, all passing.

**Key conventions**:
- Tests use in-memory store (`STORAGE=memory` or `config.env = "test"`)
- Test mode bypasses API key middleware
- Each test creates its own platform instance for isolation
- Use unique store IDs per test to prevent cross-test contamination in SQLite
- Mock fetch with closure variable pattern for external API tests
- Integration tests boot a real HTTP server via `createApp()`

---

## 11. Configuration (Environment Variables)

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Environment (test/development/production) |
| `PORT` | `4000` | HTTP port |
| `API_KEY` | `dev-key` | Master API key |
| `PUBLIC_URL` | (empty) | Public-facing URL for OAuth callbacks |
| `STORAGE` | `sqlite` (prod) / `memory` (test) | Storage backend |
| `SQLITE_PATH` | `data/storecops.db` | SQLite file path |
| `EMAIL_PROVIDER` | `console` | Email provider (console/resend/smtp) |
| `WHATSAPP_PROVIDER` | `console` | WhatsApp provider (console/meta) |
| `RESEND_API_KEY` | — | Resend API key (for email) |
| `WHATSAPP_ACCESS_TOKEN` | — | Meta WhatsApp token |
| `WHATSAPP_PHONE_NUMBER_ID` | — | Meta WhatsApp phone number |
| `WEBHOOK_SECRET` | — | HMAC secret for webhooks |
| `DEFAULT_STORE_ID` | `store_demo` | Default tenant |
| `SESSION_TTL_DAYS` | `7` | Login session TTL |
| `CHURN_INACTIVE_DAYS` | `30` | Days before customer considered inactive |
| `FORECAST_WINDOW` | `7` | Demand forecast days |
| `COMPETITOR_SCRAPE_INTERVAL_HOURS` | `6` | Competitor scrape frequency |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_MAX` | `300` | Max requests per window |
| `SUBSCRIPTION_COST` | `49` | Monthly cost for ROI calculator |

---

## 12. Deployment

**Docker**: `Dockerfile` (Node 20 Alpine, production deps, health check)
**Railway**: `railway.json` (Docker build, healthcheck at `/health`, restart on failure)
**Persistent volume**: Mount at `/app/data` for SQLite survival across restarts

**Deploy steps**:
1. Push to GitHub
2. Connect Railway to repo
3. Add volume at `/app/data`
4. Set env vars: `NODE_ENV=production`, `API_KEY=<random>`, `PUBLIC_URL=<railway-url>`
5. Deploy — auto-builds from Dockerfile

---

## 13. Code Conventions

- **Pure JavaScript** — no TypeScript, no transpilation
- **`"use strict"` at top of every file**
- **Factory functions** — `createXxx({ store, config })` pattern (no classes)
- **Async/await** throughout — no callbacks, no .then()
- **Error handling** — throw Error with descriptive message, caught by `wrap()` in routes
- **Logging** — `console.log` with `[TAG]` prefix. PII masked (email: `j***@g***`).
- **No external dependencies** beyond express + pdfkit — use Node.js built-ins
- **Test command**: `node --test "test/**/*.test.js"` (PowerShell: use `;` not `&&`)

---

## 14. Extension Points

When adding new features, follow these patterns:

1. **New intelligence module**: Create `src/layers/intelligence/myModule.js` → export `createMyModule({ store, ...deps })` → wire in `platform.js`
2. **New API endpoint**: Add to `src/server/apiRoutes.js` inside `createApiRouter(platform)` using `wrap(async (req) => { ... })`
3. **New public endpoint**: Add to `createAuditRouter()` or create new public router in `createApp.js` (mounted BEFORE the keyed API)
4. **New collection**: Add name to `COLLECTIONS` array in `src/storage/store.js`
5. **New email template**: Add method to `emailService` (supports HTML + attachments)
6. **New test file**: Create `test/myFeature.test.js` — use `node --test` compatible assertions

---

## 15. Current Status

- **200+ tests passing** across 24 test files
- **72 source files** (src/)
- **15 frontend files** (public/)
- **42 database collections**
- **Fully deployable** to Railway/Docker
- **Production-ready** architecture with multi-tenant isolation, consent management, GDPR compliance, secret rotation, and monitoring
