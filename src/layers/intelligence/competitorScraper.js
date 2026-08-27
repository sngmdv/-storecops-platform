"use strict";

/**
 * Layer 2 — Competitor Storefront Scraper.
 *
 * Automatically fetches competitor product catalogs by detecting the
 * e-commerce platform behind a URL and pulling the public product feed.
 *
 * Shopify stores expose `/products.json` (no auth needed for published
 * products). This scraper paginates through all pages, normalizes the
 * data and feeds it into the existing competitorIngestor so the diff
 * engine picks it up automatically.
 *
 * For non-Shopify stores, it falls back to extracting basic metadata
 * from the homepage (title, description, og tags).
 */

const MAX_PAGES = 10;
const PRODUCTS_PER_PAGE = 250;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Storecops-CompetitorRadar/1.0 (+https://storecops.app; competitor-monitoring)";

function createCompetitorScraper({ store, competitorIngestor }) {
  /**
   * Detect if a URL belongs to a Shopify/WooCommerce/BigCommerce store.
   */
  async function probeStorefront(baseUrl, fetchFn = globalThis.fetch) {
    const base = stripTrailingSlash(baseUrl);

    // Try Shopify
    try {
      const res = await fetchWithTimeout(`${base}/products.json?limit=1`, { fetchFn });
      if (res.ok) {
        const json = await res.json();
        if (json.products && Array.isArray(json.products)) return { platform: "shopify" };
      }
    } catch {}

    // Try WooCommerce REST API (public store endpoints)
    try {
      const res = await fetchWithTimeout(`${base}/wp-json/wc/store/products?per_page=1`, { fetchFn });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json) && json.length > 0 && json[0].id !== undefined) return { platform: "woocommerce" };
      }
    } catch {}

    // Try BigCommerce storefront API
    try {
      const res = await fetchWithTimeout(`${base}/api/storefront/products?limit=1`, { fetchFn });
      if (res.ok) {
        const json = await res.json();
        if (json.data && Array.isArray(json.data)) return { platform: "bigcommerce" };
      }
    } catch {}

    // Try generic product JSON endpoints
    const genericEndpoints = ["/api/products", "/products.json", "/collections/all/products.json"];
    for (const endpoint of genericEndpoints) {
      try {
        const res = await fetchWithTimeout(`${base}${endpoint}`, { fetchFn });
        if (!res.ok) continue;
        const json = await res.json();
        const products = json.products || (Array.isArray(json) ? json : null);
        if (products && products.length > 0) return { platform: "generic" };
      } catch {}
    }

    return null;
  }

  /**
   * Fetch the full product catalog from a Shopify store via the
   * public `/products.json` endpoint. Paginates automatically using
   * `page` + `limit` query params.
   */
  async function fetchShopifyProducts(baseUrl, fetchFn = globalThis.fetch) {
    const products = [];
    let page = 1;

    while (page <= MAX_PAGES) {
      const url =
        `${stripTrailingSlash(baseUrl)}/products.json` +
        `?limit=${PRODUCTS_PER_PAGE}&page=${page}`;

      const res = await fetchWithTimeout(url, { fetchFn });
      if (!res.ok) break;

      const json = await res.json();
      if (!json.products || json.products.length === 0) break;

      for (const product of json.products) {
        products.push(normalizeShopifyProduct(product));
      }

      if (json.products.length < PRODUCTS_PER_PAGE) break;
      page += 1;
    }

    return products;
  }

  /**
   * Fetch products from a WooCommerce store via the Store API (public, no auth).
   */
  async function fetchWooCommerceProducts(baseUrl, fetchFn = globalThis.fetch) {
    const products = [];
    let page = 1;
    while (page <= MAX_PAGES) {
      const url = `${stripTrailingSlash(baseUrl)}/wp-json/wc/store/products?per_page=${PRODUCTS_PER_PAGE}&page=${page}`;
      const res = await fetchWithTimeout(url, { fetchFn });
      if (!res.ok) break;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;
      for (const p of data) {
        const price = parseFloat(p.prices?.price || p.price || 0) / 100;
        products.push({
          id: String(p.id || p.sku || ""),
          name: p.name || "",
          price,
          in_stock: p.is_in_stock !== false,
          url: p.permalink || "",
          promotion: p.on_sale ? "sale" : null,
        });
      }
      page++;
      if (data.length < PRODUCTS_PER_PAGE) break;
    }
    return products;
  }

  /**
   * Fetch products from a BigCommerce storefront via the GraphQL Storefront API.
   */
  async function fetchBigCommerceProducts(baseUrl, fetchFn = globalThis.fetch) {
    const products = [];
    try {
      const url = `${stripTrailingSlash(baseUrl)}/graphql`;
      const query = `query { site { products(first: ${PRODUCTS_PER_PAGE}) { edges { node { entityId name sku prices { salePrice { value } retailPrice { value } } defaultImage { url } isVisible } } } } }`;
      const res = await fetchWithTimeout(url, {
        fetchFn,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) return products;
      const json = await res.json();
      const edges = json.data?.site?.products?.edges || [];
      for (const edge of edges) {
        const p = edge.node;
        const price = p.prices?.salePrice?.value || p.prices?.retailPrice?.value || 0;
        products.push({
          id: String(p.entityId || p.sku || ""),
          name: p.name || "",
          price: parseFloat(price) || 0,
          in_stock: p.isVisible !== false,
          url: `/product/${p.entityId}`,
          promotion: p.prices?.salePrice ? "sale" : null,
        });
      }
    } catch {}
    return products;
  }

  /**
   * Normalize a Shopify product into the format the competitorIngestor
   * expects: { id, name, price, in_stock, url, promotion }.
   */
  function normalizeShopifyProduct(shopifyProduct) {
    const variants = shopifyProduct.variants || [];
    const prices = variants
      .map((v) => parseFloat(v.price))
      .filter((p) => Number.isFinite(p) && p > 0);

    const minPrice = prices.length ? Math.min(...prices) : 0;
    const maxPrice = prices.length ? Math.max(...prices) : 0;
    const inStock = variants.some(
      (v) => v.available !== false && v.inventory_quantity !== 0
    );

    // Detect promotions from tags or compare-at-price.
    let promotion = null;
    const compareAt = variants
      .map((v) => parseFloat(v.compare_at_price))
      .filter((p) => Number.isFinite(p) && p > 0);
    if (compareAt.length > 0 && compareAt[0] > minPrice) {
      const discountPct = Math.round(
        ((compareAt[0] - minPrice) / compareAt[0]) * 100
      );
      promotion = `${discountPct}% off`;
    }

    const tags = (shopifyProduct.tags || "")
      .split(",")
      .map((t) => t.trim().toLowerCase());
    const promoTag = tags.find(
      (t) =>
        t.startsWith("promo") ||
        t.startsWith("sale") ||
        t.startsWith("bogo") ||
        t.startsWith("discount")
    );
    if (promoTag && !promotion) {
      promotion = promoTag;
    }

    const handle = shopifyProduct.handle || shopifyProduct.id;
    const imageUrl =
      shopifyProduct.images?.[0]?.src ||
      shopifyProduct.featured_image ||
      null;

    return {
      id: String(shopifyProduct.id),
      name: shopifyProduct.title || "",
      price: minPrice,
      price_max: maxPrice,
      in_stock: inStock,
      url: `/products/${handle}`,
      promotion,
      image: imageUrl,
      vendor: shopifyProduct.vendor || null,
      product_type: shopifyProduct.product_type || null,
    };
  }

  /**
   * Scrape a single competitor: detect platform, fetch products,
   * store the snapshot.
   */
  async function scrapeCompetitor(store_id, competitorConfig, fetchFn = globalThis.fetch) {
    const { competitor, url } = competitorConfig;
    if (!store_id || !competitor || !url) {
      throw new Error("store_id, competitor, and url are required.");
    }

    const startedAt = Date.now();
    const result = {
      competitor,
      url,
      store_id,
      platform_detected: null,
      products_scraped: 0,
      status: "unknown",
      error: null,
    };

    try {
      // Step 1: Detect platform
      const probe = await probeStorefront(url, fetchFn);

      if (probe?.platform === "shopify") {
        result.platform_detected = "shopify";
        const products = await fetchShopifyProducts(url, fetchFn);
        result.products_scraped = products.length;
        await competitorIngestor.ingestSnapshot({
          store_id, competitor, source: "auto_scraper",
          products: products.map((p) => ({ id: p.id, name: p.name, price: p.price, in_stock: p.in_stock, url: p.url, promotion: p.promotion })),
        });
        result.status = "success";
      } else if (probe?.platform === "woocommerce") {
        result.platform_detected = "woocommerce";
        const products = await fetchWooCommerceProducts(url, fetchFn);
        result.products_scraped = products.length;
        await competitorIngestor.ingestSnapshot({
          store_id, competitor, source: "auto_scraper",
          products: products.map((p) => ({ id: p.id, name: p.name, price: p.price, in_stock: p.in_stock, url: p.url, promotion: p.promotion })),
        });
        result.status = "success";
      } else if (probe?.platform === "bigcommerce") {
        result.platform_detected = "bigcommerce";
        const products = await fetchBigCommerceProducts(url, fetchFn);
        result.products_scraped = products.length;
        await competitorIngestor.ingestSnapshot({
          store_id, competitor, source: "auto_scraper",
          products: products.map((p) => ({ id: p.id, name: p.name, price: p.price, in_stock: p.in_stock, url: p.url, promotion: p.promotion })),
        });
        result.status = "success";
      } else {
        // Non-Shopify/Woo/BC: attempt basic metadata extraction
        result.platform_detected = "unknown";
        const meta = await extractBasicMeta(url, fetchFn);
        result.status = "partial";
        result.metadata = meta;
        const genericProducts = await tryGenericProductEndpoints(url, fetchFn);
        if (genericProducts.length > 0) {
          result.products_scraped = genericProducts.length;
          await competitorIngestor.ingestSnapshot({ store_id, competitor, source: "auto_scraper", products: genericProducts });
          result.status = "success";
        }
      }
    } catch (error) {
      result.status = "failed";
      result.error = error.message;
    }

    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  /**
   * Extract basic metadata (title, description, og tags) from any URL.
   */
  async function extractBasicMeta(url, fetchFn = globalThis.fetch) {
    try {
      const res = await fetchWithTimeout(url, { fetchFn });
      if (!res.ok) return { status: res.status };
      const html = await res.text();

      const title = extractTag(html, "title") || extractOg(html, "og:title");
      const description =
        extractMeta(html, "description") || extractOg(html, "og:description");
      const siteName = extractOg(html, "og:site_name");

      return { title, description, site_name: siteName };
    } catch {
      return { error: "fetch_failed" };
    }
  }

  /**
   * Try common product JSON endpoints on non-Shopify stores.
   */
  async function tryGenericProductEndpoints(baseUrl, fetchFn) {
    const endpoints = [
      "/collections/all/products.json",
      "/api/products",
      "/products.json",
    ];

    for (const endpoint of endpoints) {
      try {
        const url = `${stripTrailingSlash(baseUrl)}${endpoint}`;
        const res = await fetchWithTimeout(url, { fetchFn });
        if (!res.ok) continue;
        const json = await res.json();

        // Shopify-style response
        if (json.products && Array.isArray(json.products)) {
          return json.products.slice(0, 50).map((p) => ({
            id: String(p.id || p.handle || p.title),
            name: p.title || p.name || "",
            price: parseFloat(p.price || p.variants?.[0]?.price || 0),
            in_stock: p.available !== false,
            url: p.url || p.handle || "",
            promotion: null,
          }));
        }

        // Generic array response
        if (Array.isArray(json) && json.length > 0 && json[0].name) {
          return json.slice(0, 50).map((p) => ({
            id: String(p.id || p.sku || p.name),
            name: p.name || "",
            price: parseFloat(p.price || 0),
            in_stock: p.in_stock !== false && p.available !== false,
            url: p.url || "",
            promotion: p.promotion || null,
          }));
        }
      } catch {
        continue;
      }
    }

    return [];
  }

  /**
   * Scrape all tracked competitors for a store in sequence.
   */
  async function scrapeAll(store_id, fetchFn = globalThis.fetch) {
    const tracked = await store.trackedCompetitors.find({ store_id, enabled: true });
    const results = [];

    for (const config of tracked) {
      const result = await scrapeCompetitor(store_id, config, fetchFn);

      // Update tracking record
      await store.trackedCompetitors.update(config._id, {
        last_scrape_at: new Date().toISOString(),
        last_scrape_status: result.status,
        last_product_count: result.products_scraped,
        platform_detected: result.platform_detected,
      });

      results.push(result);
    }

    return {
      store_id,
      scraped_at: new Date().toISOString(),
      results,
      total_products: results.reduce((sum, r) => sum + r.products_scraped, 0),
    };
  }

  return {
    probeStorefront,
    fetchShopifyProducts,
    fetchWooCommerceProducts,
    fetchBigCommerceProducts,
    normalizeShopifyProduct,
    scrapeCompetitor,
    scrapeAll,
    extractBasicMeta,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

async function fetchWithTimeout(url, { fetchFn = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchFn(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractTag(html, tag) {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].trim() : null;
}

function extractMeta(html, name) {
  const match = html.match(
    new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, "i")
  );
  return match ? match[1] : null;
}

function extractOg(html, property) {
  const match = html.match(
    new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`, "i")
  );
  return match ? match[1] : null;
}

module.exports = { createCompetitorScraper };
