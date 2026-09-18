# Shopify App Store — Submission Checklist

Everything in this document is either done in this repo or is an action only you can take (account, assets, billing).

---

## 1. What this pass added

The gap between "production-viable" and "listable on the App Store" was **distribution packaging**, not core engineering. These are the pieces that were missing and are now in place:

| Added | Path | Why it was needed |
|---|---|---|
| Session token (JWT) verification | `src/server/sessionToken.js` | Admin UI Extensions authenticate with a Shopify-signed HS256 JWT, not an API key. The token was previously read from the body and **never verified** — extensions had no way to authenticate, and trusting the token would have let anyone forge one. |
| CORS middleware | `src/server/cors.js` | Extensions run on Shopify's origin, so every backend call is cross-domain. Without CORS headers the browser blocked all of them. |
| App proxy | `src/server/appProxy.js` | The storefront extension loads `/apps/storecops/tracker.js` and posts consent to `/apps/storecops/consent`. Neither route existed — both would have 404'd, meaning **no storefront data at all**. |
| Admin UI Extensions | `shopify-app/extensions/storecops-admin/` | Churn risk + inventory velocity blocks, win-back action, bulk export. |
| Storefront blocks | `shopify-app/extensions/storecops-tracker/blocks/` | Site-wide tracking embed + product recommendations. |
| Shop-scoped API routes | `src/server/apiRoutes.js` | `/ext/shop/*` — resolves the tenant from the session token so extensions never need our internal `store_id`. |

Also fixed along the way:

- `shopify.extension.toml` contained **JSON** where Shopify requires **TOML** — `shopify app deploy` could not parse it.
- The app proxy signature scheme differs from OAuth HMAC (no `&` separator). Implemented separately and tested, because getting it wrong rejects every storefront request silently.
- `setStock` silently **dropped `price`** even though the Shopify sync passed it. Price and handle are now persisted, which is what lets the recommendation widget render a real product card.

---

## 2. Before you submit

### Blocking

- [ ] **Redeploy HEAD to the public HTTPS origin.** ⚠️ `https://storecops.com`
  currently resolves and returns 200, but it does **not** serve this application.
  Every route in this repo 404s there (see below). `https://storecops-production.up.railway.app`
  **does** serve this app (`/health` 200) but the build there is stale (`/ready` 404,
  so it predates the readiness work) — redeploy HEAD, then verify `/ready` 200:

  ```
  404  /health            <- createApp.js:522
  404  /app               <- createApp.js:1077  (OAuth redirect target)
  404  /proxy/tracker.js  <- createApp.js:647   (app proxy target)
  404  /api/health
  404  /api/stores
  ```

  The live site is a different app (a Tailwind SPA serving a "Free Digital Audit"
  landing page). Until the Express server in this repo is actually deployed,
  `application_url`, `[app_proxy].url` and the OAuth redirect all point at nothing.
- [ ] **Fill in `client_id`.** `shopify.app.toml` now has
  `client_id = "REPLACE_WITH_PARTNER_DASHBOARD_CLIENT_ID"`. Get the real value from
  Partner Dashboard → your app → Client credentials. The file previously used a
  non-existent `id` field, so the CLI had no way to identify the app at all.
- [ ] **Set production credentials.** `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
  `TOKEN_ENCRYPTION_KEY`, `API_KEY`, `WEBHOOK_SECRET`, `PUBLIC_URL`. These are
  currently **empty** in `.env.production`. `config.js` throws on boot in production
  if required secrets are missing — that is intentional. Note that session-token
  verification fails closed without the Shopify pair, so the embedded admin cannot
  work until they are set.
- [ ] **Install the Shopify CLI.** It is not on this machine, so `shopify app deploy`
  cannot run yet. Either `npm install -g @shopify/cli@latest`, or add it as a
  devDependency and invoke it via `npx`.
- [ ] **Confirm `PUBLIC_URL` matches the live origin.**
  `.env.production` now sets `PUBLIC_URL=https://storecops-production.up.railway.app`,
  and that host is live (`/health` 200). `config.publicUrl` is the base for
  **every** address the app hands out:

  - OAuth callback — `oauthConnectors.js:49` → `${baseUrl()}/connect/shopify/callback`
  - Webhook addresses — `integrations.js:737` → `${baseUrl()}/webhooks/orders/{store_id}`
  - Storefront tracker src — `integrations.js:574` → `${baseUrl()}/tracker.js?...`
  - Every email CTA button — `emailTemplates.js:90-259` → `${publicUrl}/app`

  So a merchant who installs today gets webhooks delivered to a dead host and
  password-reset / report emails whose buttons point at a dead host if this drifts.
  This must match the real deployed origin, and must agree with `application_url` in
  `shopify.app.toml`. Right now the deployed build is **stale vs HEAD** (`/ready`
  404s there, so it predates the readiness work) — redeploy before review, then
  re-run `npm run preflight`.

- [ ] **Set the outbound delivery credentials — the Execution layer cannot send
  anything without them.** The code reads these; they are absent from `.env.production`:

  | Purpose | Key(s) the code reads | Status |
  |---|---|---|
  | Email | `RESEND_API_KEY`, or `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` | **not present at all** |
  | Email | `EMAIL_UNSUBSCRIBE_SECRET` | **not present** (compliance-relevant) |
  | WhatsApp | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | **empty** |

  `EMAIL_PROVIDER` and `WHATSAPP_PROVIDER` are set, but a provider name with no
  credential is not a working integration. Without these the app still collects data,
  scores churn and produces recommendations — but every send fails. That means the
  cart-recovery and win-back loops, which are the product's core value, do nothing.
  Decide which channels you actually support and set them before review, because the
  reviewer will install and expect a message to arrive.

- [ ] **Use persistent storage.** `STORAGE=sqlite` with a mounted volume, or Redis.
  `STORAGE=memory` loses all data on every restart.
- [ ] **Create the app in the Partner Dashboard** and copy its client ID/secret into
  your environment.
- [ ] **Verify the app loads embedded** on a development store: install, then confirm
  the admin iframe renders and the OAuth flow completes. The extensions have never
  run against a live Shopify admin — treat the first install as a test.
- [ ] **Run `shopify app deploy`** and confirm all extensions build and appear in the
  Theme Editor / admin.

### Config corrections already applied

`shopify.app.toml` was rewritten because it used keys and sections outside the
documented schema. Shopify CLI ignores unknown keys silently, so it looked valid while
making deployment impossible. Original preserved at `shopify.app.toml.bak`.

| Was | Now | Why it mattered |
|-----|-----|-----------------|
| `id = "storecops-growth-platform"` | `client_id = "..."` | `id` is not a field; `client_id` is required |
| `app_url` | `application_url` | wrong key name |
| *(absent)* | `embedded = true` | required for an App Bridge app |
| *(absent)* | `extension_directories = ["shopify-app/extensions"]` | CLI defaults to `extensions/` at the repo root — **which does not exist here**, so `shopify app deploy` would have found zero extensions |
| `[app_bridge]` + `redirect_url = "/app"` | `[auth] redirect_urls = [".../connect/shopify/callback"]` | wrong section, and the real callback is built in `oauthConnectors.js:49` as `/connect/{platform}/callback` |
| `[[extensions]]`, `[[theme_extensions]]` | removed | not sections; extensions are auto-discovered from disk |
| `[posix]` | removed | not a section (`[pos]` exists but is for Shopify POS — unrelated) |
| `[billing]`, `categories` | removed | not fields in this schema; billing is set in the Partner Dashboard |
| `[[webhooks]]` with `topic`/`format` | `[[webhooks.subscriptions]]` with `topics`/`compliance_topics` | wrong shape |

Also removed **four declarative webhooks that pointed at routes this codebase does not
implement** — `orders/create` → `/webhooks/shopify/orders`, `products/update` →
`/webhooks/shopify/products`, `inventory_levels/update` → `/webhooks/shopify/inventory`,
`refunds/create` → `/webhooks/shopify/refunds`. Only four Shopify webhook routes exist
in `createApp.js` (all compliance/uninstall), so Shopify would have POSTed to four dead
endpoints on every order, product change, inventory change and refund.

Real-time orders still work: they are registered at **runtime** via the Admin API to
`/webhooks/orders/{store_id}`, which *is* a real route (`createApp.js:601`). The
declarative block now declares only topics with real routes.

### Required for review

- [ ] **Privacy policy** reachable at whatever URL you register in the Partner
  Dashboard. `privacy_url` was removed from `shopify.app.toml` — it is not a field in
  that schema; the privacy/terms/support URLs are set in the Partner Dashboard listing
  instead. `/privacy` exists in this app — confirm it is reachable on the production
  domain before you paste the URL in.
- [ ] **App listing assets**: icon (1200×1200), feature image (1600×900), and at least 3 screenshots showing real functionality.
- [ ] **Demo video** (recommended) — reviewers approve faster when they can see the loop work.
- [ ] **Support contact** monitored at `support@storecops.com`.
- [ ] **Test instructions** for the reviewer. Reviewers need a way in. Provide a development store or a demo account with seeded data, and state clearly what to click.
- [ ] **Justify every scope you request.** This has been narrowed to
  `read_products,read_orders,read_customers,read_inventory` — the four the code
  demonstrably calls. The previous list also asked for `write_products`,
  `write_orders`, `write_customers`, `write_themes`, `write_content`, `read_themes`,
  `read_analytics`, `read_checkouts`, `read_shipping`, `read_script_tags`,
  `write_script_tags`, and several legacy `unauthenticated_read_*` Storefront scopes —
  none of which anything in `src/` reads or writes. Requesting unused scopes is the
  most common cause of App Store rejection. If you add a write-back feature later,
  add the scope here and in `.env` together.

  Note: `read_script_tags`/`write_script_tags` are **deprecated by Shopify**.
  The old `injectShopifyScriptTag` path that used them has been removed — see
  `storefrontTrackingStatus()` in `integrations.js`, which now returns
  `method: 'theme_extension'` instructions instead. Do not re-request the scope.

### Billing

- [ ] Plans are consistent across the stack: **starter free / growth $49 / scale $149** (`config.js` and `billingService.js` agree; `premium` is an alias of `scale`).
- [ ] Regional pricing covers 30+ countries (`subscriptionPricing.js`) — confirm the INR table matches what you advertise.
- [x] Decide on Shopify Billing API vs Stripe/Razorpay. **Decided: Shopify Billing**
  (2026-09-18) — `billingService.js` `createShopifyCharge` already calls the GraphQL
  `appSubscriptionCreate` mutation, so the code is on the Shopify path. The
  `[billing] use_shopify_billing = true` key was removed from `shopify.app.toml`
  because it is not part of that schema; this choice lives in the Partner Dashboard.

### Compliance

- [ ] **GDPR webhooks** are wired: `customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled`. All four respond within Shopify's 5-second limit (`shop_redact` offloads deletion via `setImmediate`).
- [ ] **Consent is respected end to end.** Storefront tracking reads Shopify's Customer Privacy API; the backend gates every outbound message through `consentService.canSend`. Do not weaken this.
- [ ] **Outbound volume caps** are enforced per entitlement (`executionService.js`). Keep them — uncapped sends at $49/mo is a negative-margin bug, not a feature.

---

## 3. Deploy

```bash
# 0. Verify the deployment is actually configured. Exits non-zero on any
#    blocking problem (placeholder PUBLIC_URL, placeholder client_id,
#    missing secrets, a webhook pointing at a route that does not exist).
npm run preflight

# 1. Extension dependencies (admin extensions only; theme blocks need none)
npm install --prefix shopify-app/extensions/storecops-admin

# 2. Build + push extensions and app config
shopify app deploy

# 3. Confirm the app proxy is live
curl -s "https://{shop}.myshopify.com/apps/storecops/tracker.js" | head -5
```

The proxy response must be JavaScript, not an HTML error page. If you get 401, the signature failed — check that `SHOPIFY_CLIENT_SECRET` matches the Partner Dashboard exactly.

### Backups — schedule the script, then alarm on it

`npm run backup` takes a verified snapshot (`VACUUM INTO` + integrity/table-set
check + prune), but nothing runs it on a schedule — a deployment can go months
with zero snapshots and the first redeploy wipes the ephemeral filesystem.
Two commands close that:

```bash
# Take one now (writes BACKUP_DIR or data/backups, keeps BACKUP_KEEP or 7).
npm run backup

# Alarm when the newest snapshot is older than 48h (exit 1).
# Run this from the same cron schedule — a green backup with no alarm is how
# the gap stayed invisible last time.
npm run backup:check
```

Railway has no cron section in `railway.json` — create a scheduled job (service →
Cron Schedule, e.g. `0 3 * * *`) with command `node scripts/backup.js`, and a
second schedule shortly after with `node scripts/backup-check.js --max-age-hours 48`
so a silently failing backup pages instead of rotting. Both commands need the
volume mounted at the same `SQLITE_PATH`/`BACKUP_DIR` as the app. Optional env:
`BACKUP_DIR=data/backups`, `BACKUP_KEEP=7`, `BACKUP_MAX_AGE_HOURS=48`.

### On `npm run preflight`

Added because the two most damaging configuration faults in this project were both
invisible at runtime: `PUBLIC_URL` pointed at an unreplaced hosting placeholder, and no
outbound delivery credential existed. Neither breaks a test, neither crashes the app,
and both only surface when a real merchant installs.

The script checks:

- required secrets are present and are not sentinel values (`dev-key`, defaults)
- `PUBLIC_URL` is a real public origin, not a placeholder or a local address
- at least one outbound delivery channel is configured
- `shopify.app.toml` has the keys the CLI requires and no sections it silently ignores
- every `extension_directories` entry exists and contains manifests
- **every declared webhook topic maps to a route that actually exists in `src/`**

It cannot verify that the app is *reachable* at `PUBLIC_URL`, or that the extensions
render inside a real admin. Confirm both on a dev store.

`npm run preflight:strict` also fails on warnings, which is what you want in CI before
a release.

### Boot-time enforcement

`config.js` runs the same readiness check at startup in production and **exits** on a
blocking problem, so a misconfigured deployment fails immediately and loudly instead of
serving broken URLs to merchants. Non-blocking gaps (a missing delivery credential)
print a warning naming each inert feature. `SKIP_READINESS_CHECK=true` overrides it —
documented, logged, and not recommended.

---

## 4. Architecture notes for reviewers and future you

**Two authentication paths, deliberately separate:**

| Caller | Credential | Resolves to |
|---|---|---|
| Server-to-server / scripts | `X-API-Key` | A tenant, or the platform operator for the master key |
| Embedded admin extension | `Authorization: Bearer <session token>` | A tenant, pinned to its own store |

A session token **never** yields a platform operator, so the tenant guard in `apiRoutes.js` still applies. An extension can only ever read or act on the store it was installed on.

**Tenant isolation is structural, not per-route.** `router.param('store_id')` rejects any store the caller does not own, which covers all ~290 routes at once. New routes get this for free — do not add ad-hoc ownership checks.

**Test coverage for the new surfaces:**

```bash
node --test test/sessionToken.test.js    # 12 — JWT verification, forgery, expiry, alg confusion
node --test test/adminExtensions.test.js # 14 — insight payloads, win-back, export, tenant isolation
node --test test/cors.test.js            #  7 — preflight, origin allowlist, no credentials
node --test test/appProxy.test.js        # 11 — signature scheme, tracker serving, consent
```

---

## 5. Known limitations

- **Admin UI Extensions require the Preact toolchain.** The rest of this repo has no build step; extensions cannot avoid it because Shopify's current API is Preact + remote-DOM web components. It is isolated to `shopify-app/extensions/storecops-admin/` and does not affect the main app.
- **`node:sqlite` is still an experimental Node API.** It emits a warning on boot. If that is unacceptable for production, swap the storage adapter — `store.js` is already pluggable and Redis is supported.
- **The extensions could not be executed against a live Shopify admin in this environment.** Their source follows the documented API, but the first real verification has to happen on a development store. Treat the first install as a test, not a launch.
- **`shopify.app.toml` is validated by the real Shopify CLI (4.8.0).** Verified by
  running `shopify app build` against it: it parses and builds cleanly, while a
  deliberately malformed manifest produces
  `Invalid character, expected "=" at row 1, col 7`. That control matters — it proves
  the CLI really is reading the file, so a passing build is meaningful rather than
  vacuous. Original file preserved at `shopify.app.toml.bak`.
- **`shopify app build` does NOT validate extension manifests.** This was tested
  directly: an extension `shopify.extension.toml` containing `NOT VALID TOML {{{`
  still builds successfully. So the CLI validates the app config but not the
  extensions — extension correctness is only proven by `shopify app deploy` and a
  real install. Do not treat a green build as extension validation.
- **Unknown keys in `shopify.app.toml` are silently ignored — confirmed.** Appending
  `[posix]`, `[[extensions]]` and `[app_bridge]` to the manifest produced no warning
  and a successful build. This is exactly why the original file looked fine while
  being undeployable. Any future edit to that file must be checked against the
  schema, not against whether the build passes.
- **Module overlap remains:** `revenueIntelligence.js`, `attribution.js` and `reportingService.js` all touch revenue attribution; `churnScoring.js` vs `retentionEngine.js` is confusing naming. Cosmetic, but it will slow down the next person.

---

## 6. Origin reconciliation runbook

**Do this first — it gates everything else.** Three origins are currently in play and
none of them agree. Until one is chosen and propagated, the app cannot work even if
deployed.

| Where | Key | Current value | Problem |
|---|---|---|---|
| `shopify.app.toml` | `application_url` | `https://storecops-production.up.railway.app` | live host, but deployed build is stale (`/ready` 404) — redeploy |
| `shopify.app.toml` | `[app_proxy].url` | `https://storecops-production.up.railway.app/proxy` | same — redeploy to verify |
| `shopify.app.toml` | `[auth].redirect_urls[0]` | `https://storecops-production.up.railway.app/connect/shopify/callback` | same |
| `.env.production` | `PUBLIC_URL` | `https://storecops-production.up.railway.app` | matches TOML — keep in sync |
| `storecops.com` | — | serves a *different* app | do not point listing/TOML there |

### Procedure

1. **Choose the origin.** One public HTTPS hostname that serves this Express app.
   Call it `ORIGIN` below.

2. **Deploy the app there** and confirm it is the *right* app:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" "$ORIGIN/health"   # expect 200
   curl -s "$ORIGIN/health"                                    # expect JSON with ok
   ```

   A 404 on `/health` means you have deployed the wrong thing. Do not continue.

3. **Set every occurrence to `ORIGIN`.** There are four:

   | File | Key |
   |---|---|
   | `shopify.app.toml` | `application_url` |
   | `shopify.app.toml` | `[app_proxy].url` → `$ORIGIN/proxy` |
   | `shopify.app.toml` | `[auth].redirect_urls[0]` → `$ORIGIN/connect/shopify/callback` |
   | `.env.production` | `PUBLIC_URL` → `$ORIGIN` |

4. **Verify with the preflight:**

   ```bash
   npm run preflight
   ```

   It fails on a placeholder or local `PUBLIC_URL`, and reports whether the
   credentials are real. Exit code 0 means nothing blocking remains.

5. **Cross-check the redirect path against the code**, because it is easy to assume
   wrong. The callback is built at `oauthConnectors.js:49`:

   ```js
   const callbackUrl = (p) => `${baseUrl()}/connect/${p}/callback`;
   ```

   So for Shopify the path is `/connect/shopify/callback` — **not** `/app`, which is
   the in-admin landing page (`createApp.js:1077`) and a different thing entirely.

6. **Confirm the proxy is reachable through Shopify** (not just directly). The app
   proxy only works once the merchant's store forwards to you:

   ```bash
   curl -s "https://{shop}.myshopify.com/apps/storecops/tracker.js" | head -5
   ```

   This must return JavaScript. If it returns an HTML error page, the signature check
   failed — see §3.

### Why one origin matters so much

`config.publicUrl` is not a display string. It is the base for:

- the OAuth callback URL — a mismatch breaks install entirely
- **every webhook delivery address** (`integrations.js:737`) — a mismatch means
  Shopify delivers events to a dead host
- the storefront tracker `src` (`integrations.js:574`)
- **every CTA button in every transactional email** (`emailTemplates.js:90-259`)
- the billing return URL (`billingService.js:158`)

A wrong `PUBLIC_URL` therefore produces an app that boots, passes tests, renders a
healthy-looking UI, and silently loses all webhook data while emailing customers links
that 404. That failure mode is why `config.js` now refuses to start in production with
a placeholder or local `PUBLIC_URL`, and why `npm run preflight` exists.

---

## 7. Scope justification (paste into the App Store listing)

The requested scopes are deliberately minimal. Reviewers reject broad scope requests
that the visible feature set cannot justify, and every removed scope below was
verifiably unused — nothing in `src/` reads or writes it.

**Requested: 4 scopes.**

| Scope | Why it is needed | Where it is used |
|---|---|---|
| `read_products` | Build the product catalogue that inventory velocity, stockout projection and reorder recommendations are computed from. | `integrations.js` `syncShopify` — GraphQL `products` connection (variants: sku, price, inventoryQuantity) |
| `read_orders` | Attribute revenue, compute repeat-purchase rate and LTV, and detect abandonment for cart recovery. | `integrations.js` `syncShopify` — GraphQL `orders` connection (totals, line items, customer) |
| `read_customers` | Score churn risk and decide win-back eligibility per customer. | `integrations.js` `syncShopify` — GraphQL `customers` connection |
| `read_inventory` | Track stock levels over time to project stockouts and compute days-of-cover. | inventory ledger (`inventoryLedger.js`) fed by the inventory sync |

**Not requested, and why:**

- **No `write_*` scopes.** The app is read-and-analyse. It does not create or modify
  products, orders, customers, content or themes. Removing these also removes the
  ability to damage merchant data, which is worth stating in the listing.
- **No `read_checkouts`.** Abandonment is derived from `orders` plus storefront
  events submitted by the theme app extension, not from the Checkouts API.
- **No `read_analytics`.** Analytics are computed in-app from orders and events.
- **No `read_content` / `write_content`.** The SEO features read a merchant's own
  pages via the storefront and Google Search Console, not the Shopify content API.
- **No `read_themes` / `write_themes`.** Storefront tracking ships as a **theme app
  extension** (`shopify-app/extensions/storecops-tracker`), which the merchant enables
  themselves in the Theme Editor. This is the supported replacement for script tags and
  needs no theme scope.
- **No `read_script_tags` / `write_script_tags`.** Shopify has deprecated the Script
  Tag API. The previous code path that used it has been removed — see
  `storefrontTrackingStatus()` in `integrations.js`, which now returns instructions
  instead of injecting a script tag.
- **No `read_shipping`.** Shipping cost is not part of any current metric.
- **No legacy `unauthenticated_read_*` Storefront scopes.** These are superseded; the
  app proxy and theme extension handle storefront access.

**If you later add a feature that writes back to Shopify,** add the scope in
`shopify.app.toml` *and* in the Partner Dashboard together, and update this table.
Adding a scope without a corresponding, visible feature is the most common reason a
resubmission is rejected.
