# Storecops Admin Guide

> Complete reference for the platform owner/operator.

---

## Quick Access

| Page | URL |
|---|---|
| Admin Dashboard | `/admin` |
| API Base | `/api/v1` |
| Health Check | `/health` |
| Health Status | `/health/status` |

All admin endpoints require `X-API-Key` header or `Authorization: Bearer <token>`.

---

## 1. Admin Brief

**Endpoint**: `GET /api/v1/admin/intel/brief`

Single-page executive snapshot every morning:

- **Revenue**: Total MRR, ARR, revenue at risk from churning stores
- **Churn risk**: Which stores are CRITICAL/HIGH risk, their MRR contribution
- **Leads**: New today, new this week, hot leads (score >= 80)
- **Store health**: Healthy vs unhealthy store counts
- **Delivery stats**: Emails/WhatsApp sent this week, success rate, failure count
- **Platform activity**: Total events tracked, automations executed

---

## 2. Revenue Forecast

**Endpoint**: `GET /api/v1/admin/intel/forecast`

Projects revenue forward:
- 30-day MRR forecast based on current subscriptions and churn probability
- 60-day projection factoring in expansion revenue from upgrades
- 90-day long-term trajectory
- Scenario modeling: "what if you convert 5 leads?" / "what if 2 stores churn?"

---

## 3. Retention Command Center

**Endpoints**:
- `GET /api/v1/admin/retention/dashboard` — full analysis
- `GET /api/v1/admin/retention/metrics` — MRR, churn, LTV, NRR only
- `GET /api/v1/admin/retention/health/:store_id` — single store score
- `GET /api/v1/admin/retention/interventions/:store_id` — recommended actions
- `GET /api/v1/admin/retention/history` — past snapshots

### Health Score (0-100)

Weighted composite of 6 signals:

```
Feature adoption    25%  — are they using the tools?
Engagement recency  20%  — when did they last log in?
Data freshness      20%  — is their store still connected?
Plan utilization    15%  — are they hitting limits?
Growth trajectory   10%  — is usage increasing?
Automation activity 10%  — are automations running?
```

### Risk Bands

| Band | Score | Action |
|---|---|---|
| THRIVING | 81-100 | Upsell to premium |
| LOW | 66-80 | Monitor, no action needed |
| MEDIUM | 46-65 | Send engagement nudge |
| HIGH | 26-45 | Personal outreach + intervention |
| CRITICAL | 0-25 | Emergency call, save-or-lose |

### Automatic Interventions

Generated per churn reason:

- **Low feature adoption** -> "You're missing X — here's how it grows stores"
- **Data stale** -> "Your store data is N days old — let's reconnect"
- **Trial expiring** -> "Your trial ends in N days — don't lose your data"
- **Plan limit hit** -> "You hit your limit — upgrade discount inside"
- **Declining revenue** -> "How similar store recovered $12k last month"
- **Renewal upcoming** -> "Your plan renews in N days — here's your ROI"

### Revenue Metrics

MRR, churn rate, expansion revenue, LTV, NRR (net revenue retention).

---

## 4. Lead Pipeline

**Endpoints**:
- `GET /api/v1/admin/leads/pipeline` — funnel summary
- `GET /api/v1/admin/leads` — list with filters (status, min_score, source, limit)
- `POST /api/v1/admin/leads` — manual capture
- `PATCH /api/v1/admin/leads/:lead_id` — update status/notes
- `POST /api/v1/admin/leads/score` — behavioral scoring
- `POST /api/v1/admin/leads/capture` — multi-source capture

### Funnel

```
Free audit scan -> Lead captured (scored by behavior)
  -> Signed up (free trial)
    -> Activated tracking (engaged)
      -> Chose plan (converted)
        -> Retained (renewed)
```

Each lead gets:
- **Behavioral score** — based on audit frequency, feature exploration, signup timing
- **Grade** — A/B/C/D/F based on score
- **Source** — which page/campaign brought them in
- **Trial expiry detection** — automatic alerts when trials are ending

---

## 5. Campaign Suggestions

**Endpoints**:
- `GET /api/v1/admin/intel/campaign-suggestions` — AI-generated suggestions
- `POST /api/v1/admin/intel/campaigns` — create campaign
- `GET /api/v1/admin/intel/feature-adoption` — which features drive retention

Suggested campaigns based on data analysis:
- "Target 12 stores with low feature adoption — send value realization emails"
- "5 stores hitting plan limits — send upgrade offers"
- "3 stores haven't logged in for 14 days — send re-engagement"

---

## 6. ROI Reports Per Store

**Endpoints**:
- `GET /api/v1/admin/revenue/roi/:store_id` — ROI calculation
- `GET /api/v1/admin/revenue/value-report/:store_id` — "can't resist not renewing" doc

Quantifies what Storecops delivered per store:
- Abandoned carts recovered -> $X
- Competitor price changes caught -> Y
- SEO improvements -> Z points
- Automations executed -> N messages sent

This is the renewal weapon — send before every renewal date.

---

## 7. Smart Renewal Reminders

**Endpoint**: `GET /api/v1/admin/revenue/reminders`

Psychologically-timed email sequence before each store's renewal:

| Days Before | Email | Trigger |
|---|---|---|
| 30 | Value realization report | Reciprocity — show what you delivered |
| 14 | Loss aversion warning | "Don't lose your advantage" |
| 10 | Streak preservation | "You've been growing for N months" |
| 7 | Competitor gap alert | "Competitors changed X while you were away" |
| 3 | Time-limited offer | Scarcity — discount expires |
| 1 | Final reminder | Urgency — "last chance" |

---

## 8. Conversion Intelligence

**Endpoint**: `GET /api/v1/admin/revenue/conversion`

What converts prospects into paying customers:
- Audit-to-signup rate
- Feature activation triggers
- Pricing sensitivity analysis
- Optimal nudge timing

---

## 9. User & Access Management

**Endpoints**:
- `POST /api/v1/admin/users` — create team member
- `GET /api/v1/admin/users` — list all users
- `GET /api/v1/admin/audit` — immutable audit log

### Roles

| Role | Permissions |
|---|---|
| Admin | Full access, manage users, configure connectors |
| Manager | Read + mutate, run automations, manage campaigns |
| Viewer | Read-only, view dashboards and reports |

First user auto-promoted to admin. Users created via `/admin/users` require `administer` permission.

---

## 10. Store Management

**Endpoints**:
- `GET /api/v1/admin/stores` — all connected stores with health status
- `POST /api/v1/admin/stores/:store_id/resync` — trigger manual data re-sync
- `GET /api/v1/admin/stores/:store_id/onboarding` — onboarding progress
- `POST /api/v1/admin/stores/:store_id/onboarding` — update onboarding steps

---

## 11. Monitoring & Health

**Endpoints**:
- `GET /health` — simple ok/fail
- `GET /health/status` — detailed health for dashboards
- `GET /api/v1/monitoring/health` — platform health summary (configurable hours)
- `GET /api/v1/monitoring/events` — recent failure/error events (filterable by type, severity)
- `GET /api/v1/monitoring/counters` — request metrics, error rates

Tracks: webhook failures, delivery failures, token expiry, API errors.

---

## 12. Secret Management

**Endpoints**:
- `GET /api/v1/secrets/:store_id` — list all secrets
- `POST /api/v1/secrets/:store_id/rotate/shopify` — rotate Shopify token
- `POST /api/v1/secrets/:store_id/rotate/api-key` — rotate API key
- `GET /api/v1/secrets/expiring` — secrets expiring within N days

Automatic lifecycle tracking — never lose access because a token expired.

---

## 13. GDPR Compliance

**Endpoints**:
- `GET /api/v1/admin/gdpr/:store_id/:customer_id` — export customer data
- `DELETE /api/v1/admin/gdpr/:store_id/:customer_id` — right to be forgotten

Automatic Shopify webhook handlers:
- `app_uninstalled` -> marks store disconnected, stops automation
- `data_request` -> exports all customer data
- `customer_redact` -> anonymizes PII across events, deliveries, actions
- `shop_redact` -> purges all store data

---

## 14. Connector Configuration

**Endpoints**:
- `GET /api/v1/connectors` — per-platform readiness status
- `PUT /api/v1/connectors/:platform` — set client_id/client_secret (admin only)

Configure OAuth credentials for Shopify, BigCommerce, WooCommerce.

---

## 15. Activity Log

**Endpoints**:
- Activity logs recorded automatically for: signup, user creation, connector config, GDPR actions
- Query via `GET /api/v1/admin/audit` with optional `store_id` filter

---

## Daily Admin Workflow

### Morning (5 min)
1. `GET /api/v1/admin/intel/brief` — what needs attention today?
2. `GET /api/v1/admin/retention/dashboard` — which stores are at risk?

### Midday (5 min)
3. `GET /api/v1/admin/leads/pipeline` — new leads from audits?
4. `GET /api/v1/admin/revenue/conversion` — what's working?

### Weekly (15 min)
5. `GET /api/v1/admin/retention/history` — is retention improving?
6. `GET /api/v1/admin/intel/feature-adoption` — what to build/promote?
7. `GET /api/v1/monitoring/events` — any system issues?

### Before Each Renewal
8. `GET /api/v1/admin/revenue/value-report/:store_id` — prove ROI
9. `GET /api/v1/admin/revenue/reminders` — automated sequence
