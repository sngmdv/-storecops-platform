# Storecops Growth Platform

> AI-driven e-commerce growth platform: customer intelligence, competitive monitoring, market trends, and automated revenue generation in one unified 6-layer system.

[![License](https://img.shields.io/badge/license-UNLICENSED-blue.svg)](LICENSE)

## Architecture

Storecops is organized into **6 interconnected layers** that form a continuous growth loop:

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│   Layer 1   │───▶│   Layer 2    │───▶│   Layer 3   │───▶│   Layer 4   │───▶│   Layer 5    │───▶│   Layer 6    │
│   Data      │    │ Intelligence │    │  Decision   │    │ Execution   │    │  Reporting   │    │ Growth Loop  │
│  Foundation │    │              │    │             │    │             │    │              │    │              │
└─────────────┘    └──────────────┘    └─────────────┘    └─────────────┘    └──────────────┘    └──────────────┘
```

- **Layer 1 — Data Foundation**: Events, customer profiles, competitor snapshots, external signals, sentiment, inventory, search console data
- **Layer 2 — Intelligence**: Churn scoring, recommendations, SEO audit/optimization, demand forecasting, brand sentiment, competitor intelligence, revenue intelligence
- **Layer 3 — Decision**: Rules engine, personalization, dynamic pricing, orchestrator, segmentation, campaigns, send-time optimization
- **Layer 4 — Execution**: Delivery providers (email/WhatsApp/push), retargeting, purchase orders, consent management, billing, monitoring
- **Layer 5 — Reporting**: Attribution, live orders, store reports, ROI, maturity scoring
- **Layer 6 — Growth Loop**: Continuous scan → execute → attribute → report cycle with event feedback

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Run tests
npm test

# Lint and fix
npm run lint
npm run lint:fix
npm run format
```

The platform boots on port 4000. Storage defaults to SQLite (`data/storecops.db`) for every
environment except `NODE_ENV=test`, which uses an in-memory store so tests start clean. Set
`STORAGE=memory` for a throwaway local run.

## API

Base URL: `http://localhost:4000/api/v1`

### Authentication

All authenticated routes require either:
- `X-API-Key: <your-api-key>` header, or
- `Authorization: Bearer <session-token>` header

Sign up to get your API key:
```bash
curl -X POST http://localhost:4000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"securepassword123","storeName":"My Store"}'
```

### Health Check
```bash
curl http://localhost:4000/health
```

### Key Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/signup` | Create account |
| POST | `/api/v1/auth/login` | Login |
| POST | `/api/v1/track` | Ingest event |
| GET | `/api/v1/customers/:store_id` | List customers |
| GET | `/api/v1/churn/:store_id` | Churn score |
| POST | `/api/v1/seo/audit` | Run SEO audit |
| GET | `/api/v1/campaigns/:store_id` | List campaigns |
| POST | `/api/v1/execute/:store_id` | Execute automation |
| GET | `/api/v1/report/:store_id` | Store report |
| GET | `/api/v1/billing/plans` | Available plans |

## Features

- **Consent-aware tracking** — behavioral events respect analytics consent
- **Real-time SSE live orders** — subscribe to purchase events as they happen
- **Demo simulator** — realistic e-commerce events when no credentials are connected
- **GDPR compliance** — data export, right-to-be-forgotten, Shopify webhook handlers
- **2FA authentication** — TOTP-based two-factor login
- **Multi-payment support** — Stripe (global) + Razorpay (India/UPI)
- **Multi-channel delivery** — Email (Resend), WhatsApp (Meta), Push
- **Competitor intelligence** — auto-scraping, Meta Ad Library integration
- **SEO engine** — audit, AI auto-fix, content ideas, ranking comparison
- **Billing & entitlements** — subscription management with Shopify recurring charges
- **Secret rotation** — automated credential lifecycle management
- **Notification center** — in-app alerts with severity filtering

## Deployment

### Docker
```bash
docker build -t storecops .
docker run -p 4000:4000 -v storecops-data:/app/data storecops
```

### Railway
```bash
railway deploy
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key variables: `PORT`, `API_KEY`, `PUBLIC_URL`, `STORAGE`, `SQLITE_PATH`, `NODE_ENV`,
`TOKEN_ENCRYPTION_KEY`, payment provider keys, WhatsApp/Email provider settings, and `REDIS_URL`
(only under `STORAGE=redis`).

See `.env.example` for all available configuration options.

## Storage

Three interchangeable adapters sit behind one async CRUD interface
(`src/storage/*.js`); every engine talks to the interface, never to an adapter, and
`test/storageParity.test.js` asserts all three implement the same surface — including `ping()`
and `close()`.

- **SQLite** — the default for every environment except tests. Persistent, zero external
  dependencies, WAL mode. File path from `SQLITE_PATH` (default `data/storecops.db`).
- **In-memory** — the default under `NODE_ENV=test`, and available explicitly via
  `STORAGE=memory`. Fast and zero-config, but data is lost on restart.
- **Redis** — `STORAGE=redis`. Configure with `REDIS_URL` (or `REDIS_HOST` / `REDIS_PORT` /
  `REDIS_PASSWORD` / `REDIS_TLS`). Setting `REDIS_URL` alone does **not** select this adapter.
  Two failures, two outcomes: if `ioredis` is not installed it genuinely falls back to
  in-memory, but an **unreachable server does not fall back** — the store stays Redis-backed,
  writes fail, and `/ready` reports `not_ready`. That is deliberate, because quietly serving
  from memory would accept writes a merchant believes are durable and lose them on restart.

**On a host with an ephemeral filesystem, `STORAGE=sqlite` still loses everything on the next
deploy unless the data directory is a mounted volume** (on Railway, `RAILWAY_VOLUME_MOUNT_PATH`).
`/ready` reports that condition in its `warnings` array rather than failing, because a healthy
instance on a disposable disk is a deploy-time mistake, not a code defect.

Back it up and alarm on it:

```bash
npm run backup          # consistent hot snapshot (VACUUM INTO) + verify
npm run backup:verify   # rehearse a restore through the real adapter
npm run backup:check    # exit 1 if no snapshot, or older than BACKUP_MAX_AGE_HOURS (48h)
```

Schedule the first two from a cron job, never from the web process; `backup:check` is the
alarm that tells you the cron stopped.

## Testing

```bash
# Run all tests
npm test

# Run a specific test file
node --test test/layers.test.js
```

71 test files / 824 tests in 50 suites, covering the six layers, API integration, auth,
security hardening, webhooks and tenancy, GDPR purge, WhatsApp, payments, storage-backend
parity, and the frontend render paths.

Several suites are **guards with control tests** rather than feature tests — for example
`asyncHandlerGuards` scans `src/server/` for unguarded async Express handlers and asserts how
many it must find, and `privacyPurge` pins a frozen inventory of collection names so a newly
added collection cannot silently become purgeable on uninstall. If one of those fails, read its
header before "fixing" it: the failure is usually the assertion working.

## License

UNLICENSED — See LICENSE for details.
