'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const http = require('node:http',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

/** Boot the app on an ephemeral port and return base URL + closer. */
function bootServer() {
  const platform = createPlatform();
  const app = createApp(platform,);

  return new Promise((resolve,) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port, } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        platform,
        close: () => new Promise((done,) => server.close(done,),),
      },);
    },);
  },);
}

/** A fake merchant website: JSON-LD products on the homepage + sitemap. */
function bootCatalogServer() {
  const homepage = `<!doctype html><html><head>
    <script type="application/ld+json">
      {"@type":"Product","name":"Ceramic Mug","sku":"MUG-1"}
    </script>
    <script type="application/ld+json">
      {"@type":"ItemList","itemListElement":[
        {"item":{"@type":"Product","name":"Canvas Tote","sku":"TOTE-2"}},
        {"item":{"@type":"Product","name":"Enamel Pin","sku":"PIN-3"}}
      ]}
    </script>
  </head><body>shop</body></html>`;

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>http://example.local/products/sticker-pack</loc></url>
      <url><loc>http://example.local/about</loc></url>
    </urlset>`;

  let verifyFileToken = null; // set once the crawl hands us the challenge token
  let homeHtml = homepage; // merchant may inject the verification meta tag

  const server = http.createServer((req, res,) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', },);
      return res.end(homeHtml,);
    }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml', },);
      return res.end(sitemap,);
    }
    if (req.url === '/.well-known/storecops-verify.txt') {
      if (!verifyFileToken) {
        res.writeHead(404,);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/plain', },);
      return res.end(verifyFileToken,);
    }
    res.writeHead(404,);
    return res.end();
  },);

  return new Promise((resolve,) => {
    server.listen(0, '127.0.0.1', () => {
      const { port, } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        setVerifyToken: (t,) => {
          verifyFileToken = t;
        },
        setHomePageMeta: (tag,) => {
          homeHtml = homepage.replace('</head>', `${tag}\n  </head>`,);
        },
        close: () => new Promise((done,) => server.close(done,),),
      },);
    },);
  },);
}

const JSON_HEADERS = { 'Content-Type': 'application/json', };

/** Shopify-style site: bare homepage, sitemap INDEX pointing at a child product sitemap. */
function bootSitemapIndexServer() {
  const index = `<?xml version="1.0" encoding="UTF-8"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>SITEMAP_BASE/sitemap_products_1.xml</loc></sitemap>
      <sitemap><loc>SITEMAP_BASE/sitemap_pages_1.xml</loc></sitemap>
    </sitemapindex>`;

  const products = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
      <url>
        <loc>SITEMAP_BASE/products/alpha-widget</loc>
        <image:image><image:title>Alpha Widget</image:title></image:image>
      </url>
      <url><loc>SITEMAP_BASE/products/beta-gadget</loc></url>
      <url>
        <loc>SITEMAP_BASE/products/alpha-widget</loc>
        <image:image><image:title>Alpha Widget (duplicate listing)</image:title></image:image>
      </url>
      <url><loc>SITEMAP_BASE/pages/about</loc></url>
    </urlset>`;

  const server = http.createServer((req, res,) => {
    const base = `http://${req.headers.host}`;
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', },);
      return res.end('<!doctype html><html><body>welcome</body></html>',);
    }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml', },);
      return res.end(index.replaceAll('SITEMAP_BASE', base,),);
    }
    if (req.url === '/sitemap_products_1.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml', },);
      return res.end(products.replaceAll('SITEMAP_BASE', base,),);
    }
    res.writeHead(404,);
    return res.end();
  },);

  return new Promise((resolve,) => {
    server.listen(0, '127.0.0.1', () => {
      const { port, } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done,) => server.close(done,),),
      },);
    },);
  },);
}

async function signupTenant(base, body,) {
  const res = await fetch(`${base}/api/v1/auth/signup`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      email: 'owner@shop.com',
      password: 'password123',
      storeName: 'Connect Shop',
      ...body,
    },),
  },);
  assert.equal(res.status, 201,);
  return res.json();
}

test('Connect: status reports per-platform readiness', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    // No connector credentials yet → OAuth platforms not ready.
    const before = await (await fetch(`${base}/connect/status`,)).json();
    assert.equal(before.shopify.ready, false,);
    assert.equal(before.bigcommerce.ready, false,);
    assert.equal(before.woocommerce.ready, true,);
    assert.equal(before.custom.ready, true,);

    await platform.oauth.setConfig('shopify', 'test-client-id', 'test-secret',);
    const after = await (await fetch(`${base}/connect/status`,)).json();
    assert.equal(after.shopify.ready, true,);
    assert.equal(after.bigcommerce.ready, false,);
  } finally {
    await close();
  }
},);

test('Connect: Shopify start builds a real authorize redirect', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    await platform.oauth.setConfig('shopify', 'test-client-id', 'test-secret',);

    const res = await fetch(`${base}/connect/shopify/start?shop=demo-store`, { redirect: 'manual', },);
    assert.equal(res.status, 302,);
    const location = new URL(res.headers.get('location',),);
    assert.equal(location.host, 'demo-store.myshopify.com',);
    assert.equal(location.pathname, '/admin/oauth/authorize',);
    assert.equal(location.searchParams.get('client_id',), 'test-client-id',);
    assert.ok(location.searchParams.get('scope',).includes('read_products',),);
    assert.ok(location.searchParams.get('redirect_uri',).endsWith('/connect/shopify/callback',),);

    // The state is a one-time CSRF token persisted server-side.
    const state = location.searchParams.get('state',);
    assert.ok(state,);
    assert.equal((await platform.store.oauthStates.find({},)).length, 1,);

    // A tampered/unknown callback state is rejected back to the login screen.
    const bad = await fetch(`${base}/connect/shopify/callback?state=evil&code=x`, { redirect: 'manual', },);
    assert.equal(bad.status, 302,);
    assert.ok(bad.headers.get('location',).startsWith('/app?connect_error=',),);
  } finally {
    await close();
  }
},);

test('Connect: unconfigured OAuth platform redirects with a friendly error', async () => {
  const { base, close, } = await bootServer();
  try {
    const res = await fetch(`${base}/connect/bigcommerce/start?storeHash=abc123`, { redirect: 'manual', },);
    assert.equal(res.status, 302,);
    const location = res.headers.get('location',);
    assert.ok(location.startsWith('/app?connect_error=',),);
    assert.ok(decodeURIComponent(location,).includes('not configured',),);
  } finally {
    await close();
  }
},);

test('Connect: signed-in store can start a link-mode OAuth connect', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    const tenant = await signupTenant(base,);
    await platform.oauth.setConfig('shopify', 'test-client-id', 'test-secret',);

    const res = await fetch(`${base}/api/v1/integrations/${tenant.store_id}/connect/shopify/start`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-API-Key': tenant.api_key, },
      body: JSON.stringify({ shop: 'demo-store', },),
    },);
    assert.equal(res.status, 200,);
    const { redirect_url, } = await res.json();
    assert.ok(redirect_url.startsWith('https://demo-store.myshopify.com/admin/oauth/authorize',),);
    const stateRow = await platform.store.oauthStates.findOne({},);
    assert.equal(stateRow.mode, 'link',);
    assert.equal(stateRow.user_email, tenant.user.email,);
  } finally {
    await close();
  }
},);

test('Connect: WooCommerce flow deep-links to wp-admin, then accepts REST keys', async () => {
  const { base, close, } = await bootServer();
  try {
    // Step 1: no keys yet → we get a link into the merchant's own admin.
    const step1 = await (
      await fetch(`${base}/connect/woocommerce`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ siteUrl: 'https://blog.example.com', },),
      },)
    ).json();
    assert.ok(step1.admin_url.includes('wp-admin/admin.php',),);
    assert.ok(step1.admin_url.includes('section=keys',),);
    assert.ok(!step1.connect_token,);

    // Step 2: merchant returns with keys → parked pending connection.
    const res = await fetch(`${base}/connect/woocommerce`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ siteUrl: 'https://blog.example.com', consumerKey: 'ck_abc', consumerSecret: 'cs_xyz', },),
    },);
    assert.equal(res.status, 200,);
    const { connect_token, } = await res.json();
    assert.ok(connect_token,);

    const pending = await (await fetch(`${base}/api/v1/connect/pending/${connect_token}`,)).json();
    assert.equal(pending.platform, 'woocommerce',);
    // Sanitized view never leaks the consumer secret.
    assert.ok(!JSON.stringify(pending,).includes('cs_xyz',),);
  } finally {
    await close();
  }
},);

test('Connect: custom store crawl → ownership proof → signup syncs products', async () => {
  const { base, platform, close, } = await bootServer();
  const catalog = await bootCatalogServer();
  try {
    // Public crawl finds JSON-LD products + the sitemap slug, then challenges ownership.
    const res = await fetch(`${base}/connect/custom`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ url: catalog.url, },),
    },);
    assert.equal(res.status, 200,);
    const { connect_token, products_found, verification_required, methods, } = await res.json();
    assert.ok(connect_token,);
    assert.equal(verification_required, true,);
    assert.equal(products_found, 4,); // 3 JSON-LD + 1 sitemap slug
    assert.ok(methods.meta_tag.includes('storecops-verification',),);
    assert.ok(methods.file.url.endsWith('/.well-known/storecops-verify.txt',),);
    assert.ok(methods.dns.value.startsWith('storecops-verification=',),);

    // Before any proof is published: verify fails and signup refuses the token.
    const fail = await fetch(`${base}/connect/custom/verify`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ connect_token, },),
    },);
    assert.equal(fail.status, 400,);
    const early = await signupTenant(base, { email: 'early@shop.com', connect_token, },);
    assert.ok(/verif/i.test(early.connected.error,), 'unverified token must not sync',);

    // The merchant publishes the verification file (only a site owner can).
    catalog.setVerifyToken(methods.file.content,);
    const okRes = await fetch(`${base}/connect/custom/verify`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ connect_token, },),
    },);
    assert.equal(okRes.status, 200,);
    const ok = await okRes.json();
    assert.equal(ok.verified, true,);
    assert.equal(ok.method, 'file',);

    // Sanitized pending view for the signup screen.
    const pendingRes = await fetch(`${base}/api/v1/connect/pending/${connect_token}`,);
    assert.equal(pendingRes.status, 200,);
    const pending = await pendingRes.json();
    assert.equal(pending.platform, 'custom',);
    assert.equal(pending.products_found, 4,);

    // Finishing signup with the verified token provisions + syncs the store.
    const tenant = await signupTenant(base, { email: 'custom@shop.com', connect_token, },);
    assert.ok(tenant.connected, 'signup reports the connect outcome',);
    assert.equal(tenant.connected.platform, 'custom',);
    assert.equal(tenant.connected.products_synced, 4,);

    const rows = await platform.store.inventory.find({ store_id: tenant.store_id, },);
    assert.equal(rows.length, 4,);
    assert.ok(rows.some((r,) => r.product_id === 'MUG-1',),);
    assert.ok(rows.some((r,) => r.name === 'Sticker Pack',),); // derived from slug

    // Connection record reflects the custom public sync.
    const status = await (
      await fetch(`${base}/api/v1/integrations/${tenant.store_id}`, {
        headers: { 'X-API-Key': tenant.api_key, },
      },)
    ).json();
    assert.equal(status.connected, true,);
    assert.equal(status.products_synced, 4,);

    // The pending token is single-use.
    const used = await fetch(`${base}/api/v1/connect/pending/${connect_token}`,);
    assert.equal(used.status, 404,);

    // Re-using it on another signup is refused (account still created).
    const second = await signupTenant(base, { email: 'second@shop.com', connect_token, },);
    assert.ok(second.connected?.error,);
  } finally {
    await catalog.close();
    await close();
  }
},);

test('Connect: custom verify also accepts the homepage meta tag', async () => {
  const { base, close, } = await bootServer();
  const catalog = await bootCatalogServer();
  try {
    const res = await fetch(`${base}/connect/custom`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ url: catalog.url, },),
    },);
    const { connect_token, methods, } = await res.json();

    // Merchant injects the meta tag into their homepage instead of the file.
    catalog.setHomePageMeta(methods.meta_tag,);
    const okRes = await fetch(`${base}/connect/custom/verify`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ connect_token, },),
    },);
    assert.equal(okRes.status, 200,);
    const ok = await okRes.json();
    assert.equal(ok.verified, true,);
    assert.equal(ok.method, 'meta_tag',);
  } finally {
    await catalog.close();
    await close();
  }
},);

test('Connect: custom crawl follows sitemap index (Shopify-style)', async () => {
  const { base, close, } = await bootServer();
  const catalog = await bootSitemapIndexServer();
  try {
    const res = await fetch(`${base}/connect/custom`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ url: catalog.url, },),
    },);
    assert.equal(res.status, 200,);
    const { connect_token, products_found, verification_required, } = await res.json();
    assert.ok(connect_token,);
    assert.equal(verification_required, true,);
    assert.equal(products_found, 2,); // image:title name + slug-derived name; duplicate slug deduped
  } finally {
    await catalog.close();
    await close();
  }
},);

test('Connect: custom connect refuses private hosts outside test mode', async () => {
  const { base, platform, close, } = await bootServer();
  try {
    platform.config.env = 'production';
    const res = await fetch(`${base}/connect/custom`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ url: 'http://192.168.1.10/', },),
    },);
    assert.equal(res.status, 400,);
    const { error, } = await res.json();
    assert.ok(/private|internal|blocked|allowed/i.test(error,),);
  } finally {
    platform.config.env = 'test';
    await close();
  }
},);
