# Storecops Admin UI Extensions

Four extensions that put Storecops intelligence directly inside the Shopify admin, next to the merchant's own data.

| Target | Module | What it does |
|---|---|---|
| `admin.customer-details.block.render` | `src/CustomerChurnBlock.jsx` | Churn score, LTV, recency, and a one-click win-back |
| `admin.product-details.block.render` | `src/ProductInsightsBlock.jsx` | Sales velocity, stockout projection, reorder qty, competitor price |
| `admin.customer-details.action.render` | `src/SendWinbackAction.jsx` | Modal to pick a channel, add an offer, and send |
| `admin.customer-index.selection-action.render` | `src/ExportCustomersAction.jsx` | Export the customer list as CSV or JSON |

## How authentication works

Extensions run on **Shopify's origin**, so every call to the Storecops API is cross-domain. Two pieces make that work:

1. **A session token per request.** `src/api.js` fetches a fresh Shopify session token before each call. It expires in about a minute, so it is never cached.
2. **Bearer auth.** The token is sent as `Authorization: Bearer <token>`. The backend verifies the HS256 signature against the app's client secret and resolves which shop — and therefore which tenant — is calling. See `src/server/sessionToken.js`.

The backend must also return CORS headers for Shopify origins. See `src/server/cors.js`.

Because the resolved identity is a **tenant, never a platform operator**, the standard tenant guard still applies: an extension can only ever read or act on the store it was installed on.

## Backend contract

The extensions only call shop-scoped routes, so they never need to know our internal `store_id`:

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v1/ext/shop/me` | Which store is this session acting for |
| GET | `/api/v1/ext/shop/customer/:ref/insights` | Churn, LTV, win-back eligibility |
| GET | `/api/v1/ext/shop/product/:id/insights` | Velocity, stockout, competitor price |
| POST | `/api/v1/ext/shop/customer/:ref/winback` | Send a win-back |
| POST | `/api/v1/ext/shop/customers/export` | Export customers |

`:ref` accepts a Shopify GID (`gid://shopify/Customer/123`), a bare numeric id, or an email — the backend normalises all three.

## Build and deploy

`shopify app deploy` bundles these extensions; there is no separate build step in this repo.

```bash
npm install --prefix shopify-app/extensions/storecops-admin
shopify app deploy
```

## Before going live

- Set `APP_URL` in `src/api.js` to your deployed origin if it is not `https://storecops.com`.
- Add your dev store to `CORS_ALLOWED_ORIGINS` if it is not a `*.myshopify.com` domain.
- Session tokens are only obtainable inside the Shopify admin — the blocks will render an explanatory message if opened outside it.
