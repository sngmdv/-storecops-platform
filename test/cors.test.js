'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

/** Boot the app on an ephemeral port. */
async function boot() {
  const platform = createPlatform();
  const app = createApp(platform,);
  const server = await new Promise((resolve,) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s,),);
  },);
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    platform,
    close: () => new Promise((done,) => server.close(done,),),
  };
}

test('cors: preflight from the Shopify admin is answered with allow headers', async () => {
  const { base, close, } = await boot();
  try {
    const res = await fetch(`${base}/api/v1/ext/shop/me`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://admin.shopify.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    },);

    assert.strictEqual(res.status, 204,);
    assert.strictEqual(res.headers.get('access-control-allow-origin',), 'https://admin.shopify.com',);
    assert.match(res.headers.get('access-control-allow-headers',), /authorization/i,);
    assert.match(res.headers.get('access-control-allow-methods',), /POST/,);
  } finally {
    await close();
  }
},);

test('cors: a merchant myshopify origin is allowed', async () => {
  const { base, close, } = await boot();
  try {
    const origin = 'https://my-store.myshopify.com';
    const res = await fetch(`${base}/api/v1/ext/shop/me`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', },
    },);
    assert.strictEqual(res.status, 204,);
    assert.strictEqual(res.headers.get('access-control-allow-origin',), origin,);
  } finally {
    await close();
  }
},);

test('cors: the Shopify extension CDN origin is allowed', async () => {
  const { base, close, } = await boot();
  try {
    const res = await fetch(`${base}/api/v1/ext/shop/me`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://extensions.shopifycdn.com', 'Access-Control-Request-Method': 'POST', },
    },);
    assert.strictEqual(res.headers.get('access-control-allow-origin',), 'https://extensions.shopifycdn.com',);
  } finally {
    await close();
  }
},);

test('cors: an unrelated origin gets no CORS grant', async () => {
  const { base, close, } = await boot();
  try {
    const res = await fetch(`${base}/api/v1/ext/shop/me`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET', },
    },);
    assert.strictEqual(res.headers.get('access-control-allow-origin',), null,);
  } finally {
    await close();
  }
},);

test('cors: localhost is allowed for local development', async () => {
  const { base, close, } = await boot();
  try {
    const res = await fetch(`${base}/api/v1/ext/shop/me`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET', },
    },);
    assert.strictEqual(res.headers.get('access-control-allow-origin',), 'http://localhost:5173',);
  } finally {
    await close();
  }
},);

test('cors: credentials are never allowed (bearer-token auth only)', async () => {
  const { base, close, } = await boot();
  try {
    const res = await fetch(`${base}/health`, {
      headers: { Origin: 'https://admin.shopify.com', },
    },);
    assert.strictEqual(res.status, 200,);
    assert.strictEqual(res.headers.get('access-control-allow-origin',), 'https://admin.shopify.com',);
    // No cookie riding: the browser must never attach ambient credentials.
    assert.strictEqual(res.headers.get('access-control-allow-credentials',), null,);
  } finally {
    await close();
  }
},);

test('cors: a preflight is answered without authentication', async () => {
  const { base, close, } = await boot();
  try {
    // No credentials on a preflight — must not 401.
    const res = await fetch(`${base}/api/v1/customers/some_store`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://admin.shopify.com', 'Access-Control-Request-Method': 'GET', },
    },);
    assert.notStrictEqual(res.status, 401,);
    assert.strictEqual(res.status, 204,);
  } finally {
    await close();
  }
},);
