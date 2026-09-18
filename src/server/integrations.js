'use strict';

/**
 * Store connections: how real shops plug into Storecops.
 *
 *  - Tracking snippet: copy-paste JS for custom stores (views,
 *    carts, purchases flow into /track with the public ingest key).
 *  - CSV import: products.csv → stock ledger, orders.csv → events.
 *  - Order webhook receiver: Shopify-style payloads auto-mapped to
 *    tracked purchases (stock decrements automatically).
 *  - Shopify / WooCommerce adapters: pull catalogs + orders over
 *    their official APIs with client-provided credentials (Shopify via the
 *    GraphQL Admin API, WooCommerce via the Woo REST API).
 *
 * Every connection records health (last event, totals) so the hub
 * can show "connected & flowing" status.
 */

const crypto = require('crypto',);
const { resolveShopifyApiVersion, } = require('../config/shopifyApiVersion.js',);
const { createShopifyAdmin, shopifyIdTail, } = require('./shopifyAdmin.js',);

// Shopify Admin API version — derived, never copied. A second literal here is
// the drift that put an unsupported version into the billing path; see
// src/config/shopifyApiVersion.js.
const SHOPIFY_API_VERSION = resolveShopifyApiVersion();

// ── Token encryption for stored credentials ──────────────────────────
// Uses AES-256-GCM so tokens can be stored in the database for re-sync.
const DEFAULT_KEY = 'storecops-default-key-do-not-use-in-prod';
const rawKey = process.env.TOKEN_ENCRYPTION_KEY || DEFAULT_KEY;
const TOKEN_KEY = crypto.scryptSync(rawKey, 'storecops-salt', 32,);

if (process.env.NODE_ENV === 'production' && rawKey === DEFAULT_KEY) {
  console.error('[SECURITY] FATAL: TOKEN_ENCRYPTION_KEY is not set. Set it in your .env file.',);
  console.error('[SECURITY] Example: TOKEN_ENCRYPTION_KEY=your-random-64-char-string-here',);
  process.exit(1,);
}
function encryptToken(token,) {
  if (!token) return null;
  const iv = crypto.randomBytes(12,);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOKEN_KEY, iv,);
  let encrypted = cipher.update(String(token,), 'utf8', 'hex',);
  encrypted += cipher.final('hex',);
  const tag = cipher.getAuthTag().toString('hex',);
  return `${iv.toString('hex',)}:${tag}:${encrypted}`;
}
function decryptToken(encrypted,) {
  if (!encrypted) return null;
  try {
    const [ivHex, tagHex, data,] = encrypted.split(':',);
    const iv = Buffer.from(ivHex, 'hex',);
    const tag = Buffer.from(tagHex, 'hex',);
    const decipher = crypto.createDecipheriv('aes-256-gcm', TOKEN_KEY, iv,);
    decipher.setAuthTag(tag,);
    let decrypted = decipher.update(data, 'hex', 'utf8',);
    decrypted += decipher.final('utf8',);
    return decrypted;
  } catch {
    return null;
  }
}

// ── Task 64: Retry wrapper with exponential backoff ──────────────────
/**
 * Wraps fetch with automatic retry for 429 (rate limit) and 5xx responses.
 * Respects Shopify's `Retry-After` header when present.
 *
 * @param {string} url
 * @param {object} opts   Standard fetch options
 * @param {number} maxRetries  Max retry attempts (default: 3)
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, opts = {}, maxRetries = 3,) {
  const baseDelay = (opts._retryBaseDelay) || 1000;
  delete opts._retryBaseDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, opts,);

    // Success or client error (4xx except 429) — return immediately.
    if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
      return res;
    }

    // Last attempt — return whatever we got.
    if (attempt === maxRetries) return res;

    // Respect Retry-After header (seconds) if present.
    const retryAfter = res.headers.get('Retry-After',);
    const delay = retryAfter
      ? Number(retryAfter,) * 1000
      : baseDelay * Math.pow(2, attempt,);

    await new Promise((resolve,) => setTimeout(resolve, delay,),);
  }
  return undefined;
}

// ── CSV parsing (dependency-free, quote-aware) ─────────────────────
function parseCSV(text,) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field,);
      field = '';
    } else if (ch === '\n') {
      row.push(field,);
      rows.push(row,);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field,);
    rows.push(row,);
  }
  return rows.filter((r,) => r.some((c,) => c.trim() !== '',),);
}

function rowsToObjects(rows,) {
  const [header, ...body] = rows;
  const keys = header.map((h,) => h.trim().toLowerCase(),);
  return body.map((cells,) => {
    const obj = {};
    keys.forEach((k, i,) => {
      obj[k] = (cells[i] ?? '').trim();
    },);
    return obj;
  },);
}

// ── module ─────────────────────────────────────────────────────────
function createIntegrations({ platform, },) {
  const { store, eventTracker, inventoryLedger, customerProfiles, config, } = platform;

  function baseUrl() {
    return config.publicUrl || `http://localhost:${config.port}`;
  }

  async function touchConnection(store_id, patch,) {
    const connection = await store.integrations.findOne({ store_id, },);
    if (connection) return store.integrations.update(connection._id, patch,);
    return store.integrations.insert({
      store_id,
      type: 'unknown',
      status: 'connected',
      events_received: 0,
      last_event_at: null,
      created_at: new Date().toISOString(),
      ...patch,
    },);
  }

  async function bumpEvents(store_id, count = 1,) {
    const connection = await store.integrations.findOne({ store_id, },);
    if (!connection) return;
    await store.integrations.update(connection._id, {
      events_received: (connection.events_received || 0) + count,
      last_event_at: new Date().toISOString(),
      status: 'flowing',
    },);
  }

  return {
    // ── 1. Tracking snippet ─────────────────────────────────────────
    /** Copy-paste JS for custom stores; uses the write-only ingest key. */
    generateSnippet(store_id, ingestKey,) {
      const api = `${baseUrl()}/api/v1`;
      return `<!-- Storecops tracking snippet — paste before </body> -->
<script>
(function () {
  var API = ${JSON.stringify(api,)};
  var STORE = ${JSON.stringify(store_id,)};
  var KEY = ${JSON.stringify(ingestKey,)};

  function track(type, data) {
    try {
      var body = Object.assign({ store_id: STORE, event_type: type, timestamp: new Date().toISOString() }, data || {});
      var blob = new Blob([JSON.stringify(body)], { type: "application/json" });
      if (navigator.sendBeacon) navigator.sendBeacon(API + "/track?api_key=" + KEY, blob);
      else fetch(API + "/track", { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) { /* never break the host page */ }
  }

  // Public helpers for the store theme.
  window.Storecops = {
    view:    function (productId) { track("product_view", { product_id: productId }); },
    cart:    function (productId, qty) { track("cart_updated", { product_id: productId, quantity: qty || 1 }); },
    abandon: function (productId) { track("cart_abandoned", { product_id: productId }); },
    purchase: function (order) { track("purchase", order); } // { customer_id, email, total, items: [{ product_id, quantity, price }] }
  };

  // Auto-track product pages marked with <meta name="product-id">.
  var meta = document.querySelector('meta[name="product-id"]');
  if (meta) window.Storecops.view(meta.getAttribute("content"));
})();
</script>`;
    },

    // ── 2. CSV import ────────────────────────────────────────────────
    /**
     * type=products → header: product_id,name,stock,lead_time_days,price
     * type=orders   → header: customer_id,email,total,product_id,quantity,timestamp
     */
    async importCSV(store_id, type, csvText,) {
      if (!csvText || !csvText.trim()) throw new Error('CSV body is empty.',);
      const rows = rowsToObjects(parseCSV(csvText,),);
      if (!rows.length) throw new Error('No data rows found under the CSV header.',);

      if (type === 'products') {
        const items = rows.map((r,) => ({
          product_id: r.product_id || r.sku || r.id,
          stock: Number(r.stock ?? r.quantity ?? 0,),
          lead_time_days: Number(r.lead_time_days || 7,),
          price: r.price !== '' ? Number(r.price,) : undefined,
          name: r.name || undefined,
        }),);
        if (items.some((i,) => !i.product_id,)) throw new Error('Every product row needs a product_id column.',);
        await inventoryLedger.setStockBatch(store_id, items,);
        await touchConnection(store_id, { type: 'csv', items_imported: items.length, },);
        return { imported: items.length, type: 'products', };
      }

      if (type === 'orders') {
        let accepted = 0;
        const errors = [];
        for (const r of rows) {
          const tracked = await eventTracker.track({
            store_id,
            event_type: 'purchase',
            customer_id: r.customer_id || r.email || 'guest',
            email: r.email || null,
            total: Number(r.total || 0,),
            timestamp: r.timestamp || undefined,
            items: [
              {
                product_id: r.product_id || r.sku,
                quantity: Number(r.quantity || 1,),
                price: r.price !== '' && r.price !== undefined ? Number(r.price,) : undefined,
              },
            ],
          },);
          if (tracked.accepted) accepted++;
          else errors.push(tracked.errors,);
        }
        await touchConnection(store_id, { type: 'csv', },);
        await bumpEvents(store_id, accepted,);
        return { imported: accepted, rejected: errors.length, type: 'orders', };
      }

      throw new Error('CSV type must be \'products\' or \'orders\'.',);
    },

    // ── 3. Order webhook receiver ────────────────────────────────────
    /**
     * Accepts Shopify-style or generic payloads and maps them onto the
     * event pipeline. Stock decrements automatically downstream.
     */
    async ingestOrderWebhook(store_id, payload = {},) {
      const customer = payload.customer || {};
      const email = payload.email || customer.email || null;
      const lineItems = payload.line_items || payload.items || [];

      const items = lineItems.map((li,) => ({
        product_id: li.sku || li.product_id || li.variant_id || li.title || 'unknown-item',
        quantity: Number(li.quantity || 1,),
        price: li.price !== undefined ? Number(li.price,) : undefined,
      }),);

      const tracked = await eventTracker.track({
        store_id,
        event_type: 'purchase',
        customer_id: payload.customer_id || customer.id || email || 'webhook-guest',
        email,
        total: Number(payload.total_price ?? payload.total ?? items.reduce((s, i,) => s + (i.price || 0) * i.quantity, 0,),),
        items,
        source: payload.source || 'webhook',
        external_order_id: payload.order_id || payload.id || null,
      },);

      if (!tracked.accepted) return { accepted: false, errors: tracked.errors, };

      await touchConnection(store_id, { type: 'webhook', },);
      await bumpEvents(store_id,);
      return { accepted: true, event_id: tracked.event_id, total: Number(payload.total_price ?? payload.total ?? 0,), };
    },

    // ── 4. Shopify adapter ───────────────────────────────────────────
    /**
     * Pull products + orders + customers through the Shopify GraphQL Admin
     * API, then map the nodes onto exactly the same platform records the
     * previous implementation produced, so downstream engines cannot tell
     * the transport changed:
     *   - variants: `sku` else `variant-<numeric id>`; `inventoryQuantity`
     *     is the all-locations total, the same aggregate the old
     *     `inventory_quantity` reported
     *   - money arrives as decimal strings (`amount`) and is `Number()`-ed
     *     at the boundary, like the old string prices
     *   - customer `tags` arrive as an array and are joined back to the
     *     comma-separated string the profile record carries
     *   - global ids are reduced to their numeric tails, preserving the
     *     identifier space the old numeric ids lived in
     *
     * Per-resource errors are recorded and the sync continues with the other
     * resources (a missing `read_customers` grant must not wipe the catalogue
     * import); auth rejections still throw. The return value carries an
     * `errors` map so a partial sync can never again report bare success.
     */
    async syncShopify(store_id, { shopDomain, accessToken, fetchFn, } = {},) {
      const domain = String(shopDomain || '',).replace(/^https?:\/\//, '',).replace(/\/$/, '',);
      if (!domain || !accessToken) throw new Error('shopDomain and accessToken are required.',);
      const admin = createShopifyAdmin({
        shopDomain: domain, accessToken, apiVersion: SHOPIFY_API_VERSION, fetchFn,
      },);
      const errors = {};
      const isAuthFailure = (err,) => err?.status === 401 || err?.status === 403;

      // Products: every variant becomes one ledger row.
      const items = [];
      try {
        const products = await admin.fetchAllEdges(
          `query SyncProducts($first: Int!, $after: String) {
            products(first: $first, after: $after) {
              edges { node { id title handle variants(first: 100) {
                edges { node { id title sku price inventoryQuantity } }
              } } }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { root: 'products', pageSize: 250, maxPages: 10, },
        );
        for (const p of products) {
          for (const v of p.variants?.edges?.map((e,) => e.node,) || []) {
            items.push({
              product_id: v.sku || `variant-${shopifyIdTail(v.id,)}`,
              name: `${p.title}${v.title && v.title !== 'Default Title' ? ' — ' + v.title : ''}`,
              stock: Number(v.inventoryQuantity ?? 0,),
              price: Number(v.price || 0,),
              // Stored so the storefront recommendation widget can link
              // straight to /products/{handle} instead of guessing.
              handle: p.handle,
              lead_time_days: 7,
            },);
          }
        }
      } catch (err) {
        if (isAuthFailure(err,)) throw err;
        errors.products = err.message;
      }
      if (items.length) await inventoryLedger.setStockBatch(store_id, items,);

      // Orders: every order becomes one purchase event.
      let ordersImported = 0;
      try {
        const orders = await admin.fetchAllEdges(
          `query SyncOrders($first: Int!, $after: String) {
            orders(first: $first, after: $after, sortKey: CREATED_AT) {
              edges { node { id name email createdAt
                totalPriceSet { shopMoney { amount } }
                customer { id email }
                lineItems(first: 100) { edges { node { title sku quantity
                  variant { id }
                  originalUnitPriceSet { shopMoney { amount } }
                } } }
              } } }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { root: 'orders', pageSize: 250, maxPages: 10, },
        );
        for (const o of orders) {
          const customerId = (o.customer?.id && shopifyIdTail(o.customer.id,)) || o.email || `shopify-${shopifyIdTail(o.id,)}`;
          const tracked = await eventTracker.track({
            store_id,
            event_type: 'purchase',
            customer_id: customerId,
            email: o.email || o.customer?.email || null,
            total: Number(o.totalPriceSet?.shopMoney?.amount || 0,),
            timestamp: o.createdAt || undefined,
            items: (o.lineItems?.edges?.map((e,) => e.node,) || []).map((li,) => ({
              product_id: li.sku || (li.variant?.id && `variant-${shopifyIdTail(li.variant.id,)}`) || li.title || 'unknown-item',
              quantity: Number(li.quantity || 1,),
              price: Number(li.originalUnitPriceSet?.shopMoney?.amount || 0,),
            }),),
            source: 'shopify',
          },);
          if (tracked.accepted) ordersImported++;
        }
      } catch (err) {
        if (isAuthFailure(err,)) throw err;
        errors.orders = err.message;
      }

      // Customers: ensure one profile per customer (matters for customers
      // with zero orders, whom the order import never sees). This previously
      // called `customerProfiles.findOrCreate`, which does not exist — every
      // sync against a shop with at least one customer threw here, after
      // products and orders were already synced, so the connection row was
      // never updated either. Profiles are now created through the canonical
      // `applyEvent` path with a `lead_captured` event, which carries no
      // aggregate side effects (see the switch in customerProfile.js) but
      // runs the full identity-resolution and merge logic.
      let customersImported = 0;
      try {
        const customers = await admin.fetchAllEdges(
          `query SyncCustomers($first: Int!, $after: String) {
            customers(first: $first, after: $after) {
              edges { node { id email phone createdAt } }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { root: 'customers', pageSize: 250, maxPages: 10, },
        );
        for (const c of customers) {
          await customerProfiles.applyEvent({
            store_id,
            event_type: 'lead_captured',
            customer_id: String(shopifyIdTail(c.id,),),
            email: c.email || null,
            phone: c.phone || null,
            timestamp: c.createdAt || new Date().toISOString(),
            source: 'shopify',
          },);
          customersImported++;
        }
      } catch (err) {
        if (isAuthFailure(err,)) throw err;
        errors.customers = err.message;
      }

      await touchConnection(store_id, {
        type: 'shopify',
        config: { shopDomain: domain, tokenEncrypted: encryptToken(accessToken,), tokenMasked: accessToken.slice(0, 4,) + '••••', },
        products_synced: items.length,
        orders_synced: ordersImported,
        customers_synced: customersImported,
        sync_errors: errors,
        last_sync_at: new Date().toISOString(),
      },);
      return { products_synced: items.length, orders_synced: ordersImported, customers_synced: customersImported, errors, };
    },

    // ── 5. WooCommerce adapter ───────────────────────────────────────
    /** Pull products + orders through the Woo REST API (v3). */
    async syncWooCommerce(store_id, { siteUrl, consumerKey, consumerSecret, } = {},) {
      const site = String(siteUrl || '',).replace(/\/$/, '',);
      if (!site || !consumerKey || !consumerSecret) {
        throw new Error('siteUrl, consumerKey and consumerSecret are required.',);
      }
      const auth = `consumer_key=${encodeURIComponent(consumerKey,)}&consumer_secret=${encodeURIComponent(consumerSecret,)}`;

      // Paginate through all products
      const items = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 10) {
        const prodRes = await fetchWithRetry(`${site}/wp-json/wc/v3/products?per_page=100&page=${page}&${auth}`, { signal: AbortSignal.timeout(20000,), },);
        if (prodRes.status === 401 || prodRes.status === 403) throw new Error('WooCommerce rejected the API keys (401/403).',);
        if (!prodRes.ok) break;
        const products = await prodRes.json();
        if (!Array.isArray(products,) || products.length === 0) { hasMore = false; break; }
        for (const p of products) {
          items.push({
            product_id: p.sku || `woo-${p.id}`,
            name: p.name,
            stock: Number(p.stock_quantity ?? 0,),
            price: Number(p.price || 0,),
            lead_time_days: 7,
          },);
        }
        page++;
        if (products.length < 100) hasMore = false;
      }
      if (items.length) await inventoryLedger.setStockBatch(store_id, items,);

      // Paginate through all orders
      let ordersImported = 0;
      page = 1;
      hasMore = true;
      while (hasMore && page <= 10) {
        const orderRes = await fetchWithRetry(`${site}/wp-json/wc/v3/orders?per_page=100&page=${page}&${auth}`, { signal: AbortSignal.timeout(20000,), },);
        if (!orderRes.ok) break;
        const orders = await orderRes.json();
        if (!Array.isArray(orders,) || orders.length === 0) { hasMore = false; break; }
        for (const o of orders) {
          const tracked = await eventTracker.track({
            store_id,
            event_type: 'purchase',
            customer_id: o.customer_id || o.billing?.email || `woo-${o.id}`,
            email: o.billing?.email || null,
            total: Number(o.total || 0,),
            timestamp: o.date_created_gmt ? o.date_created_gmt + 'Z' : undefined,
            items: (o.line_items || []).map((li,) => ({
              product_id: li.sku || `woo-${li.product_id}`,
              quantity: Number(li.quantity || 1,),
              price: Number(li.price || 0,),
            }),),
            source: 'woocommerce',
          },);
          if (tracked.accepted) ordersImported++;
        }
        page++;
        if (orders.length < 100) hasMore = false;
      }

      await touchConnection(store_id, {
        type: 'woocommerce',
        config: { siteUrl: site, keyEncrypted: encryptToken(consumerKey + ':' + consumerSecret,), keyMasked: consumerKey.slice(0, 5,) + '••••', },
        products_synced: items.length,
        orders_synced: ordersImported,
        last_sync_at: new Date().toISOString(),
      },);
      return { products_synced: items.length, orders_synced: ordersImported, };
    },

    // ── 5b. BigCommerce adapter ─────────────────────────────────────────
    /** Pull products + orders through the BigCommerce v2/v3 REST APIs. */
    async syncBigCommerce(store_id, { storeHash, accessToken, } = {},) {
      const hash = String(storeHash || '',).replace(/^store-/, '',).replace(/\W.*/, '',);
      if (!hash || !accessToken) throw new Error('storeHash and accessToken are required.',);
      const headers = { 'X-Auth-Token': accessToken, 'Content-Type': 'application/json', };
      const apiBase = `https://api.bigcommerce.com/stores/${hash}`;

      // Paginate through all products
      const items = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 10) {
        const prodRes = await fetchWithRetry(`${apiBase}/v3/catalog/products?limit=250&page=${page}`, { headers, signal: AbortSignal.timeout(20000,), },);
        if (prodRes.status === 401 || prodRes.status === 403) throw new Error('BigCommerce rejected the access token (401/403).',);
        if (!prodRes.ok) break;
        const { data: products = [], } = await prodRes.json();
        if (!Array.isArray(products,) || products.length === 0) { hasMore = false; break; }
        for (const p of products) {
          items.push({
            product_id: p.sku || `bc-${p.id}`,
            name: p.name,
            stock: Number(p.inventory_level ?? 0,),
            price: Number(p.price || 0,),
            lead_time_days: 7,
          },);
        }
        page++;
        if (products.length < 250) hasMore = false;
      }
      if (items.length) await inventoryLedger.setStockBatch(store_id, items,);

      // Paginate through all orders
      let ordersImported = 0;
      page = 1;
      hasMore = true;
      while (hasMore && page <= 10) {
        const orderRes = await fetchWithRetry(`${apiBase}/v2/orders?limit=250&page=${page}`, { headers, signal: AbortSignal.timeout(20000,), },);
        if (!orderRes.ok) break;
        const orders = await orderRes.json();
        if (!Array.isArray(orders,) || orders.length === 0) { hasMore = false; break; }
        for (const o of orders) {
          const email = o.billing_address?.email || o.customer_email || null;
          const tracked = await eventTracker.track({
            store_id,
            event_type: 'purchase',
            customer_id: o.customer_id || email || `bc-${o.id}`,
            email,
            total: Number(o.total_inc_tax ?? o.total ?? 0,),
            timestamp: o.date_created || undefined,
            items: (o.products || []).map((li,) => ({
              product_id: li.sku || `bc-product-${li.product_id}`,
              quantity: Number(li.quantity || 1,),
              price: Number(li.price_inc_tax ?? (li.price || 0),),
            }),),
            source: 'bigcommerce',
          },);
          if (tracked.accepted) ordersImported++;
        }
        page++;
        if (orders.length < 250) hasMore = false;
      }

      await touchConnection(store_id, {
        type: 'bigcommerce',
        config: { storeHash: hash, tokenEncrypted: encryptToken(accessToken,), tokenMasked: accessToken.slice(0, 4,) + '••••', },
        products_synced: items.length,
        orders_synced: ordersImported,
        last_sync_at: new Date().toISOString(),
      },);
      return { products_synced: items.length, orders_synced: ordersImported, };
    },

    /** Best-effort: subscribe our public endpoint to Shopify orders/create. */
    async registerShopifyWebhook(shopDomain, accessToken, callbackUrl, opts = {},) {
      try {
        const admin = createShopifyAdmin({
          shopDomain, accessToken, apiVersion: SHOPIFY_API_VERSION, fetchFn: opts.fetchFn,
        },);
        await admin.graphql(
          `mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
            webhookSubscriptionCreate(
              topic: $topic,
              webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
            ) {
              webhookSubscription { id }
              userErrors { field message }
            }
          }`,
          { topic: 'ORDERS_CREATE', callbackUrl, },
          { userErrorsPath: ['webhookSubscriptionCreate',], },
        );
        return true;
      } catch {
        return false; // ongoing sync still works via pull; webhook is a bonus
      }
    },

    // ── Storefront tracking installation ───────────────────────────
    /**
     * Report how storefront tracking gets installed.
     *
     * This used to POST to Shopify's Script Tag API. That API is deprecated,
     * and the scopes it needs (read/write_script_tags) are exactly the kind of
     * broad permission App Store review rejects. Storefront tracking is now
     * delivered by the theme app extension (`shopify-app/extensions/storecops-tracker`),
     * which is the supported mechanism and needs no write scope.
     *
     * The extension is an app embed the merchant enables once in the Theme
     * Editor. It cannot be toggled programmatically, so this returns the
     * instruction rather than pretending to install something.
     *
     * Note: whether tracking is *active* is derived from whether events have
     * actually arrived (see onboardingService.js), not from this call. That
     * keeps the onboarding state honest — a merchant who never enables the
     * embed never sees "tracking active".
     */
    storefrontTrackingStatus() {
      return {
        installed: false,
        method: 'theme_extension',
        extension: 'storecops-tracker',
        reason:
          'Storefront tracking is enabled by turning on the Storecops app embed ' +
          'in Online Store -> Themes -> Customize -> App embeds. Shopify removed ' +
          'the Script Tag API, so it cannot be injected programmatically.',
        docs: 'https://shopify.dev/docs/apps/build/online-store/theme-app-extensions',
      };
    },

    // ── Task ob7: Compliance webhooks (uninstalled, data redaction) ─
    /**
     * Register Shopify compliance webhooks for app lifecycle and
     * customer data redaction (GDPR/CCPA).
     */
    async registerComplianceWebhooks(shopDomain, accessToken, opts = {},) {
      const base = baseUrl();
      // `topic` + `address` stay adjacent literals on purpose:
      // test/webhookConfig.test.js parses them out of this source to prove
      // the manifest and the runtime registration agree exactly. `gqlTopic`
      // is the GraphQL enum for the same topic.
      const topics = [
        { topic: 'app/uninstalled', address: `${base}/webhooks/shopify/app-uninstalled`, gqlTopic: 'APP_UNINSTALLED', },
        { topic: 'customers/data_request', address: `${base}/webhooks/shopify/data-request`, gqlTopic: 'CUSTOMERS_DATA_REQUEST', },
        { topic: 'customers/redact', address: `${base}/webhooks/shopify/customer-redact`, gqlTopic: 'CUSTOMERS_REDACT', },
        { topic: 'shop/redact', address: `${base}/webhooks/shopify/shop-redact`, gqlTopic: 'SHOP_REDACT', },
      ];
      const admin = createShopifyAdmin({
        shopDomain, accessToken, apiVersion: SHOPIFY_API_VERSION, fetchFn: opts.fetchFn,
      },);
      const results = {};
      for (const { topic, address, gqlTopic, } of topics) {
        try {
          await admin.graphql(
            `mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
              webhookSubscriptionCreate(
                topic: $topic,
                webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
              ) {
                webhookSubscription { id }
                userErrors { field message }
              }
            }`,
            { topic: gqlTopic, callbackUrl: address, },
            { userErrorsPath: ['webhookSubscriptionCreate',], },
          );
          results[topic] = 'registered';
        } catch (err) {
          results[topic] = `failed (${err.message})`;
        }
      }
      return results;
    },

    // ── Task ob4: Periodic re-sync ────────────────────────────────
    /**
     * Re-sync a single store using stored credentials. Called by the
     * periodic scheduler and the admin re-sync button.
     */
    async resyncStore(store_id,) {
      const connection = await store.integrations.findOne({ store_id, },);
      if (!connection) return { error: 'No connection record found.', };
      const cfg = connection.config || {};

      if (connection.type === 'shopify' && cfg.shopDomain) {
        const token = decryptToken(cfg.tokenEncrypted,);
        if (!token) return { skipped: true, reason: 'Token not available — re-authenticate via OAuth.', };
        return this.syncShopify(store_id, { shopDomain: cfg.shopDomain, accessToken: token, },);
      }
      if (connection.type === 'woocommerce' && cfg.siteUrl) {
        const keys = decryptToken(cfg.keyEncrypted,);
        if (!keys) return { skipped: true, reason: 'Woo keys not available — re-authenticate.', };
        const [consumerKey, consumerSecret,] = keys.split(':',);
        return this.syncWooCommerce(store_id, { siteUrl: cfg.siteUrl, consumerKey, consumerSecret, },);
      }
      if (connection.type === 'bigcommerce' && cfg.storeHash) {
        const token = decryptToken(cfg.tokenEncrypted,);
        if (!token) return { skipped: true, reason: 'BigCommerce token not available — re-authenticate.', };
        return this.syncBigCommerce(store_id, { storeHash: cfg.storeHash, accessToken: token, },);
      }
      if (connection.type === 'custom_public' && cfg.url) {
        await touchConnection(store_id, { last_sync_at: new Date().toISOString(), },);
        return { resynced: true, type: 'custom_public', };
      }
      return { skipped: true, reason: `Unknown type: ${connection.type}`, };
    },

    // ── Task ob5: Admin store listing ─────────────────────────────
    /**
     * List all connected stores with their health status for the
     * admin dashboard.
     */
    async listAllStores() {
      const all = await store.integrations.find({},);
      return all.map((c,) => {
        const { config: creds, ...safe } = c;
        return {
          ...safe,
          config: creds ? { masked: true, } : null,
          connected: true,
        };
      },);
    },

    // ── Task ob8: Onboarding state tracking ───────────────────────
    /**
     * Get or initialize the onboarding state for a store.
     */
    async getOnboardingState(store_id,) {
      const row = await store.integrations.findOne({ store_id, },);
      return row?.onboarding || {
        store_connected: !!row,
        tracking_active: false,
        billing_approved: false,
        first_sync_done: !!row?.products_synced,
        // Was `script_tag_installed`; the Script Tag API is deprecated and
        // tracking now ships as a theme app extension.
        tracking_method: null,
        compliance_webhooks_registered: false,
        updated_at: row?.last_sync_at || null,
      };
    },

    /**
     * Update a specific onboarding milestone for a store.
     */
    async updateOnboardingStep(store_id, step, value = true,) {
      const connection = await store.integrations.findOne({ store_id, },);
      if (!connection) return null;
      const onboarding = connection.onboarding || {};
      onboarding[step] = value;
      onboarding.updated_at = new Date().toISOString();
      await store.integrations.update(connection._id, { onboarding, },);
      return onboarding;
    },

    // ── connection listing ──────────────────────────────────────────
    async status(store_id,) {
      const connection = await store.integrations.findOne({ store_id, },);
      if (!connection) return { connected: false, store_id, };
      const { config: creds, ...safe } = connection;
      return { connected: true, ...safe, config: creds ? { masked: true, } : null, };
    },

    /** Demo helper: register the snippet/webhook combo as connected. */
    async markWebhookReady(store_id,) {
      return touchConnection(store_id, {
        type: 'webhook',
        webhook_url: `${baseUrl()}/webhooks/orders/${store_id}`,
      },);
    },

    /** Register/refresh a connection record (used by the OAuth connect flow). */
    async markConnected(store_id, patch,) {
      return touchConnection(store_id, patch,);
    },

    /** Public webhook endpoint URL for a store. */
    webhookUrl(store_id,) {
      return `${baseUrl()}/webhooks/orders/${store_id}`;
    },

    newIngestKey() {
      return `pub_${crypto.randomBytes(12,).toString('hex',)}`;
    },
  };
}

module.exports = { createIntegrations, parseCSV, rowsToObjects, };
