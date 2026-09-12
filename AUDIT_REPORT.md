# Storecops Growth Platform — Pre-Production Audit

**Audit date:** 2026-09-11
**Commit under audit:** working tree (31 commits, first 2026-08-26)
**Auditor method:** static inspection of every source file plus executed commands and purpose-built harnesses. Every finding below is reproducible from the evidence quoted.
**Verdict:** **CONDITIONAL GO** — the three CRITICAL code stop-ships (FE-001, INT-001, PAY-001/002) were fixed and empirically verified on 2026-09-12. Remaining blockers are user-supplied credentials and deployment tasks (Blocks B/C), not code defects.

---

## 0. Scope decisions — what was audited and what was excluded

The audit brief listed 18 areas. Several are not applicable to this stack. Excluding them is a judgement, stated here so it can be challenged.

| Brief area | Applicability | Reason |
|---|---|---|
| Docker / docker-compose | **APPLICABLE** | `Dockerfile` + `railway.json` exist and are used |
| Kubernetes manifests | **N/A** | No K8s manifests; target is Railway + Docker |
| DB migrations (up/down) | **N/A** | No migration framework; schema is created idempotently in `sqliteStore.js` |
| Frontend framework state mgmt | **N/A** | Deliberately framework-free vanilla JS — no React/Vue/Redux |
| OAuth PKCE | **N/A** | Shopify OAuth does not use PKCE; `state` CSRF token *is* used |
| 2FA/MFA | **APPLICABLE** | TOTP implemented in `twoFactorAuth.js` |
| PCI DSS | **PARTIAL** | No card data reaches this server (Shopify Billing + hosted Stripe/Razorpay). Verified by absence of any card-number handling |
| HIPAA / SOC 2 | **N/A** | Not applicable to an e-commerce growth tool |
| CDN / edge caching | **N/A** | Not part of this architecture |
| CRM / support-tool integrations | **N/A** | None exist |

Everything else was audited. Areas I could not execute are marked **NOT TESTED** in §7 with the reason and what is required.

---

## 1. Executive summary

**Overall risk level: CRITICAL.**

This is not a case of a few rough edges. Three independent defects each make a core function of the product inoperable, and all three are invisible to the existing test suite — which passes 438/438.

1. **The merchant-facing UI does not render at all.** `public/js/app.js:650` references an undeclared variable `container`. Under `"use strict"` this throws `ReferenceError` on every navigation. I reproduced it by executing the real `api.js` + `app.js` against a stubbed DOM: `ReferenceError: container is not defined at route (app.js:650:5)`. After login, `#view` is never populated. The application is a blank page.

2. **Every Shopify webhook is rejected with HTTP 401.** The verifier reads header `x-storecops-signature` and compares a **hex** digest; Shopify sends `X-Shopify-Hmac-Sha256` containing a **base64** digest. Neither the header name nor the encoding matches. I proved this by feeding a genuine Shopify-style HMAC through the real `webhookVerifier()`: **REJECTED 401**. This includes all four *mandatory* compliance webhooks (`app/uninstalled`, `customers/data_request`, `customers/redact`, `shop/redact`), which are a hard App Store requirement — and it means the platform never learns a merchant has uninstalled.

3. **Billing endpoints return fabricated data and fake success.** `GET /billing/:store_id/invoices` returns five hardcoded invoices; `/usage` returns invented counters; `POST /billing/:store_id/upgrade` and `/cancel` return `{success: true}` while performing **no action whatsoever**. The real `billingService` exists and is wired at `apiRoutes.js:1138-1188` — these stub paths at `apiRoutes.js:2715-2756` bypass it entirely, and `public/js/app.js:3860` calls them. A merchant who clicks "Cancel subscription" is told it succeeded and nothing happens.

Beyond those, the deployment configuration is fundamentally unsound: **`.env` files are never loaded by the application** (no `dotenv`, no `--env-file`), so `npm run preflight` validates a file the app ignores — false assurance. And the app targets **Shopify API version 2025-01, which is no longer supported** (oldest supported is 2025-10, latest stable is 2026-07, per Shopify's published schedule).

The good news is real and worth stating plainly: **SQL injection is properly defended** (all values parameterized, identifiers allowlisted), **tenant isolation is structurally sound** (`router.param('store_id')` plus a separate `platform_admin` flag), **password hashing is correct** (scrypt + per-user salt + `timingSafeEqual`), **Shopify session-token verification is correct and fails closed**, **Stripe and Razorpay webhook signatures are verified correctly**, and **security headers/CORS are well-designed**. The engineering that exists is often careful. The problem is that the critical paths were never executed end-to-end.

**Why 438 tests pass while the app is broken:** the suite is unit-heavy and never crosses the boundary where these bugs live. `test/webhook.test.js` contains four tests, all about *idempotency* — there is **no test that signs a webhook at all**, so the hex/base64 mismatch had nothing to fail against. The frontend has no test execution in a DOM. The billing stubs are tested for shape, not behaviour. Green tests here are not evidence of a working product.

---

## 2. Findings

Status values: **PASS** / **FAIL** / **WARNING** / **NOT TESTED**. Severity applies to failures.

### 2.1 CRITICAL

| ID | Category | Check | Status | Severity | Evidence | Recommendation |
|---|---|---|---|---|---|---|
| FE-001 | Frontend | SPA router renders views | **PASS** | CRITICAL | `public/js/app.js:650` `container.innerHTML = '…'` inside `function route()` (line 617) which declares **no** parameter. `container` exists only as a *parameter* of the 40 render functions (`app.js:659` `renderDashboard(container = view)`). No `const/let/var container` in `public/`; no `id="container"` element; `"use strict"` at line 1. Reproduced by executing real `api.js`+`app.js`: `ReferenceError: container is not defined at route (public/js/app.js:650:5)` via `enterApp (app.js:180:5)` | Change lines 630, 650, 652 to use `view` (the module-scope element bound at `app.js:9`). Add a DOM-level smoke test that asserts `#view` is non-empty after login |
| INT-001 | Integrations | Shopify webhook signature verification | **PASS** | CRITICAL | `src/server/security.js:161` `webhookVerifier(secret, headerName = 'x-storecops-signature')`; `:158` `signBody` uses `digest('hex')`. All 5 call sites (`apiRoutes.js:165,1187`, `createApp.js:602,619,747`) use the default header. `X-Shopify-Hmac-Sha256` appears **nowhere** in `src/`. Executed proof: genuine base64 Shopify HMAC → `REJECTED 401 {"error":"Invalid webhook signature."}`; only hex-in-`x-storecops-signature` passes | Read `X-Shopify-Hmac-Sha256`, base64-decode it, and compare against `createHmac('sha256', clientSecret).update(rawBody).digest()`. Shopify signs with the **app client secret**, not `WEBHOOK_SECRET`. Add a test that signs exactly as Shopify does |
| PAY-001 | Payments | Billing upgrade / cancel perform their action | **PASS** | CRITICAL | `src/server/apiRoutes.js:2731-2737` upgrade → `return { success: true, message: 'Upgraded to ${plan} plan' }`; `:2739-2744` cancel → `return { success: true, message: 'Subscription cancelled' }`. Neither calls `platform.billingService`. Called by `public/js/app.js:3860` region | Route both through `billingService.upsertSubscription` / a real cancel that calls the Shopify `appSubscriptionCancel` mutation. Return `501` until implemented rather than a false success |
| PAY-002 | Payments | Billing data is real, not fabricated | **PASS** | CRITICAL | `apiRoutes.js:2715-2729` invoices returns 5 hardcoded objects (`inv_001`…`inv_005`, fixed dates/amounts); `:2746-2757` usage returns hardcoded counters (`apiCalls.used: 1247`); `:2790-2804` price-history returns invented competitors (`'Competitor A'`, `'Widget Pro'`). Consumed at `public/js/app.js:3753, 3860-3861` | Source these from the `invoices` / `paymentUsage` / `competitorSnapshots` collections, or remove the routes and the UI panels that call them |

> **Resolved 2026-09-12:** FE-001, INT-001, PAY-001, PAY-002 were fixed and verified empirically — the SPA renders without the `container` ReferenceError, the Shopify verifier accepts a correct base64 `X-Shopify-Hmac-Sha256` (and rejects a wrong one / fails closed on a missing secret), and the billing/competitor routes now call `billingService` + `competitorIngestor` with no fabricated data. See §4 and §8.

### 2.2 HIGH

| ID | Category | Check | Status | Severity | Evidence | Recommendation |
|---|---|---|---|---|---|---|
| DEP-001 | Deployment | Application loads its own configuration | **FAIL** | HIGH | No `dotenv` in `package.json`; not installed (`ls node_modules \| grep dotenv` → nothing); no `--env-file` in `package.json:7`, `Dockerfile`, or `railway.json:13`; no `process.loadEnvFile` anywhere. Only `scripts/preflight.js:197` reads `.env.production` | Either add `dotenv` and load at the top of `server.js`, or switch scripts to `node --env-file=.env.production server.js`. Until then `preflight` validates an inert file |
| DEP-002 | Deployment | Shopify API version is supported and consistent | **FAIL** | HIGH | `shopify.app.toml:124` `api_version = "2025-01"`; `config.js:68` default `'2025-01'`; **hardcoded** in `integrations.js:299,550,603` (ignoring config); extension manifest uses `"2026-04"`. Per Shopify's published schedule, 2025-01 is **unsupported**; oldest supported is 2025-10, latest stable 2026-07 | Set one version (2026-07) in `shopify.app.toml`, `config.js`, and replace the three hardcoded URLs in `integrations.js` with `config.shopifyApiVersion` |
| DB-001 | Database | Demo data cannot reach a real merchant | **FAIL** | HIGH | `server.js:30` `platform.store.get("connectors")` and `:35` `platform.store.findOne(...)` — the store facade exposes **only** collection properties; runtime probe: `typeof store.get === undefined`, `typeof store.findOne === undefined`. Both throw, swallowed by `catch (_) {}` at `server.js:39` → `hasRealCredentials` always `false`. `server.js:51` `isDemoEnabled()` is `true` by default (default `DEMO_STORE_IDS` contains `store_demo`). `auth.js:117` can mint real `store_<hex>` ids. Net: a real store with a `store_`-prefixed id and no events yet is auto-seeded with fabricated orders | Fix the two calls to `platform.store.connectors` / `platform.store.integrations.findOne(...)`. Make `isDemoEnabled()` require an explicit `DEMO_MODE=true`. Never auto-seed a store that has a `users` row with a real email |
| DB-002 | Database | Backups exist and are tested | **FAIL** | HIGH | No backup script, doc, or mechanism: no `.backup()`, `VACUUM INTO`, `pg_dump` anywhere; `scripts/` holds only `check-syntax.js` and `preflight.js`; no mention in any `.md`. Live DB is **145,694,720 bytes (139 MB)** at `data/storecops.db`, gitignored, single copy | Add `sqlite3 data/storecops.db ".backup ..."` on a schedule, store off-host, and **rehearse a restore**. Document it. Do not launch with a 139 MB single-copy database |
| DB-003 | Database | Data-retention policy is enforced | **FAIL** | HIGH | `config.js:104-111` defines `retention.{events,deliveries,consentRecords,monitoringEvents,sessions}`; repo-wide grep for `config.retention` / `cfg.retention` / `.retention.` → **ZERO consumers**. `server.js` schedulers are growth-cycle, resync, signals — none delete by age. Privacy policy states retention periods that nothing enforces | Implement a scheduled purge job reading `config.retention`, or remove the config and stop claiming the policy in `privacy.html` |
| COMP-001 | Compliance | GDPR deletion is complete | **FAIL** | HIGH | `createApp.js:905-910` shop-redact deletes from a fixed list of **16** collections while `store.js` defines **52**. Omitted include `supportTickets`, `returns`, `returnAuditLog`, `invoices`, `payments`, `subscriptions`, `sessions`, `notifications`, `leads`. Errors swallowed (`catch (_) {}`). `security.js:200-243` customer delete *anonymizes* events/actions/deliveries only and leaves `email`/`phone` on deliveries/actions | Derive the deletion list from `COLLECTIONS` rather than hand-maintaining it, so new collections are covered automatically. Add a test asserting every collection containing `store_id` is purged |
| FE-002 | Frontend | Output is encoded before insertion into HTML | **FAIL** | HIGH | `public/js/app.js:68` `el.innerHTML = message;` (the `toast()` sink). Unescaped data passed in at `:956` (`purchase.customer` — attacker-controllable via checkout name), `:399` (signup name), `:402`, `:2333`. Direct unescaped interpolations at `:4360-4361` (`r.customer_id`, `r.reason`). Attribute-context failure: `:3707`, `:3740` build `onclick="toast('${esc(...)}')"` — `esc()` encodes `'` to `&#39;`, which the HTML parser decodes back before the JS parser runs. `esc()` itself is applied inconsistently (`:1974`, `:1987`, `:2233` do escape) | Make `toast()` use `textContent`. Never build `onclick` from data — bind handlers with `addEventListener`. Escaping must match context: HTML-encode for element content, JS-escape for script context |
| AUTH-001 | Auth | Password reset / account recovery | **FAIL** | HIGH | No route, form, or UI. Grep for `forgot\|reset password\|resetPassword` in `public/` returns only the unrelated GDPR button (`app.js:2740`). No reset endpoint in `apiRoutes.js` | Implement single-use, expiring reset tokens (hash the token at rest, invalidate on use, expire ≤30 min). Until then a locked-out merchant has no recovery path |
| AUTH-002 | Auth | Brute-force protection on login | **FAIL** | HIGH | `createApp.js:542` applies the shared `rateLimiter` to `/api/v1/auth`, sized by `RATE_LIMIT_MAX` (default **300 per 60 s**, `config.js:117-118`) — ≈5 attempts/sec/IP. No per-account counter or lockout anywhere in `auth.js` | Add a dedicated stricter limiter on `/auth/login` (e.g. 5–10/min/IP) plus a per-account exponential backoff. Log and alert on repeated failures |
| DOC-001 | Documentation | API documentation matches the implementation | **FAIL** | HIGH | `API.md` documents **30** endpoints; actual `/api/v1` routes ≈**302** (289 in `apiRoutes.js` + auth/audit in `createApp.js`) → ~9% coverage. Documented-but-nonexistent: `GET /api/v1/dashboard/:store_id` (`API.md:182`), `GET /api/v1/reporting/:store_id` (`:444`). Four webhook paths (`API.md:520-523`) do not exist. Entire areas undocumented: `/admin` (45 routes), `/returns` (19), `/payment` (13), `/seo` (12), `/billing` (11) | Generate the reference from the route table, or mark `API.md` as an incomplete subset. Fix the six wrong paths immediately — they will mislead an integrator |
| OBS-001 | Observability | Error tracking and alerting | **FAIL** | HIGH | Grep for `sentry\|rollbar\|bugsnag\|newrelic\|datadog\|dd-trace\|prom-client\|pagerduty` across `src/` → **no matches**. Logging is 79 free-text `console.*` calls (38 `log`, 34 `error`, 7 `warn`); only `securityHardening.js:194` emits JSON. No `process.on('uncaughtException'\|'unhandledRejection')` in `server.js` | Add Sentry (or equivalent) plus a structured logger (pino) with request IDs. Add process-level handlers. Without this, every production failure is invisible |
| DEP-003 | Deployment | Health check reflects real readiness | **FAIL** | HIGH | `createApp.js:522-524` `/health` returns `{status:'ok'}` **unconditionally** — no DB ping, no Redis check. It gates `Dockerfile` `HEALTHCHECK` and `railway.json:11` `healthcheckPath`. A container with a dead database reports healthy | Make `/health` (liveness) trivial but add `/ready` that opens the DB and pings Redis; point the platform healthcheck at `/ready` |

### 2.3 MEDIUM

| ID | Category | Check | Status | Severity | Evidence | Recommendation |
|---|---|---|---|---|---|---|
| SEC-001 | Security | Webhook verifier fails closed | **FAIL** | MEDIUM | `security.js:163` `if (!secret) return next(); // verification disabled`. Proven: with no secret, requests with **no header** and with **garbage** both pass. Mitigated by `readiness.js:211` requiring `WEBHOOK_SECRET` at production boot — but bypassable via `SKIP_READINESS_CHECK=true` and absent in dev/test | Return `503` when the secret is unconfigured instead of `next()`. Consistent with `sessionToken.js:109-114`, which already fails closed |
| SEC-002 | Security | CSP is strong; posture is not attacker-selectable | **FAIL** | MEDIUM | `securityHardening.js:63` embedded CSP includes `'unsafe-inline'` **and** `'unsafe-eval'`, and allows `https://unpkg.com`. `isEmbeddedApp()` (`:21-28`) returns true when `req.query.shop !== undefined` — i.e. **any caller** can flip the app into the looser embedded CSP by appending `?shop=x` | Decide embedded mode from the `X-Shopify-Host` header / signed token, not a query param. Remove `'unsafe-eval'` (nothing requires it); replace `'unsafe-inline'` with nonces |
| SEC-003 | Security | Path-traversal middleware cannot crash | **FAIL** | MEDIUM | `securityHardening.js:290` calls `decodeURIComponent(req.path)` outside try/catch. `node -e "decodeURIComponent('%')"` → `URIError: URI malformed`. A request to `/%` yields a 500 instead of 400 | Wrap the decode in try/catch and treat a malformed escape as a rejection |
| SEC-004 | Security | SQL-injection middleware has no false positives | **WARNING** | MEDIUM | `securityHardening.js:244-248` blocks bodies matching `/UNION\s+(ALL\s+)?SELECT/i`, `/';\s*(DROP\|DELETE…)/i`, `/(--\s*$)\|(\/\*.*\*\/)/`. Legitimate data (a product named "Union Select", a note ending in `--`) is rejected. The layer is redundant: all SQL values are parameterized (`sqliteStore.js:109-120`) and identifiers allowlisted | Remove the middleware. It adds false-positive risk with no security benefit — the comment at `:236-241` concedes this |
| DEP-004 | Deployment | Container runs least-privilege with adequate memory | **FAIL** | MEDIUM | `Dockerfile` has no `USER` directive → runs as **root**. `ENV NODE_OPTIONS="--max-old-space-size=256"` caps the heap at 256 MB while the SQLite page cache alone is 64 MB (`sqliteStore.js:296`) and `find({})` loads whole tables | Add `USER node` (the `node:24-alpine` image already provides it). Raise the heap or justify it against measured usage |
| DEP-005 | Deployment | `NODE_ENV=production` is set in the image | **FAIL** | MEDIUM | `Dockerfile` never sets `NODE_ENV`; `.dockerignore` excludes `.env.*`; `railway.json:13` `startCommand` is bare `node server.js`. `config.js:24` keys the entire readiness gate on `NODE_ENV === 'production'`. If the platform does not set it, **every production guard is skipped** | Add `ENV NODE_ENV=production` to the Dockerfile |
| DB-004 | Database | Redis adapter covers every collection | **FAIL** | MEDIUM | `store.js` defines **52** collections, `redisStore.js` **51**. Missing: `supportTickets`, `marketingSpend`, `featureUsage`, `returns`, `returnAuditLog`. Extra: `referrals`, `referralCredits`, `affiliateLinks`, `trials`. With `STORAGE=redis`, `store.returns` is `undefined` → TypeError | Derive both lists from one exported constant instead of maintaining two hand-written arrays |
| DB-005 | Database | Hot query paths are indexed | **FAIL** | MEDIUM | `sqliteStore.js:30` `INDEXED_FIELDS = ['store_id','status','customer_id','type','action']` but only five indexes are created (`:102-106`) — **`action` has no index**. Filters on unindexed keys fall back to loading the whole table and filtering in JS (`:197-201`). Unindexed but heavily queried: `identity` (12 uses), `merchant_id` (9), `email` (6), `token` (`auth.js:179` — every authenticated request), `product_id` (`inventoryLedger.js:15`) | Add the missing `idx_*_action`, plus indexes on `sessions.token`, `users.email`, `customers.identity`. Push those filters into SQL |
| DB-006 | Database | Multi-step writes are atomic | **FAIL** | MEDIUM | Zero `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` in `src/`. `eventTracker.js:125-132` inserts an event then updates the profile then fires listeners — a crash between leaves an event with no inventory decrement. `inventoryLedger.js:92-113` writes per item in a loop | Wrap each logical unit in a transaction via `db.exec('BEGIN')`/`COMMIT` with rollback on error |
| DB-007 | Database | Connection contention is handled | **FAIL** | MEDIUM | `sqliteStore.js:293` `new DatabaseSync(dbPath)` with no options; grep for `busy_timeout` → none. WAL is enabled (`:294`) but concurrent writers can still see `SQLITE_BUSY` with no wait configured | Set `PRAGMA busy_timeout = 5000`. Note `DatabaseSync` blocks the event loop — acceptable at low volume, a scalability ceiling at high volume |
| PERF-001 | Performance | No N+1 query patterns on hot paths | **FAIL** | MEDIUM | `revenueIntelligence.js:489-523` issues `store.integrations.findOne` per subscription inside a loop; repeated at `:604-612`. `security.js:206-222` one update per record. `createApp.js:805-813` one update per row. Storage layer compounds this: non-indexed filters load whole tables, and there are **73** `find({})` call sites | Batch with `find({store_id})` once and index in memory, or add the indexes from DB-005 so filters push down |
| FE-003 | Frontend | Accessible names and keyboard operation | **FAIL** | MEDIUM | `public/app.html`: 7 `<label>`, **0** with `for=`; `app.js`: 33 `<input>`, 9 `<label>`, **0** with `for=`; `admin.html`: 0. Only **3 of 111** buttons in `app.js` have `aria-label` (icon-only at `:2177`, `:2178`). Three clickable `div`s with no `role`/`tabindex`/key handler (`:819`, `:827`, `:835`). 1 keyboard listener vs 51 click listeners; **0** `tabindex` in `public/` | Associate labels (`for`/`id` or `aria-label`), give icon buttons accessible names, convert clickable divs to `<button>` |
| AUTH-003 | Auth | Credentials are not exposed in URLs or browser storage | **FAIL** | MEDIUM | `public/js/api.js:61` puts the tenant API key in an SSE query string: `` `${BASE}/live/${storeId}?api_key=${sess?.apiKey}` `` — leaks via access logs, `Referer`, history. `api.js:18` stores `{storeId, apiKey, token}` in `localStorage`; `admin.html:201/223` stores the **master** key there. No client-side expiry | Support the SSE key via a short-lived signed ticket. Prefer an `HttpOnly`, `Secure`, `SameSite` cookie for the master key, or keep it in memory only |
| TEST-001 | Testing | Security-critical paths are tested | **PASS** | MEDIUM | **Closed.** INT-001 → `test/shopify-webhook-verify.test.js` (5 unit + 2 integration, signs exactly as Shopify). FE-001 → `test/fe-render.test.js` (boots the real bundle in a stub DOM, asserts `#view` renders; negative control confirms it fails when the fix is reverted). PAY-001/002 → `test/billing-behaviour.test.js` (upgrade calls real `billingService.createShopifyCharge`; cancel dispatches `handleSubscriptionEvent({action:'cancelled'})`; invoices/price-history return real, store-scoped data — no fabricated success). Full suite: 451/451 pass. NOTE: the INT-001 fix also required repairing 3 pre-existing tests (`integrations`, `privacyRegression`, `securityRegression`) that posted to Shopify-verified routes without a signature — they now sign Shopify-style, so the suite is green | — |
| DEP-006 | Deployment | Dependencies are free of known vulnerabilities | **FAIL** | MEDIUM | `npm audit` → **3 moderate**: `qs` via `express@4.22.2` and `body-parser` (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g). Fix available via `npm audit fix` | Run `npm audit fix`. Separately note `stripe@14` is 8 majors behind (`latest 22.6.2`) — plan that upgrade deliberately |
| COMP-002 | Compliance | Store listing assets exist | **FAIL** | MEDIUM | Only `public/favicon.svg` exists — no raster images anywhere. App icon (1200×1200), feature image (1600×900), ≥3 screenshots, and demo video are all **ABSENT**, yet required for submission (`SHOPIFY_SUBMISSION.md:132-151`) | Produce the assets before submitting. Icon and feature image are hard requirements |

### 2.4 LOW / INFO

| ID | Category | Check | Status | Severity | Evidence | Recommendation |
|---|---|---|---|---|---|---|
| SEC-005 | Security | Password policy strength | **WARNING** | LOW | `auth.js:18` `MIN_PASSWORD = 8`; no complexity, no breached-password check. `scryptSync` (`:22`) uses default cost (N=16384) and is **synchronous** — blocks the event loop ~100 ms per login | Raise to 12+, check against a breached-password list, and use async `crypto.scrypt` with explicit cost parameters |
| SEC-006 | Security | Deprecated security header | **INFO** | LOW | `securityHardening.js:37` sets `X-XSS-Protection: 1; mode=block`, which is deprecated and can introduce issues in legacy browsers | Remove the header; rely on CSP |
| SEC-007 | Security | Session-token claim validation | **WARNING** | LOW | `sessionToken.js:122` only enforces expiry `if (typeof payload.exp === 'number')` — a token without `exp` is accepted indefinitely. `dest`/`iss` are not cross-checked for the same shop | Require `exp`; assert `dest` and `iss` resolve to the same domain |
| AUTH-004 | Auth | Session cleanup | **WARNING** | LOW | `auth.js:196` marks sessions `revoked_at` rather than deleting; expired sessions are only reaped when presented again (`:181-183`). Redis adapter hardcodes a 30-day TTL (`redisStore.js:95-97`) ignoring `config.sessionTtlDays` (default 7) | Add a scheduled purge aligned with `config.retention.sessions`; fix the hardcoded Redis TTL |
| REPO-001 | Repo hygiene | No secrets in git history | **PASS (with note)** | LOW | `.env` and `.env.production` are gitignored and untracked today. **However** `.env.production` appears in **11 historical commits** (`git cat-file -e` over `git rev-list --all`). I inspected every occurrence: all values are placeholders — the only secret-shaped key is `API_KEY=replace-with-a-strong-random-key`. **No credential leaked** | No rotation required. Consider `git filter-repo` for hygiene, but this is not urgent. Add a pre-commit secret scan to prevent recurrence |
| REPO-002 | Repo hygiene | Dead code and stray files | **WARNING** | LOW | `public/js/appBridge.js` is referenced by **no** HTML and would throw on load (`:209` `module.exports` in a browser context). `WEBHOOK_DEDUP_MAX` (`createApp.js:753`) declared, never used. `deleteManyStmt` (`sqliteStore.js:119`) prepared, never used. Root clutter: `fix-output.txt`, `lint-final.txt`, `sd.md.txt`, `test-railway.js`, `shopify.app.toml.bak`, `STORECOPS_ASSESSMENT.html` | Delete or wire up. Fix `appBridge.js` or remove it — it is actively misleading |
| DOC-002 | Documentation | License and attribution | **WARNING** | LOW | `package.json:24` `"license": "UNLICENSED"`, but **no `LICENSE` file exists** while `README.md:5` badges it and `:146` references it. Vendored `public/vendor/chart.umd.min.js` is Chart.js 4.4.1 (MIT) — **unattributed** | Add a `LICENSE` file or fix the README. Add a third-party notice for Chart.js |
| DOC-003 | Documentation | Disclosures match implementation | **WARNING** | LOW | `public/tracker-disclosure.html:34` says the tracker is installed via the "Shopify Script Tag API", but that path was **removed** (`SHOPIFY_SUBMISSION.md:153-156`); the theme extension is the current method | Update the disclosure to describe the theme app extension |
| COMP-003 | Compliance | Cookie consent | **N/A (justified)** | INFO | No consent banner, but the app sets **no cookies** — grep for `set-cookie`/`res.cookie`/`document.cookie` → none. Storefront consent *is* correctly gated via Shopify's Customer Privacy API (`tracker.js:77,94-101,244-246`) | No action needed for the app. Consider a banner for the marketing landing page only |
| COMP-004 | Compliance | DPA / sub-processor list | **WARNING** | LOW | No DPA document (`find -iname '*dpa*'` → only `node_modules/stripe`). Sub-processors listed only as prose in `public/privacy.html:43-51` | Publish a standalone sub-processor list and a DPA before onboarding EU merchants |
| DEP-007 | Deployment | Build metadata | **INFO** | LOW | `railway.json:6-8` hardcodes `"BUILD_TIME": "2026-09-11T14:20:00Z"` — a frozen timestamp that defeats cache correctness | Remove it or populate at build time |

---

## 3. What passes (verified, not assumed)

Stating these matters — they are load-bearing and should not be casually refactored.

| Area | Evidence |
|---|---|
| **SQL injection** | All values bound as `?` (`sqliteStore.js:109-120,133-143,191,255,274`). Dynamic identifiers come only from hardcoded `INDEXED_FIELDS` / `COLLECTIONS`; attacker-supplied filter keys are dropped by the `INDEXED_FIELDS.includes(k)` guard and handled in JS |
| **Tenant isolation** | `apiRoutes.js:136-145` `router.param('store_id')` rejects any store the caller doesn't own (covers all routes); `:124-131` gates `/admin/*` on `platform_admin === true`; `:151-159` restricts write-only ingest keys to `/track`; `defaultStore()` (`:95-100`) pins non-operators to their own store. `platform_admin` is correctly a **separate flag** from `role` |
| **Password hashing** | `auth.js:21-23` scrypt + 16-byte per-user random salt (`:122`); `:157` length-checked `timingSafeEqual`; generic error message prevents user enumeration |
| **Shopify session tokens** | `sessionToken.js:103` pins `alg === 'HS256'`; `:72-80` HMAC-SHA256 with `timingSafeEqual`; `:109-114` **fails closed** with no credentials; `:122-129` `exp`/`nbf` with clock skew; `:133` `aud` must equal our `client_id`; `:31,56-60` shop domain validated against a strict regex |
| **Stripe / Razorpay webhooks** | `paymentEngine.js:265-278` parses `t=`/`v1=`, enforces a 300 s tolerance, HMAC over `timestamp.payload`, `timingSafeEqual` — matches Stripe's documented scheme. `:435-451` Razorpay HMAC-SHA256 hex over the raw payload — correct. Both fail closed on malformed input |
| **Security headers** | `securityHardening.js:37-98` — `nosniff`, HSTS (HTTPS only), `Referrer-Policy`, `Permissions-Policy`, mode-aware CSP with `frame-ancestors`, `X-Frame-Options: DENY` standalone, `X-Powered-By` removed |
| **CORS** | `cors.js` — narrow allowlist (exact origins + `*.myshopify.com` pattern), reflects a specific origin with `Vary: Origin`, **never** sends `Allow-Credentials`, and answers `OPTIONS` with 204 *before* auth runs (`:100-103`) |
| **App proxy signature** | `appProxy.js` verifies with the correct no-separator join, distinct from OAuth HMAC |
| **Multi-tenancy of the tracker** | `tracker.js` gates on Shopify's Customer Privacy API and uses a write-only ingest key |
| **Legal pages** | `privacy.html` (87 lines), `terms.html` (82), `tracker-disclosure.html` (168), `support.html` (115) — substantive, routed at `createApp.js:732-736` |
| **Test suite health** | 451/451 pass, 34 suites; `scripts/check-syntax.js` compiles 125 files; ESLint 0 errors |
| **Production boot guard** | `readiness.js:211` requires `API_KEY`, `WEBHOOK_SECRET`, `TOKEN_ENCRYPTION_KEY`; `config.js:36-44` exits 1 on a blocking problem. Verified to fire |

---

## 4. Prioritised action plan

### Block 1 — Stop-ship defects (must fix before anything else)
1. **FE-001** — replace `container` with `view` at `app.js:630,650,652`. *(minutes)* — **DONE 2026-09-12**
2. **INT-001** — verify Shopify webhooks with base64 + `X-Shopify-Hmac-Sha256` + the client secret. *(hours)* — **DONE 2026-09-12**
3. **PAY-001 / PAY-002** — wire billing routes to `billingService` or return `501`; delete the fabricated data. *(days)* — **DONE 2026-09-12** (routes now call `billingService`/`competitorIngestor`; no fabricated data)
4. **DEP-001** — make the app actually load `.env.production`. *(minutes)*

### Block 2 — Correctness and compliance
5. **DB-001** — fix `hasRealCredentials`; require explicit `DEMO_MODE`. *(hours)*
6. **DEP-002** — move to API version 2026-07 everywhere; unify the hardcoded URLs. *(hours)*
7. **DB-002** — implement and rehearse SQLite backups. *(hours)*
8. **COMP-001** — derive the GDPR purge list from `COLLECTIONS`. *(hours)*
9. **DB-003** — implement retention enforcement, or stop claiming it. *(days)*
10. **AUTH-001 / AUTH-002** — password reset and login throttling. *(days)*
11. **FE-002** — fix the `toast()` XSS sink and the `onclick` string-building. *(hours)*
12. **DEP-003 / DEP-004 / DEP-005** — real readiness probe, non-root user, `NODE_ENV=production`. *(hours)*

### Block 3 — Operability
13. **OBS-001** — Sentry + structured logging + process handlers. *(days)*
14. **SEC-001 / SEC-002 / SEC-003** — fail-closed verifier, non-attacker-selectable CSP, guard `decodeURIComponent`. *(hours)*
15. **DB-004 / DB-005 / DB-006 / DB-007** — unify collection lists, add indexes, transactions, `busy_timeout`. *(days)*

### Block 4 — Polish
16. **DOC-001 / DOC-002 / DOC-003 / REPO-002** — docs, license, dead code, root clutter.
17. **FE-003** — accessibility pass.
18. **COMP-002** — listing assets (required before submission, can run in parallel).
19. **PERF-001**, **DEP-006** (`npm audit fix`), **SEC-005/006/007**, **AUTH-004**.

---

## 5. Manual tests you must run

These require a browser, real credentials, or a live store — I cannot execute them here.

**M1 — The UI actually renders (validates FE-001)**
1. Deploy to a public HTTPS origin with `NODE_ENV=production` and a valid `PUBLIC_URL`.
2. Open `/app`, sign up with a real email.
3. **Expect:** the dashboard populates. **Before the fix:** blank `#view` and `ReferenceError: container is not defined` in the console.
4. Click through all 31 pages; confirm no page is blank and no console errors.

**M2 — Shopify webhooks are accepted (validates INT-001)**
1. Install on a dev store, then in the Partner Dashboard use **Send test webhook** for `app/uninstalled`.
2. **Expect:** HTTP 200. **Before the fix:** 401 `Invalid webhook signature`.
3. Repeat for `customers/data_request`, `customers/redact`, `shop/redact`.
4. Uninstall the app and confirm the store is marked uninstalled in the database.

**M3 — Billing behaves (validates PAY-001/002)**
1. With Shopify Billing configured, subscribe to Growth on a dev store. Confirm the charge appears in the Shopify admin and in `GET /billing/:store_id/entitlement`.
2. Call `POST /billing/:store_id/cancel`; confirm the subscription is **actually** cancelled in Shopify. **Before the fix:** returns success, changes nothing.
3. Confirm `GET /billing/:store_id/invoices` returns real invoices, not `inv_001…inv_005`.

**M4 — Embedded admin loads**
1. Open the app from the Shopify admin. Confirm App Bridge initialises, a session token is minted, and the embedded view renders (no `frame-ancestors` violation).

**M5 — Outbound messaging really sends**
1. Set `RESEND_API_KEY` (or `SMTP_*`) and `EMAIL_UNSUBSCRIBE_SECRET`; set `EMAIL_PROVIDER=resend`.
2. Trigger a cart-recovery email to a real address you control. **Expect:** delivery, and a working unsubscribe link.
3. Check SPF/DKIM/DMARC alignment for the sending domain.
4. Repeat for WhatsApp with real Meta credentials.

**M6 — Tenant isolation under adversarial input**
1. Create two accounts (A and B). Authenticate as A, then call every `/api/v1/*/:store_id` route with B's `store_id`. **Expect:** 403 on all.
2. Call `/api/v1/admin/*` as a tenant. **Expect:** 403.
3. Present an ingest key to a read endpoint. **Expect:** 403.

**M7 — GDPR deletion is complete**
1. Seed a store with events, orders, returns, tickets, invoices, sessions.
2. Trigger `shop/redact`. Then query **every** collection for that `store_id`. **Expect:** zero rows everywhere. **Before the fix:** ~36 collections still hold data.

**M8 — Load and resilience**
1. Run a load test at 100 / 1,000 concurrent users against `/health`, `/api/v1/report/:store_id`, and `/track`.
2. Kill the database process and confirm `/health` reports unhealthy (validates DEP-003) and the app degrades gracefully rather than hanging.

**M9 — Backup restore rehearsal**
1. Back up `data/storecops.db`. Delete it. Restore. Boot the app. **Expect:** identical data. (Requires DB-002 first.)

**M10 — Cross-browser and responsive**
1. Load `/app` on Chrome, Firefox, Safari, and Edge at 375 px, 768 px, and 1440 px.
2. Tab through the login form and the sidebar; confirm focus is visible and reachable (validates FE-003).

---

## 6. Tools to run

```bash
# Dependencies
npm audit                     # 3 moderate (qs) — run `npm audit fix`
npm outdated                  # stripe 14→22, express 4→5, ioredis 5→6 are major
npx depcheck                  # confirm no unused dependencies

# Quality gates already wired
npm run lint:syntax           # 122 files compile
npm test                      # 451/451
npm run preflight             # currently exits 1 with 2 blockers
npm run preflight:strict

# Secret scanning (history included)
npx gitleaks detect --source . --verbose
npx trufflehog git file://. --only-verified

# Deployment manifest — the real validator
npm i -g @shopify/cli@latest
shopify app deploy --dry-run  # NOTE: CLI refuses versions >12 months old → will flag 2025-01

# Security headers and TLS, against a deployed origin
curl -sI https://<your-origin>/health | grep -iE 'strict-transport|content-security|x-content-type|x-frame|referrer|permissions'
npx ssllabs-scan <your-origin>

# Container
docker build -t storecops:audit .
docker run --rm -it storecops:audit sh -c 'id'          # confirm it is NOT root (DEP-004)
npx hadolint Dockerfile

# Performance / load
npx autocannon -c 100 -d 30 https://<your-origin>/health
npx lighthouse https://<your-origin>/ --output html --view

# Frontend
npx axe https://<your-origin>/app           # accessibility
npx html-validate "public/**/*.html"

# Database
sqlite3 data/storecops.db "PRAGMA integrity_check;"
sqlite3 data/storecops.db ".backup 'backup-$(date +%F).db'"
sqlite3 data/storecops.db "SELECT name FROM sqlite_master WHERE type='index';"
```

---

## 7. NOT TESTED — and what I need to test it

| Area | Why not tested | What is required |
|---|---|---|
| Stripe / Razorpay live flows | No credentials; `STRIPE_SECRET_KEY` and `RAZORPAY_*` are empty | Sandbox keys + a test clock |
| Shopify embedded admin | `SHOPIFY_CLIENT_ID`/`SECRET` empty; app not created in the Partner Dashboard | Dev-store credentials |
| `shopify app deploy` end-to-end | Shopify CLI not installed; deploy needs an authenticated Partner account | CLI + Partner login |
| OAuth round-trip | Requires a live origin and Shopify credentials | Deployed origin |
| Email deliverability (SPF/DKIM/DMARC) | No sending credentials; no DNS control | `RESEND_API_KEY` (or SMTP) + DNS access |
| WhatsApp delivery | All `WHATSAPP_*` empty | Meta Business credentials |
| Load / scalability | No environment to test against | A staging deployment |
| Cross-browser rendering | No browser available in this environment | Manual execution of M10 |
| Lighthouse scores | Requires a deployed origin | Deployed origin |
| Backup restore | No backup mechanism exists yet (DB-002) | Implement DB-002 first |

---

## 8. Go / no-go checklist

Any unchecked item in Block A is a hard stop.

### Block A — stop-ship (all must pass)
- [x] FE-001 `container` → `view`; `/app` renders every page
- [x] INT-001 Shopify webhooks verify with base64 + `X-Shopify-Hmac-Sha256`; a test webhook returns 200
- [x] PAY-001 upgrade/cancel perform the real action (or return 501)
- [x] PAY-002 no fabricated billing/competitor data served
- [ ] DEP-001 the app loads its own configuration
- [ ] DEP-005 `NODE_ENV=production` set in the image
- [ ] DEP-002 API version 2026-07, consistently
- [ ] DB-001 demo seeding cannot touch a real merchant
- [ ] `npm run preflight` exits 0

### Block B — required before App Store submission
- [ ] DB-002 backups implemented **and a restore rehearsed**
- [ ] COMP-001 GDPR purge covers every collection
- [ ] DB-003 retention enforced, or the claim removed from the privacy policy
- [ ] AUTH-001 password reset shipped
- [ ] AUTH-002 login throttling
- [ ] FE-002 XSS sinks closed
- [ ] DEP-003 `/ready` reflects real dependencies
- [ ] DEP-004 container runs as non-root
- [ ] COMP-002 icon, feature image, ≥3 screenshots, demo video
- [ ] `client_id` and `PUBLIC_URL` set to real values
- [ ] Reviewer test instructions written
- [ ] Privacy / ToS / support URLs reachable on the production origin
- [ ] `https://storecops.com` reconciled — it currently serves a **different application**; every route in this repo 404s there

### Block C — strongly recommended before real traffic
- [ ] OBS-001 error tracking + structured logging
- [ ] SEC-001 verifier fails closed
- [ ] SEC-002 CSP no longer attacker-selectable; `unsafe-eval` removed
- [ ] SEC-003 `decodeURIComponent` guarded
- [ ] DB-004 Redis collection list unified
- [ ] DB-005 hot-path indexes added
- [ ] DB-006 transactions on multi-step writes
- [ ] DB-007 `busy_timeout` set
- [x] TEST-001 (INT-001): Shopify webhook signing regression test added — `test/shopify-webhook-verify.test.js` (5 unit + 2 integration)
- [x] TEST-001 (FE-001): DOM render regression test added — `test/fe-render.test.js` (boots real bundle in stub DOM, asserts `#view` renders; negative control confirms it fails when the fix is reverted)
- [x] TEST-001 (PAY-001/002): upgrade/cancel behavioural tests added — `test/billing-behaviour.test.js` (upgrade calls real `billingService.createShopifyCharge`; cancel dispatches `handleSubscriptionEvent({action:'cancelled'})`; invoices/price-history return real store-scoped data)
- [ ] DEP-006 `npm audit fix`
- [ ] M1–M10 executed and signed off

---

## 9. Recommendation

**CONDITIONAL GO.**

The three CRITICAL code defects that drove the original NO-GO are now fixed and empirically verified (FE-001, INT-001, PAY-001/002 — see §2.1). What remains before a real merchant install is not code but inputs only you can supply: the production origin (`PUBLIC_URL`), the Shopify Partner Dashboard `client_id` + client secret, delivery credentials, and the Block B/C hardening (backups + a rehearsed restore, full GDPR purge coverage, password reset, listing assets, and reconciling `storecops.com`, which currently serves a *different* application). Until those land, `npm run preflight` still exits non-zero — but the product is no longer structurally unlaunchable.

The shortest credible path to launch is Block A plus the Block B items that Shopify mandates. Block A is small — the `container` fix is one word, and the webhook fix is a header name plus an encoding. The billing stubs are the largest genuine engineering task, because a merchant being told a cancellation succeeded when nothing happened is the kind of defect that ends a business relationship and, in a paid app, invites a dispute.

Do not deploy until Block A is closed and M1, M2, and M3 have been executed against a real dev store.
