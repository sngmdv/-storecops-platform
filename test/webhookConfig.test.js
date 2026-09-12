'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const fs = require('node:fs',);
const path = require('node:path',);

const ROOT = path.join(__dirname, '..',);

/**
 * Shopify webhooks are registered by TWO mechanisms:
 *
 *   1. Declaratively, via [[webhooks.subscriptions]] in shopify.app.toml, which
 *      the CLI pushes on deploy.
 *   2. At runtime, via the Admin API in integrations.registerComplianceWebhooks,
 *      called during the OAuth callback.
 *
 * Both exist on purpose: the declarative entry guarantees the mandatory
 * compliance topics are registered even if the runtime call fails, and the
 * runtime call covers stores installed before the manifest changed.
 *
 * The hazard is drift. If someone edits an address in one place and not the
 * other, Shopify treats them as two different webhooks and the app receives
 * duplicate deliveries — one of which may 404. These tests make that
 * impossible to do silently.
 */

/** Strip comment lines so prose that mentions a section header is not parsed as one. */
function stripComments(text,) {
  return text
    .split(/\r?\n/,)
    .filter((line,) => !line.trim().startsWith('#',),)
    .join('\n',);
}

/** Pull declared subscriptions out of shopify.app.toml. */
function declaredSubscriptions() {
  const raw = fs.readFileSync(path.join(ROOT, 'shopify.app.toml',), 'utf8',);
  const text = stripComments(raw,);
  const blocks = text.split(/\[\[webhooks\.subscriptions\]\]/,).slice(1,);
  return blocks.map((block,) => {
    const uri = /uri\s*=\s*"([^"]+)"/.exec(block,);
    const topics = /topics\s*=\s*\[([^\]]*)\]/.exec(block,);
    const compliance = /compliance_topics\s*=\s*\[([^\]]*)\]/.exec(block,);
    const parseList = (m,) => m
      ? m[1].split(',',).map((s,) => s.trim().replace(/^"|"$/g, '',),).filter(Boolean,)
      : [];
    return {
      uri: uri ? uri[1] : null,
      topics: [...parseList(topics,), ...parseList(compliance,),],
    };
  },);
}

/** Pull the runtime compliance registrations out of integrations.js. */
function runtimeCompliance() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'server', 'integrations.js',), 'utf8',);
  const out = [];
  const re = /topic:\s*'([^']+)',\s*address:\s*`\$\{base\}([^`]+)`/g;
  let m;
  while ((m = re.exec(src,)) !== null) out.push({ topic: m[1], uri: m[2], },);
  return out;
}

/** Every route path declared anywhere in src/. */
function allRoutes() {
  const routes = new Set();
  const walk = (dir,) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, },)) {
      const full = path.join(dir, entry.name,);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full,);
      } else if (entry.name.endsWith('.js',)) {
        const src = fs.readFileSync(full, 'utf8',);
        const re = /(?:app|router)\.(?:get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
        let m;
        while ((m = re.exec(src,)) !== null) routes.add(m[1],);
      }
    }
  };
  walk(path.join(ROOT, 'src',),);
  return routes;
}

test('webhooks: the manifest declares at least one subscription', () => {
  const subs = declaredSubscriptions();
  assert.ok(subs.length > 0, 'expected shopify.app.toml to declare webhook subscriptions',);
},);

test('webhooks: every declared subscription has a uri and at least one topic', () => {
  for (const sub of declaredSubscriptions()) {
    assert.ok(sub.uri, 'a subscription is missing its uri',);
    assert.ok(sub.topics.length > 0, `subscription ${sub.uri} declares no topics`,);
  }
},);

test('webhooks: every declared uri resolves to a real route', () => {
  const routes = allRoutes();
  for (const sub of declaredSubscriptions()) {
    // Allow :param wildcards on either side.
    const asPattern = new RegExp(
      `^${sub.uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&',).replace(/:[A-Za-z0-9_]+/g, '[^/]+',)}$`,
    );
    const found = routes.has(sub.uri,) || [...routes,].some((r,) => asPattern.test(r,),);
    assert.ok(
      found,
      `shopify.app.toml declares ${sub.uri} but no route matches it — Shopify would ` +
      'POST to a dead endpoint on every event',
    );
  }
},);

test('webhooks: the manifest and the runtime registration agree exactly', () => {
  const declared = new Map(
    declaredSubscriptions().flatMap((s,) => s.topics.map((t,) => [t, s.uri,],),),
  );
  const runtime = runtimeCompliance();
  assert.ok(runtime.length > 0, 'expected registerComplianceWebhooks to declare topics',);

  for (const { topic, uri, } of runtime) {
    assert.ok(
      declared.has(topic,),
      `integrations.js registers "${topic}" at runtime but shopify.app.toml does not ` +
      'declare it — the two mechanisms have drifted',
    );
    assert.strictEqual(
      declared.get(topic,),
      uri,
      `"${topic}" is registered at ${uri} at runtime but declared as ` +
      `${declared.get(topic,)} in shopify.app.toml — Shopify will treat these as two ` +
      'separate webhooks and deliver twice',
    );
  }

  // And the reverse: nothing declared that the runtime forgets to register.
  const runtimeTopics = new Set(runtime.map((r,) => r.topic,),);
  for (const topic of declared.keys()) {
    assert.ok(
      runtimeTopics.has(topic,),
      `shopify.app.toml declares "${topic}" but registerComplianceWebhooks does not ` +
      'register it at runtime',
    );
  }
},);

test('webhooks: the mandatory compliance topics are all declared', () => {
  const declared = new Set(declaredSubscriptions().flatMap((s,) => s.topics,),);
  for (const topic of ['customers/data_request', 'customers/redact', 'shop/redact', 'app/uninstalled',]) {
    assert.ok(declared.has(topic,), `mandatory topic "${topic}" is not declared`,);
  }
},);

test('webhooks: no declarative subscription points at a non-compliance Shopify path', () => {
  // Guards the specific past mistake: declaring orders/create, products/update,
  // inventory_levels/update and refunds/create against routes that never existed.
  const subs = declaredSubscriptions();
  for (const sub of subs) {
    assert.ok(
      sub.uri.startsWith('/webhooks/shopify/',),
      `unexpected declarative webhook uri ${sub.uri}`,
    );
  }
},);
