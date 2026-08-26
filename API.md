# Storecops API Documentation

> **Base URL**: `https://your-app.up.railway.app/api/v1`
> 
> **Authentication**: All authenticated routes require either:
> - `X-API-Key: <your-api-key>` header, or
> - `Authorization: Bearer <session-token>` header

---

## Public Routes (No Auth Required)

### Health Check
```
GET /health
```
Returns platform status.

**Response**: `200 OK`
```json
{
  "status": "healthy",
  "uptime": 12345,
  "version": "1.0.0"
}
```

---

### Authentication

#### Sign Up
```
POST /api/v1/auth/signup
```

**Request Body**:
```json
{
  "email": "user@example.com",
  "password": "securepassword123",
  "store_name": "My Store"
}
```

**Response**: `201 Created`
```json
{
  "token": "bearer-token-here",
  "apiKey": "api-key-here",
  "storeId": "store_abc123"
}
```

#### Login
```
POST /api/v1/auth/login
```

**Request Body**:
```json
{
  "email": "user@example.com",
  "password": "securepassword123"
}
```

**Response**: `200 OK`
```json
{
  "token": "bearer-token-here",
  "apiKey": "api-key-here",
  "storeId": "store_abc123"
}
```

---

### Site Audit

#### Free 13-Check Audit
```
POST /api/v1/audit/site
```

**Request Body**:
```json
{
  "url": "https://example-store.myshopify.com"
}
```

**Response**: `200 OK`
```json
{
  "report_id": "audit_abc123",
  "url": "https://example-store.myshopify.com",
  "score": 72,
  "grade": "B",
  "checks": [
    { "name": "HTTPS", "pass": true, "weight": 30 },
    { "name": "Title Tag", "pass": true, "weight": 15 },
    { "name": "Meta Description", "pass": false, "weight": 12 }
  ]
}
```

#### Deep Audit (30+ Parameters)
```
POST /api/v1/audit/deep
```

**Request Body**:
```json
{
  "url": "https://example-store.myshopify.com"
}
```

**Response**: `200 OK`
```json
{
  "report_id": "deep_audit_xyz789",
  "url": "https://example-store.myshopify.com",
  "overall_score": 68,
  "grade": "C",
  "passed_checks": 18,
  "total_checks": 32,
  "categories": {
    "seo": { "score": 75, "checks": [...] },
    "performance": { "score": 60, "checks": [...] },
    "security": { "score": 50, "checks": [...] },
    "crawlability": { "score": 80, "checks": [...] }
  },
  "ai_readiness": {
    "score": 45,
    "grade": "D",
    "signals": [...]
  },
  "top_issues": [...]
}
```

#### Get Audit Report
```
GET /api/v1/audit/report/:id
```

**Response**: `200 OK` — Full deep audit report

#### Download PDF Report
```
GET /api/v1/audit/report/:id/pdf
```

**Response**: `200 OK` — PDF file download

#### Email PDF Report
```
POST /api/v1/audit/report/:id/email
```

**Request Body**:
```json
{
  "email": "recipient@example.com"
}
```

**Response**: `200 OK`

---

## Authenticated Routes

All routes below require `X-API-Key` or `Authorization: Bearer <token>`.

### Dashboard

#### Get Dashboard Data
```
GET /api/v1/dashboard/:store_id
```

**Response**: `200 OK`
```json
{
  "store_id": "store_abc123",
  "metrics": {
    "total_customers": 1234,
    "active_customers": 856,
    "revenue_mtd": 45678.90,
    "orders_mtd": 234
  },
  "recent_activity": [...],
  "insights": [...]
}
```

---

### Customer Intelligence

#### List Customers
```
GET /api/v1/customers/:store_id
```

**Query Parameters**:
- `segment` — Filter by segment (vip, new, at_risk, churned)
- `limit` — Number of results (default: 50)
- `offset` — Pagination offset

**Response**: `200 OK`
```json
{
  "customers": [
    {
      "id": "cust_123",
      "email": "j***@g***",
      "total_orders": 12,
      "total_spent": 1567.89,
      "churn_risk": 0.23,
      "segment": "vip"
    }
  ],
  "total": 1234,
  "limit": 50,
  "offset": 0
}
```

#### Get Churn Scores
```
GET /api/v1/churn/:store_id
```

**Response**: `200 OK`
```json
{
  "high_risk": [...],
  "medium_risk": [...],
  "low_risk": [...],
  "summary": {
    "total_at_risk": 45,
    "potential_revenue_at_risk": 12345.67
  }
}
```

---

### Competitor Intelligence

#### List Competitors
```
GET /api/v1/competitors/:store_id
```

**Response**: `200 OK`
```json
{
  "competitors": [
    {
      "id": "comp_123",
      "url": "https://competitor.myshopify.com",
      "last_scraped": "2026-08-14T10:00:00Z",
      "product_count": 156,
      "avg_price": 89.99
    }
  ]
}
```

#### Add Competitor
```
POST /api/v1/competitors/:store_id
```

**Request Body**:
```json
{
  "url": "https://competitor.myshopify.com"
}
```

**Response**: `201 Created`

---

### SEO Optimization

#### Single Page Audit
```
POST /api/v1/seo/audit
```

**Request Body**:
```json
{
  "url": "https://example-store.myshopify.com"
}
```

**Response**: `200 OK` — SEO audit results

#### Full SEO Optimization
```
POST /api/v1/seo/optimize
```

**Request Body**:
```json
{
  "url": "https://example-store.myshopify.com"
}
```

**Response**: `200 OK` — Full optimization report with code fixes

#### One-Click Fix
```
POST /api/v1/seo/one-click-fix
```

**Response**: `200 OK` — Ready-to-apply code snippets

#### AI Search Optimization
```
POST /api/v1/seo/ai-optimize
```

**Response**: `200 OK` — llms.txt, FAQPage schema, entity markup

---

### Inventory Intelligence

#### Analyze Inventory
```
GET /api/v1/inventory/:store_id/analyze
```

**Response**: `200 OK`
```json
{
  "total_products": 234,
  "fast_movers": [...],
  "slow_movers": [...],
  "dead_stock": [...],
  "stockout_risk": [...]
}
```

#### Record Purchase
```
POST /api/v1/inventory/:store_id/purchase
```

**Request Body**:
```json
{
  "product_id": "prod_123",
  "quantity": 50,
  "cost_per_unit": 25.00
}
```

**Response**: `200 OK`

---

### Automation Rules

#### Create Rule
```
POST /api/v1/rules/:store_id
```

**Request Body**:
```json
{
  "name": "Cart Recovery",
  "trigger": "cart_abandoned",
  "conditions": {
    "hours_since_abandonment": 2
  },
  "actions": [
    {
      "type": "send_email",
      "template": "cart_recovery",
      "delay_minutes": 120
    }
  ]
}
```

**Response**: `201 Created`

---

### Campaigns

#### Generate Campaign
```
POST /api/v1/campaigns/:store_id/generate
```

**Request Body**:
```json
{
  "type": "winback",
  "target_segment": "churned",
  "message": "We miss you! Here's 20% off..."
}
```

**Response**: `201 Created`

---

### Reporting

#### Get Revenue Attribution
```
GET /api/v1/attribution/:store_id
```

**Response**: `200 OK`
```json
{
  "total_attributed_revenue": 45678.90,
  "by_channel": {
    "email": 23456.78,
    "whatsapp": 12345.67,
    "organic": 9876.45
  },
  "by_campaign": [...]
}
```

#### Full Report (ROI + Maturity)
```
GET /api/v1/reporting/:store_id
```

**Response**: `200 OK`
```json
{
  "roi": {
    "revenue": 45678.90,
    "cost": 1200.00,
    "roi_percentage": 3706
  },
  "maturity_score": 72,
  "maturity_grade": "B",
  "recommendations": [...]
}
```

---

### Live Orders

#### SSE Feed
```
GET /api/v1/orders/:store_id/live
```

**Response**: `200 OK` — Server-Sent Events stream

**Event Types**:
- `new_order` — New order received
- `order_update` — Order status changed
- `refund` — Refund processed

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": {}
}
```

**Common Error Codes**:
- `400` — Bad Request (invalid input)
- `401` — Unauthorized (missing/invalid auth)
- `403` — Forbidden (insufficient permissions)
- `404` — Not Found
- `429` — Too Many Requests (rate limit)
- `500` — Internal Server Error

---

## Rate Limits

| Plan | Requests/Minute |
|------|-----------------|
| Starter | 100 |
| Growth | 300 |
| Enterprise | 1000 |

Rate limit headers:
- `X-RateLimit-Limit` — Max requests per window
- `X-RateLimit-Remaining` — Remaining requests
- `X-RateLimit-Reset` — Window reset timestamp

---

## Webhooks

### Shopify Webhooks
```
POST /api/v1/webhooks/shopify/orders/create
POST /api/v1/webhooks/shopify/orders/updated
POST /api/v1/webhooks/shopify/customers/data_request
POST /api/v1/webhooks/shopify/customers/redact
```

### WhatsApp Webhooks
```
GET /api/v1/webhooks/whatsapp (verification)
POST /api/v1/webhooks/whatsapp (incoming messages)
```

---

## SDKs & Libraries

### JavaScript/Node.js
```javascript
const response = await fetch('https://your-app.up.railway.app/api/v1/dashboard/store_123', {
  headers: {
    'X-API-Key': 'your-api-key'
  }
});
const data = await response.json();
```

### cURL
```bash
curl -H "X-API-Key: your-api-key" \
  https://your-app.up.railway.app/api/v1/dashboard/store_123
```

---

*Last updated: 2026-08-14*
