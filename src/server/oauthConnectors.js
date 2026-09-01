'use strict';

/**
 * One-click platform connect — the "Connect with Shopify" experience.
 *
 * Flow from the login/signup screen:
 *   1. Merchant clicks a platform button and enters their store address.
 *   2. We redirect them to the platform's OAuth authorize page (state is
 *      a one-time CSRF token persisted server-side).
 *   3. The platform redirects back to /connect/:platform/callback; we
 *      verify state (+ Shopify HMAC), exchange the code for an access
 *      token, and park the authorized store in pendingConnections.
 *   4. The merchant finishes signup; signup consumes the pending
 *      connection and syncs products + orders with the real token.
 *
 * WooCommerce has no third-party OAuth, so its flow deep-links into the
 * merchant's wp-admin (where they authenticate) and returns with REST
 * keys. Custom stores connect by reading their public catalog.
 */

const crypto = require('crypto',);
const { URL, } = require('url',);
const dns = require('node:dns/promises',);
const { assertSafeUrl, } = require('./storeAudit',);

const STATE_TTL_MS = 10 * 60 * 1000; // OAuth handshakes expire in 10 min
const PENDING_TTL_MS = 60 * 60 * 1000; // authorized stores wait up to 1 h

// Custom-store ownership proof (same pattern as Google Search Console / Meta).
const VERIFY_META = 'storecops-verification';
const VERIFY_FILE = '/.well-known/storecops-verify.txt';

const PLATFORMS = {
  shopify: { name: 'Shopify', scopes: 'read_products,read_orders,read_customers', },
  bigcommerce: {
    name: 'BigCommerce',
    scopes: 'store_cart_read_only store_v2_products_read_only store_orders_read_only',
  },
  woocommerce: { name: 'WooCommerce', auth: 'keys', },
  custom: { name: 'Custom store', auth: 'public', },
};

function createOauthConnectors({ platform, },) {
  const { store, config, } = platform;

  function baseUrl() {
    return config.publicUrl || `http://localhost:${config.port}`;
  }
  const callbackUrl = (p,) => `${baseUrl()}/connect/${p}/callback`;
  const auditOpts = () => ({
    allowPrivateHosts: config.env === 'test' || config.allowPrivateHosts === true,
  });

  // ── connector credentials (env vars win, else admin-stored) ───────
  async function configFor(p,) {
    const envKeys = {
      shopify: ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET',],
      bigcommerce: ['BIGCOMMERCE_CLIENT_ID', 'BIGCOMMERCE_CLIENT_SECRET',],
    }[p];
    if (envKeys && process.env[envKeys[0]] && process.env[envKeys[1]]) {
      return { client_id: process.env[envKeys[0]], client_secret: process.env[envKeys[1]], source: 'env', };
    }
    const row = await store.connectors.findOne({ platform: p, },);
    if (row && row.client_id && row.client_secret) {
      return { client_id: row.client_id, client_secret: row.client_secret, source: 'stored', };
    }
    return null;
  }

  async function status() {
    return {
      shopify: { ready: !!(await configFor('shopify',)), auth: 'oauth', },
      bigcommerce: { ready: !!(await configFor('bigcommerce',)), auth: 'oauth', },
      woocommerce: { ready: true, auth: 'keys', },
      custom: { ready: true, auth: 'public', },
    };
  }

  async function setConfig(p, clientId, clientSecret,) {
    if (!PLATFORMS[p]) throw new Error('Unknown platform.',);
    if (!clientId || !clientSecret) throw new Error('client_id and client_secret are required.',);
    const existing = await store.connectors.findOne({ platform: p, },);
    if (existing) {
      return store.connectors.update(existing._id, { client_id: clientId, client_secret: clientSecret, },);
    }
    return store.connectors.insert({
      platform: p,
      client_id: clientId,
      client_secret: clientSecret,
      created_at: new Date().toISOString(),
    },);
  }

  // ── state + pending storage ────────────────────────────────────────
  async function createState(patch,) {
    const state = crypto.randomBytes(16,).toString('hex',);
    await store.oauthStates.insert({ state, created_at: Date.now(), used_at: null, ...patch, },);
    return state;
  }

  async function takeState(state,) {
    if (!state) return null;
    const row = await store.oauthStates.findOne({ state, },);
    if (!row || row.used_at) return null;
    if (Date.now() - row.created_at > STATE_TTL_MS) return null;
    await store.oauthStates.update(row._id, { used_at: Date.now(), },);
    return row;
  }

  async function savePending(patch,) {
    const token = crypto.randomBytes(24,).toString('hex',);
    await store.pendingConnections.insert({ token, created_at: Date.now(), consumed_at: null, ...patch, },);
    return token;
  }

  async function getPending(token,) {
    if (!token) return null;
    const row = await store.pendingConnections.findOne({ token, },);
    if (!row || row.consumed_at) return null;
    if (Date.now() - row.created_at > PENDING_TTL_MS) return null;
    return row;
  }

  function publicPending(row,) {
    return {
      platform: row.platform,
      store_name: row.store_name,
      domain: row.domain || null,
      url: row.url || null,
      products_found: row.items ? row.items.length : null,
    };
  }

  // ── authorize redirects ────────────────────────────────────────────
  function normalizeShop(shop,) {
    const domain = String(shop || '',)
      .replace(/^https?:\/\//, '',)
      .replace(/\/.*$/, '',)
      .trim()
      .toLowerCase();
    if (!domain) throw new Error('Enter your myshopify.com store address.',);
    return domain.endsWith('.myshopify.com',) ? domain : `${domain}.myshopify.com`;
  }

  async function buildAuthorize(p, mode, userEmail, opts = {},) {
    if (p === 'shopify') {
      const cfg = await configFor('shopify',);
      if (!cfg) {
        throw new Error(
          'The Shopify connector is not configured on this server yet — add your Shopify app Client ID and secret in Settings → Platform connectors.',
        );
      }
      const shop = normalizeShop(opts.shop,);
      const state = await createState({ platform: 'shopify', mode, user_email: userEmail || null, shop, },);
      const u = new URL(`https://${shop}/admin/oauth/authorize`,);
      u.searchParams.set('client_id', cfg.client_id,);
      u.searchParams.set('scope', PLATFORMS.shopify.scopes,);
      u.searchParams.set('redirect_uri', callbackUrl('shopify',),);
      u.searchParams.set('state', state,);
      return { redirect_url: u.toString(), };
    }

    if (p === 'bigcommerce') {
      const cfg = await configFor('bigcommerce',);
      if (!cfg) {
        throw new Error(
          'The BigCommerce connector is not configured on this server yet — add your BigCommerce app Client ID and secret in Settings → Platform connectors.',
        );
      }
      const hash = String(opts.storeHash || opts.shop || '',)
        .replace(/^https?:\/\//, '',)
        .replace(/^store-/, '',)
        .split(/[./]/,)[0]
        .trim();
      if (!hash) throw new Error('Enter your BigCommerce store hash (the part after store- in your admin URL).',);
      const state = await createState({ platform: 'bigcommerce', mode, user_email: userEmail || null, storeHash: hash, },);
      const u = new URL(`https://store-${hash}.mybigcommerce.com/oauth2/authorize`,);
      u.searchParams.set('client_id', cfg.client_id,);
      u.searchParams.set('response_type', 'code',);
      u.searchParams.set('scope', PLATFORMS.bigcommerce.scopes,);
      u.searchParams.set('redirect_uri', callbackUrl('bigcommerce',),);
      u.searchParams.set('state', state,);
      return { redirect_url: u.toString(), };
    }

    throw new Error('This platform uses the guided connect flow instead of a redirect.',);
  }

  const start = (p, opts,) => buildAuthorize(p, 'signup', null, opts,);
  const startLink = (p, userEmail, opts,) => buildAuthorize(p, 'link', userEmail, opts,);

  // ── OAuth callbacks ────────────────────────────────────────────────
  function verifyShopifyHmac(query, secret,) {
    const { hmac, ...rest } = query;
    if (!hmac) return false;
    const message = Object.keys(rest,)
      .sort()
      .map((k,) => `${k}=${rest[k]}`,)
      .join('&',);
    const digest = crypto.createHmac('sha256', secret,).update(message,).digest('hex',);
    try {
      return crypto.timingSafeEqual(Buffer.from(digest, 'hex',), Buffer.from(String(hmac,), 'hex',),);
    } catch {
      return false;
    }
  }

  async function handoff(stateRow, info,) {
    if (stateRow.mode === 'link' && stateRow.user_email) {
      const user = await store.users.findOne({ email: stateRow.user_email, },);
      if (!user) throw new Error('Your account was not found — sign in and try again.',);
      await finalize(user.store_id, info,);
      return { redirect: '/app#/connect', };
    }
    const token = await savePending(info,);
    return { redirect: `/app?connect_token=${token}`, };
  }

  async function finishShopify(stateRow, query,) {
    if (query.error) throw new Error(`Shopify said: ${query.error_description || query.error}`,);
    const cfg = await configFor('shopify',);
    if (!cfg) throw new Error('Shopify connector credentials disappeared — re-add them in Settings.',);
    const shop = String(query.shop || stateRow.shop || '',).replace(/\/$/, '',);
    if (!shop || !query.code) throw new Error('Shopify returned an incomplete response.',);
    if (query.hmac && !verifyShopifyHmac(query, cfg.client_secret,)) {
      throw new Error('Shopify signature check failed — the callback was tampered with.',);
    }
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', },
      body: JSON.stringify({ client_id: cfg.client_id, client_secret: cfg.client_secret, code: query.code, },),
      signal: AbortSignal.timeout(15000,),
    },);
    if (!res.ok) throw new Error(`Shopify token exchange failed (${res.status}).`,);
    const { access_token, } = await res.json();
    if (!access_token) throw new Error('Shopify did not return an access token.',);
    return handoff(stateRow, {
      platform: 'shopify',
      store_name: shop.replace(/\.myshopify\.com$/, '',),
      domain: shop,
      access_token,
    },);
  }

  async function finishBigCommerce(stateRow, query,) {
    if (query.error) throw new Error(`BigCommerce said: ${query.error_description || query.error}`,);
    const cfg = await configFor('bigcommerce',);
    if (!cfg) throw new Error('BigCommerce connector credentials disappeared — re-add them in Settings.',);
    const context = String(query.context || '',); // e.g. "stores/abc123"
    const storeHash = context.split('/',)[1] || stateRow.storeHash;
    if (!query.code || !storeHash) throw new Error('BigCommerce returned an incomplete response.',);
    const res = await fetch('https://login.bigcommerce.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', },
      body: JSON.stringify({
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        code: query.code,
        scope: query.scope || '',
        grant_type: 'authorization_code',
        redirect_uri: callbackUrl('bigcommerce',),
        context,
      },),
      signal: AbortSignal.timeout(15000,),
    },);
    if (!res.ok) throw new Error(`BigCommerce token exchange failed (${res.status}).`,);
    const { access_token, } = await res.json();
    if (!access_token) throw new Error('BigCommerce did not return an access token.',);
    return handoff(stateRow, {
      platform: 'bigcommerce',
      store_name: `store-${storeHash}`,
      storeHash,
      access_token,
    },);
  }

  async function callback(platformName, query = {},) {
    const fail = (msg,) => ({ redirect: `/app?connect_error=${encodeURIComponent(msg,)}`, });
    try {
      const stateRow = await takeState(query.state,);
      if (!stateRow || stateRow.platform !== platformName) {
        return fail('The connection session expired or was invalid — please start again.',);
      }
      if (platformName === 'shopify') return await finishShopify(stateRow, query,);
      if (platformName === 'bigcommerce') return await finishBigCommerce(stateRow, query,);
      return fail('This platform does not use OAuth callbacks.',);
    } catch (error) {
      return fail(error.message,);
    }
  }

  // ── WooCommerce: deep-link into their admin, return with keys ─────
  function wooAdminUrl(siteUrl,) {
    return `${siteUrl}/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys`;
  }

  async function connectWooCommerce({ siteUrl, consumerKey, consumerSecret, } = {},) {
    const parsed = assertSafeUrl(siteUrl, auditOpts(),);
    if (!consumerKey || !consumerSecret) {
      // Step 1 only: hand the merchant a deep link into their own admin.
      return { admin_url: wooAdminUrl(parsed.origin,), store_name: parsed.hostname, };
    }
    const token = await savePending({
      platform: 'woocommerce',
      store_name: parsed.hostname,
      siteUrl: parsed.origin,
      consumerKey: String(consumerKey,).trim(),
      consumerSecret: String(consumerSecret,).trim(),
    },);
    return { connect_token: token, store_name: parsed.hostname, };
  }

  // ── Custom stores: read the public catalog, no credentials ─────────
  const MAX_ITEMS = 100;
  const MAX_CHILD_SITEMAPS = 5;
  // Real storefronts (Shopify etc.) often reject non-browser user agents.
  const CRAWL_HEADERS = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml',
  };
  const PRODUCT_PATH_RE = /\/(products?|shop|items?|catalog|p)\/[^/]+/i;

  async function fetchText(url,) {
    try {
      const res = await fetch(url, { headers: CRAWL_HEADERS, signal: AbortSignal.timeout(15000,), redirect: 'follow', },);
      if (!res.ok) return null;
      return (await res.text()).slice(0, 3 * 1024 * 1024,);
    } catch {
      return null;
    }
  }

  function nameFromSlug(slug,) {
    return slug.replace(/[-_+]+/g, ' ',).replace(/\b\w/g, (c,) => c.toUpperCase(),);
  }

  /** Product JSON-LD nodes anywhere in a page (single, array, ItemList). */
  function extractJsonLd(html, push,) {
    const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi,) || [];
    for (const block of blocks) {
      try {
        const data = JSON.parse(block.replace(/^<script[^>]*>/i, '',).replace(/<\/script>$/i, '',),);
        for (const node of Array.isArray(data,) ? data : [data,]) {
          if (node?.['@type'] === 'Product' && node.name) push(node.name, node.sku || null,);
          for (const child of node?.itemListElement || []) {
            const item = child?.item || child;
            if (item?.['@type'] === 'Product' && item.name) push(item.name, item.sku || null,);
          }
        }
      } catch {
        /* malformed JSON-LD is common in the wild */
      }
    }
  }

  /** Product links in HTML anchors — name from anchor text, else slug. */
  function extractAnchors(html, push,) {
    for (const [, href, rawText,] of html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,)) {
      if (!PRODUCT_PATH_RE.test(href,)) continue;
      const slug = decodeURIComponent(href.split('?',)[0].split('#',)[0].split('/',).filter(Boolean,).pop() || '',);
      if (!slug) continue;
      const text = rawText.replace(/<[^>]+>/g, ' ',).replace(/\s+/g, ' ',).trim();
      push(text.length >= 2 && text.length <= 120 ? text : nameFromSlug(slug,), `custom-${slug.slice(0, 40,)}`,);
    }
  }

  /** <url> entries with product locs; Shopify sitemaps carry the real name in image:title. */
  function extractSitemapEntries(xml, push,) {
    for (const entry of xml.match(/<url>[\s\S]*?<\/url>/gi,) || []) {
      const loc = (entry.match(/<loc>\s*([^<]+?)\s*<\/loc>/i,) || [])[1];
      if (!loc || !PRODUCT_PATH_RE.test(loc,)) continue;
      const title = (entry.match(/<image:title>\s*([^<]+?)\s*<\/image:title>/i,) || [])[1];
      const slug = decodeURIComponent(loc.split('?',)[0].split('/',).filter(Boolean,).pop() || '',);
      push(title || nameFromSlug(slug,), `custom-${slug.slice(0, 40,)}`,);
    }
  }

  /** sitemap.xml — flat urlset or a sitemap index (follow up to 5 children). */
  async function crawlSitemap(parsed, push,) {
    const xml = await fetchText(new URL('/sitemap.xml', parsed,).toString(),);
    if (!xml) return;
    if (/<sitemapindex[\s>]/i.test(xml,)) {
      const children = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi,),]
        .map((m,) => m[1],)
        .slice(0, MAX_CHILD_SITEMAPS,);
      for (const child of children) {
        const cxml = await fetchText(child,);
        if (cxml) extractSitemapEntries(cxml, push,);
      }
    } else {
      extractSitemapEntries(xml, push,);
    }
  }

  async function crawlPublicCatalog(parsed,) {
    const items = [];
    const seen = new Set();
    const seenIds = new Set(); // ledger keys by product_id — dedupe on it too
    const push = (name, id,) => {
      const clean = String(name || '',).replace(/\s+/g, ' ',).trim();
      if (clean.length < 2 || seen.has(clean.toLowerCase(),) || items.length >= MAX_ITEMS) return;
      const pid = id || `custom-${items.length + 1}`;
      if (seenIds.has(pid,)) return;
      seen.add(clean.toLowerCase(),);
      seenIds.add(pid,);
      items.push({
        product_id: pid,
        name: clean.slice(0, 120,),
        stock: 0, // merchant updates real stock afterwards (CSV or sync)
        lead_time_days: 7,
      },);
    };

    // 1. Homepage: product JSON-LD + product anchors.
    const home = await fetchText(parsed.toString(),);
    if (home) {
      extractJsonLd(home, push,);
      extractAnchors(home, push,);
    }

    // 2. sitemap.xml — following sitemap indexes into their children.
    if (items.length < MAX_ITEMS) await crawlSitemap(parsed, push,);

    // 3. Common catalog pages (Shopify collections, Woo shop, generic).
    for (const path of ['/collections/all', '/shop', '/products',]) {
      if (items.length >= MAX_ITEMS) break;
      const html = await fetchText(new URL(path, parsed,).toString(),);
      if (html) {
        extractJsonLd(html, push,);
        extractAnchors(html, push,);
      }
    }

    return items;
  }

  async function connectCustom({ url, } = {},) {
    const parsed = assertSafeUrl(url, auditOpts(),);
    const items = await crawlPublicCatalog(parsed,);
    if (!items.length) {
      throw new Error(
        'Couldn\'t find a public product catalog at that address — we checked the homepage, sitemap (incl. sitemap indexes) and common catalog pages, and the site may also be blocking automated readers. Try the WooCommerce flow or your store\'s platform connector instead.',
      );
    }
    // Ownership must be proven before the token becomes usable (see verifyCustom).
    const verify_token = crypto.randomBytes(16,).toString('hex',);
    const token = await savePending({
      platform: 'custom',
      store_name: parsed.hostname,
      url: parsed.origin,
      items,
      verify_token,
      verified: false,
    },);
    return {
      connect_token: token,
      verification_required: true,
      store_name: parsed.hostname,
      products_found: items.length,
      methods: verificationMethods(parsed.origin, verify_token,),
    };
  }

  function verificationMethods(origin, token,) {
    return {
      meta_tag: `<meta name="${VERIFY_META}" content="${token}">`,
      file: { url: `${origin}${VERIFY_FILE}`, content: token, },
      dns: { record_type: 'TXT', value: `${VERIFY_META}=${token}`, },
      expires_in: Math.floor(PENDING_TTL_MS / 1000,),
    };
  }

  /**
   * Prove control of the site. Any ONE of three proofs works — each is only
   * publishable by someone with access to the site's code, hosting, or DNS:
   * 1. <meta name="storecops-verification" content="TOKEN"> on the homepage
   * 2. TOKEN as the body of /.well-known/storecops-verify.txt
   * 3. a DNS TXT record: storecops-verification=TOKEN
   */
  async function verifyCustom({ connect_token, } = {},) {
    const row = await getPending(connect_token,);
    if (!row || row.platform !== 'custom') {
      throw new Error('No pending custom-store connection for that token — scan the store again.',);
    }
    if (row.verified) {
      return { verified: true, method: row.verified_method, store_name: row.store_name, products_found: row.items?.length || 0, };
    }
    const origin = row.url;
    const token = row.verify_token;
    let method = null;

    // 1. Homepage meta tag.
    const html = await fetchText(origin,);
    if (html) {
      const tags = html.match(/<meta\b[^>]*>/gi,) || [];
      if (tags.some((t,) => t.includes(VERIFY_META,) && t.includes(token,),)) method = 'meta_tag';
    }
    // 2. Well-known verification file.
    if (!method) {
      const file = await fetchText(origin + VERIFY_FILE,);
      if (file && file.trim() === token) method = 'file';
    }
    // 3. DNS TXT record.
    if (!method) {
      try {
        const hostname = new URL(origin,).hostname;
        const records = await Promise.race([
          dns.resolveTxt(hostname,),
          new Promise((_, rej,) => setTimeout(() => rej(new Error('dns timeout',),), 8000,).unref?.(),),
        ],);
        const flat = records.map((parts,) => parts.join('',).trim(),);
        if (flat.includes(`${VERIFY_META}=${token}`,)) method = 'dns';
      } catch {
        /* DNS unavailable for this host — the other two methods still work. */
      }
    }

    if (!method) {
      throw new Error(
        'Ownership not verified yet. Add ONE of the three proofs to your site (homepage meta tag, the /.well-known/storecops-verify.txt file, or the DNS TXT record), give it a minute to publish, then click Verify again.',
      );
    }
    await store.pendingConnections.update(row._id, { verified: true, verified_method: method, verified_at: Date.now(), },);
    return { verified: true, method, store_name: row.store_name, products_found: row.items?.length || 0, };
  }

  /** Signed-in stores use the same challenge before syncing into their account. */
  async function startCustomLink(body,) {
    return connectCustom(body,);
  }

  async function completeCustomLink(store_id, { connect_token, } = {},) {
    const row = await consumePending(connect_token,);
    return finalize(store_id, row,);
  }

  // ── finalize: turn an authorized pending connection into data ─────
  async function finalize(store_id, info,) {
    if (info.platform === 'shopify') {
      const result = await platform.integrations.syncShopify(store_id, {
        shopDomain: info.domain,
        accessToken: info.access_token,
      },);

      // Register the orders/create webhook for real-time order flow.
      await platform.integrations.registerShopifyWebhook(
        info.domain,
        info.access_token,
        platform.integrations.webhookUrl(store_id,),
      );

      // Task ob7: Register compliance webhooks (uninstalled, redact).
      const compliance = await platform.integrations.registerComplianceWebhooks(
        info.domain,
        info.access_token,
      );
      await platform.integrations.updateOnboardingStep(store_id, 'compliance_webhooks_registered', true,);

      // Task ob2: Auto-inject the tracking Script Tag.
      const tenant = await store.users.findOne({ store_id, },);
      const ingestKey = tenant?.ingest_key || platform.config.apiKey;
      const scriptTag = await platform.integrations.injectShopifyScriptTag(
        info.domain,
        info.access_token,
        store_id,
        ingestKey,
      );
      await platform.integrations.updateOnboardingStep(store_id, 'script_tag_installed', scriptTag.installed,);
      await platform.integrations.updateOnboardingStep(store_id, 'tracking_active', scriptTag.installed,);

      // Mark onboarding milestones.
      await platform.integrations.updateOnboardingStep(store_id, 'store_connected', true,);
      await platform.integrations.updateOnboardingStep(store_id, 'first_sync_done', true,);

      return {
        platform: 'shopify',
        store_name: info.store_name,
        ...result,
        compliance_webhooks: compliance,
        script_tag: scriptTag,
      };
    }
    if (info.platform === 'bigcommerce') {
      const result = await platform.integrations.syncBigCommerce(store_id, {
        storeHash: info.storeHash,
        accessToken: info.access_token,
      },);
      return { platform: 'bigcommerce', store_name: info.store_name, ...result, };
    }
    if (info.platform === 'woocommerce') {
      const result = await platform.integrations.syncWooCommerce(store_id, {
        siteUrl: info.siteUrl,
        consumerKey: info.consumerKey,
        consumerSecret: info.consumerSecret,
      },);
      return { platform: 'woocommerce', store_name: info.store_name, ...result, };
    }
    if (info.platform === 'custom') {
      if (info.items?.length) await platform.inventoryLedger.setStockBatch(store_id, info.items,);
      await platform.integrations.markConnected(store_id, {
        type: 'custom_public',
        url: info.url,
        products_synced: info.items?.length || 0,
        last_sync_at: new Date().toISOString(),
      },);
      return { platform: 'custom', store_name: info.store_name, products_synced: info.items?.length || 0, orders_synced: 0, };
    }
    throw new Error('Unknown connection type.',);
  }

  async function consumePending(token,) {
    const row = await getPending(token,);
    if (!row) throw new Error('This store connection expired or was already used — click Connect again.',);
    if (row.platform === 'custom' && !row.verified) {
      throw new Error('Store ownership hasn\'t been verified yet — add one of the verification proofs to your site and click Verify first.',);
    }
    await store.pendingConnections.update(row._id, { consumed_at: Date.now(), },);
    return row;
  }

  return {
    PLATFORMS,
    status,
    setConfig,
    start,
    startLink,
    callback,
    connectWooCommerce,
    connectCustom,
    verifyCustom,
    startCustomLink,
    completeCustomLink,
    pending: async (token,) => {
      const row = await getPending(token,);
      return row ? publicPending(row,) : null;
    },
    consumePending,
    finalize,
  };
}

module.exports = { createOauthConnectors, PLATFORMS: Object.keys({ shopify: 1, bigcommerce: 1, woocommerce: 1, custom: 1, },), };
