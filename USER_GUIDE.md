# Storecops User Guide

## Welcome to Storecops

Storecops is an AI-driven growth platform that helps you automate your e-commerce store's marketing, customer recovery, and competitive intelligence — all from one dashboard.

---

## Quick Start

### 1. Create Your Account
1. Go to `https://your-app.up.railway.app`
2. Click "Get Started"
3. Enter your email and password
4. Enter your store name

You'll receive:
- **API Key** — Save this for integrations
- **Store ID** — Your unique store identifier

### 2. Connect Your Store

#### Shopify
1. Go to **Settings** → **Integrations**
2. Click "Connect Shopify"
3. Authorize the app
4. Your store is now connected!

#### WooCommerce
1. Go to **Settings** → **Integrations**
2. Click "Connect WooCommerce"
3. Enter your store URL
4. Enter your Consumer Key and Secret
5. Click "Connect"

#### Custom Store
1. Go to **Settings** → **Integrations**
2. Click "Custom Connect"
3. Add the tracking snippet to your store
4. Verify connection

---

## Dashboard Overview

### Main Tabs

#### 📊 Overview
- **Revenue MTD** — Month-to-date revenue
- **Orders** — Total orders this month
- **Customers** — Active customer count
- **Growth Score** — Your store's maturity rating (A-F)

#### 👥 Customers
- **VIP Customers** — High-value, frequent buyers
- **At Risk** — Customers showing churn signals
- **New Customers** — Recent first-time buyers
- **Churned** — Inactive customers for 30+ days

#### 🏪 Competitors
- **Tracked Competitors** — Stores you're monitoring
- **Price Changes** — Recent competitor price updates
- **Promotions** — Active competitor sales
- **Ad Intelligence** — Competitor Facebook/Instagram ads

#### 📦 Inventory
- **Fast Movers** — Products selling quickly
- **Slow Movers** — Products with low velocity
- **Dead Stock** — Products with no sales in 90 days
- **Stockout Risk** — Products running low

#### 🔍 SEO
- **One-Click Fix** — Analyze and fix SEO issues
- **Optimization Report** — Detailed SEO analysis
- **Code Snippets** — Ready-to-apply fixes

#### 📈 Reports
- **Revenue Attribution** — Which channels drive sales
- **ROI Calculator** — Return on marketing spend
- **Weekly Digest** — Automated performance report

#### ⚙️ Settings
- **Integrations** — Manage store connections
- **API Keys** — Manage access keys
- **Team Members** — Add team accounts
- **Billing** — Manage subscription

---

## Key Features

### 🎯 Free Site Audit
Analyze any store's SEO, performance, and security:

1. Go to **Audit** page
2. Enter a store URL
3. Click "Analyze"
4. Get a free report with:
   - Overall score (A-F grade)
   - SEO analysis
   - Performance metrics
   - Security headers
   - AI readiness score

**Tip**: Use this to generate leads! The report includes your branding.

### 🔧 One-Click SEO Fix
Automatically fix SEO issues on your store:

1. Go to **SEO** tab
2. Click "Analyze & Fix Everything"
3. Review the generated fixes:
   - Title tags
   - Meta descriptions
   - OpenGraph tags
   - JSON-LD schemas
   - Security headers
4. Click "Copy Code" to apply

### 🛒 Cart Recovery
Automatically recover abandoned carts:

1. Go to **Settings** → **Automation**
2. Enable "Cart Recovery"
3. Configure:
   - Delay before first email (default: 2 hours)
   - Follow-up emails (optional)
   - WhatsApp recovery (if enabled)

**How it works**:
1. Customer abandons cart
2. After 2 hours, recovery email sent
3. After 24 hours, follow-up email sent
4. Revenue attributed to recovery campaign

### 📊 Competitor Monitoring
Track your competitors automatically:

1. Go to **Competitors** tab
2. Click "Add Competitor"
3. Enter competitor Shopify URL
4. Storecops will:
   - Scrape products every 6 hours
   - Track price changes
   - Monitor promotions
   - Analyze their ads

### 🎨 Dynamic Pricing
Get AI-powered pricing recommendations:

1. Go to **Inventory** tab
2. Select a product
3. Click "Get Pricing Advice"
4. Storecops analyzes:
   - Competitor prices
   - Demand forecast
   - Inventory levels
   - Margin targets

### 📧 Email Campaigns
Create automated email campaigns:

1. Go to **Campaigns** tab
2. Click "Create Campaign"
3. Choose type:
   - **Win-back** — Re-engage churned customers
   - **VIP** — Reward top customers
   - **Browse Abandonment** — Remind window shoppers
4. Customize message
5. Set schedule
6. Launch!

---

## Automation Rules

Create custom automation with the Rules Engine:

### Example: Win-Back Campaign
```
Trigger: Customer inactive for 45 days
Action: Send win-back email with 20% discount
Condition: Customer has made 2+ purchases
```

### Example: Price Drop Alert
```
Trigger: Competitor price drops 15%+
Action: Create pricing review task
Condition: Product is in stock
```

### Example: Low Stock Alert
```
Trigger: Inventory below 10 units
Action: Send purchase order to supplier
Condition: Product is a fast mover
```

---

## Understanding Your Scores

### Growth Score (A-F)
Your overall store health rating:
- **A** (90-100): Excellent — fully optimized
- **B** (70-89): Good — minor improvements needed
- **C** (50-69): Fair — several areas to improve
- **D** (30-49): Poor — significant work needed
- **F** (0-29): Critical — immediate action required

### Churn Risk Score (0-1)
Predicts likelihood a customer will stop buying:
- **0.0-0.2**: Low risk — engaged customer
- **0.2-0.4**: Medium risk — showing signs of disengagement
- **0.4-0.6**: High risk — likely to churn
- **0.6-1.0**: Critical risk — needs immediate attention

### AI Readiness Score
How well your store is optimized for AI search:
- **Structured Data** — JSON-LD schemas
- **llms.txt** — AI crawler instructions
- **FAQ Schema** — Question/answer markup
- **Entity Markup** — Organization/Store data

---

## Integrations

### Supported Platforms
- **Shopify** — Full integration (OAuth, webhooks, billing)
- **WooCommerce** — REST API connection
- **Custom** — Webhook + tracking snippet
- **CSV** — Manual data import

### Email Providers
- **Console** — Logs to terminal (testing)
- **Resend** — Recommended (free tier: 100/day)
- **SMTP** — Any SMTP server

### WhatsApp
- **Console** — Logs to terminal (testing)
- **Meta Cloud API** — Production WhatsApp Business

### Payments
- **Stripe** — Global customers
- **Razorpay** — Indian customers (UPI, Net Banking)

---

## Tips & Best Practices

### 1. Start with the Free Audit
Use the public audit tool to:
- Identify quick wins
- Generate leads
- Show value to potential customers

### 2. Connect Your Store First
Before using automation features, ensure your store is connected and syncing data.

### 3. Set Up Cart Recovery Early
Cart recovery typically has the highest ROI. Enable it as soon as your store is connected.

### 4. Monitor Competitors Weekly
Check competitor data weekly to:
- Spot price changes
- Identify market trends
- Adjust your strategy

### 5. Review Reports Monthly
Use the reporting dashboard to:
- Track ROI
- Identify top-performing channels
- Plan next month's strategy

---

## Troubleshooting

### "No Data" on Dashboard
- Check store connection status in Settings
- Wait 24 hours for initial data sync
- Verify tracking snippet is installed

### Email Not Sending
- Check `EMAIL_PROVIDER` configuration
- Verify Resend API key (if using Resend)
- Check spam folder

### WhatsApp Not Working
- Verify Meta credentials
- Check `WHATSAPP_PROVIDER=meta`
- Ensure phone number is verified

### Slow Performance
- Check database size
- Run data cleanup (Settings → Maintenance)
- Upgrade hosting plan if needed

---

## Support

- **Documentation**: `/docs` endpoint
- **API Reference**: `/api/docs` endpoint
- **Status Page**: `/health` endpoint
- **Email**: support@storecops.com

---

## API Access

For developers, all features are available via API:

```bash
# Get dashboard data
curl -H "X-API-Key: your-key" \
  https://your-app.up.railway.app/api/v1/dashboard/your-store-id

# Run an audit
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{"url": "https://example.myshopify.com"}' \
  https://your-app.up.railway.app/api/v1/audit/deep
```

See [API.md](./API.md) for full documentation.

---

*Last updated: 2026-08-14*
