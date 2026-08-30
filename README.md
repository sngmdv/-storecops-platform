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

The platform boots on port 4000 with an in-memory store by default. For persistent storage, set `STORAGE=sqlite`.

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

Key variables: `PORT`, `API_KEY`, `STORAGE`, `DATABASE_URL`, `NODE_ENV`, payment provider keys, WhatsApp/Email provider settings.

See `.env.example` for all available configuration options.

## Storage

The platform supports two storage backends:

- **In-memory** (default for tests): Fast, zero-config, data lost on restart
- **SQLite** (default for production): Persistent, zero external dependencies, WAL mode enabled

Set `STORAGE=sqlite` and `SQLITE_PATH=data/storecops.db` for production.

## Testing

```bash
# Run all tests
npm test

# Run a specific test file
node --test test/layers.test.js
```

25 test files covering layers, API integration, auth, security, webhooks, WhatsApp, payments, and more.

## License

UNLICENSED — See LICENSE for details.
