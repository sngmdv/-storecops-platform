"use strict";

process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert");
const { createPlatform } = require("../src/platform");
const { createApp } = require("../src/server/createApp");
const { createSeoAutoFix } = require("../src/layers/intelligence/seoAutoFix");

// ── helpers ──────────────────────────────────────────────────────

function bootServer() {
  const platform = createPlatform();
  const app = createApp(platform);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        platform,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** A deliberately broken audit report with multiple failing checks. */
function makeBadAudit() {
  return {
    url: "https://example-store.com",
    final_url: "https://example-store.com",
    score: 35,
    grade: "F",
    checks: [
      { key: "title", check: "title_tag", status: "FAIL", pass: false, detail: "missing", weight: 1.5 },
      { key: "meta_description", check: "meta_description", status: "FAIL", pass: false, detail: "missing", weight: 1 },
      { key: "h1", check: "single_h1", status: "FAIL", pass: false, detail: "3 H1 tags", weight: 1 },
      { key: "structured", status: "FAIL", detail: "OpenGraph ✗ · JSON-LD ✗", weight: 1 },
      { key: "viewport", check: "mobile_viewport", status: "FAIL", pass: false, detail: "missing", weight: 1.5 },
      { key: "security_headers", status: "WARN", detail: "3 missing: CSP, X-Frame-Options, Referrer-Policy", weight: 1.5 },
      { key: "alt", status: "WARN", detail: "60% of 10 image(s)", weight: 1 },
      { key: "crawlables", status: "WARN", detail: "robots 200 · sitemap 404 · favicon 404", weight: 1 },
      { key: "canonical", check: "canonical_link", status: "FAIL", pass: false, detail: "missing", weight: 1 },
    ],
  };
}

/** A perfect audit — all checks pass. */
function makePerfectAudit() {
  return {
    url: "https://perfect-store.com",
    final_url: "https://perfect-store.com",
    score: 100,
    grade: "A",
    checks: [
      { key: "title", check: "title_tag", status: "PASS", pass: true, detail: "Perfect Store — Best Products", weight: 1.5 },
      { key: "meta_description", check: "meta_description", status: "PASS", pass: true, detail: "150 chars", weight: 1 },
      { key: "h1", check: "single_h1", status: "PASS", pass: true, detail: "1 H1 tag", weight: 1 },
      { key: "structured", status: "PASS", detail: "OpenGraph ✓ · JSON-LD ✓", weight: 1 },
      { key: "viewport", check: "mobile_viewport", status: "PASS", pass: true, detail: "present", weight: 1.5 },
      { key: "security_headers", status: "PASS", detail: "all present", weight: 1.5 },
      { key: "alt", status: "PASS", detail: "100% of 5 image(s)", weight: 1 },
      { key: "crawlables", status: "PASS", detail: "all found", weight: 1 },
      { key: "canonical", check: "canonical_link", status: "PASS", pass: true, detail: "https://perfect-store.com", weight: 1 },
    ],
  };
}

// ── Unit tests: generateFixes ────────────────────────────────────

test("seoAutoFix: generateFixes produces fixes for failing checks", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFixes(audit, {
    brand: "Example Store",
    keywords: ["shoes", "leather"],
    category: "Fashion",
  });

  assert.ok(result.fixes.length > 0, "should have fixes");
  assert.strictEqual(result.store_url, "https://example-store.com");
  assert.strictEqual(result.brand, "Example Store");
  assert.ok(result.current_score < 100, "current score should be low");
  assert.strictEqual(result.potential_score, 100);
});

test("seoAutoFix: generateFixes includes title_tag fix when title is missing", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFixes(audit, {
    brand: "TestBrand",
    keywords: ["widgets"],
  });

  const titleFix = result.fixes.find((f) => f.area === "title_tag");
  assert.ok(titleFix, "should have title_tag fix");
  assert.strictEqual(titleFix.severity, "HIGH");
  assert.ok(result.snippets.title_tag, "should have title_tag snippet");
  assert.ok(result.snippets.title_tag.html.includes("TestBrand"), "snippet should contain brand");
});

test("seoAutoFix: generateFixes includes meta_description fix", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFixes(audit, {
    brand: "MyShop",
    keywords: ["electronics"],
    category: "Tech",
  });

  const descFix = result.fixes.find((f) => f.area === "meta_description");
  assert.ok(descFix, "should have meta_description fix");
  assert.ok(result.snippets.meta_description.html.includes("MyShop"), "snippet should contain brand");
});

test("seoAutoFix: generateFixes includes open_graph and structured_data", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFixes(audit, { brand: "Store" });

  assert.ok(result.fixes.find((f) => f.area === "open_graph"), "should have OG fix");
  assert.ok(result.fixes.find((f) => f.area === "structured_data"), "should have structured data fix");
  assert.ok(result.snippets.open_graph, "should have OG snippet");
  assert.ok(result.snippets.structured_data, "should have structured data snippet");
});

test("seoAutoFix: generateFixes includes viewport fix when missing", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFixes(audit, { brand: "Store" });

  const vpFix = result.fixes.find((f) => f.area === "viewport");
  assert.ok(vpFix, "should have viewport fix");
  assert.strictEqual(vpFix.severity, "CRITICAL");
  assert.ok(result.snippets.viewport.html.includes("viewport"));
});

test("seoAutoFix: generateFixes includes security headers fix", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFixes(audit, { brand: "Store" });

  const secFix = result.fixes.find((f) => f.area === "security_headers");
  assert.ok(secFix, "should have security headers fix");
  assert.ok(result.snippets.security_headers.nginx, "should have nginx config");
  assert.ok(result.snippets.security_headers.apache, "should have apache config");
  assert.ok(result.snippets.security_headers.cloudflare, "should have cloudflare config");
});

test("seoAutoFix: generateFixes includes robots.txt when missing", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFixes(audit, { brand: "Store" });

  const robFix = result.fixes.find((f) => f.area === "robots_txt");
  assert.ok(robFix, "should have robots_txt fix");
  assert.ok(result.snippets.robots_txt.includes("Sitemap:"), "robots.txt should reference sitemap");
  assert.ok(result.snippets.robots_txt.includes("GPTBot"), "robots.txt should allow AI crawlers");
});

test("seoAutoFix: perfect audit produces zero fixes", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makePerfectAudit();
  const result = seoAutoFix.generateFixes(audit, { brand: "Perfect" });

  assert.strictEqual(result.fixes.length, 0, "should have zero fixes");
  assert.strictEqual(result.current_score, 100, "score should be 100");
});

test("seoAutoFix: generateFixes throws when audit is missing", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  assert.throws(() => seoAutoFix.generateFixes(null), /audit report is required/);
});

test("seoAutoFix: fixes include all severity levels from a bad audit", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFixes(audit, { brand: "Store" });

  const severities = new Set(result.fixes.map((f) => f.severity));
  assert.ok(severities.has("CRITICAL"), "should have at least one CRITICAL fix");
  assert.ok(severities.has("HIGH"), "should have at least one HIGH fix");
  assert.ok(severities.has("MEDIUM"), "should have at least one MEDIUM fix");
  assert.ok(result.fixes.length >= 5, "should have multiple fixes");
});

// ── Unit tests: generateAiOptimization ───────────────────────────

test("seoAutoFix: generateAiOptimization returns AI actions and snippets", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const result = seoAutoFix.generateAiOptimization({
    brand: "TestBrand",
    domain: "testbrand.com",
    storeUrl: "https://testbrand.com",
    keywords: ["shoes", "leather"],
    category: "Fashion",
  });

  assert.ok(result.actions.length > 0, "should have AI actions");
  assert.ok(result.snippets.llms_txt, "should have llms.txt snippet");
  assert.ok(result.snippets.faq_schema, "should have FAQ schema");
  assert.ok(result.snippets.entity_markup, "should have entity markup");
  assert.ok(result.snippets.ai_content, "should have AI-friendly content");
  assert.ok(typeof result.ai_readiness_score === "number", "should have readiness score");
});

test("seoAutoFix: llms.txt contains brand and keywords", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const result = seoAutoFix.generateAiOptimization({
    brand: "CoolStore",
    domain: "coolstore.com",
    keywords: ["gadgets", "tech"],
    category: "Electronics",
  });

  const llms = result.snippets.llms_txt;
  assert.ok(llms.includes("CoolStore"), "llms.txt should mention brand");
  assert.ok(llms.includes("coolstore.com"), "llms.txt should mention domain");
  assert.ok(llms.includes("gadgets"), "llms.txt should mention keywords");
  assert.ok(llms.includes("AI"), "llms.txt should reference AI");
});

test("seoAutoFix: FAQ schema contains questions and answers", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const result = seoAutoFix.generateAiOptimization({
    brand: "MyBrand",
    category: "Shoes",
    keywords: ["sneakers"],
  });

  const faq = result.snippets.faq_schema;
  assert.ok(faq.html.includes("FAQPage"), "should have FAQPage schema type");
  assert.ok(faq.html.includes("MyBrand"), "should mention brand in FAQ");
  assert.ok(faq.faqs.length >= 3, "should have at least 3 FAQ items");
});

test("seoAutoFix: entity markup includes sameAs for social profiles", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const result = seoAutoFix.generateAiOptimization({
    brand: "Brand",
    domain: "brand.com",
    storeUrl: "https://brand.com",
    socialProfiles: {
      facebook: "https://facebook.com/brand",
      instagram: "https://instagram.com/brand",
      twitter: "https://twitter.com/brand",
    },
  });

  const entity = result.snippets.entity_markup;
  assert.ok(entity.html.includes("Store"), "should have Store schema type");
  assert.ok(entity.sameAs.length === 3, "should have 3 sameAs links");
  assert.ok(entity.sameAs.includes("https://facebook.com/brand"));
});

test("seoAutoFix: AI content generates brand statements", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const result = seoAutoFix.generateAiOptimization({
    brand: "Acme",
    category: "Tools",
    keywords: ["hammers", "drills"],
  });

  const content = result.snippets.ai_content;
  assert.ok(content.brand_statement.includes("Acme"), "should mention brand");
  assert.ok(content.brand_statement.includes("hammers"), "should mention keywords");
  assert.ok(content.why_choose_us.length >= 3, "should have multiple reasons");
});

test("seoAutoFix: ai_readiness_score is between 0 and 100", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const result = seoAutoFix.generateAiOptimization({ brand: "Test" });

  assert.ok(result.ai_readiness_score >= 0, "score should be >= 0");
  assert.ok(result.ai_readiness_score <= 100, "score should be <= 100");
});

// ── Unit tests: generateFullOptimization ─────────────────────────

test("seoAutoFix: generateFullOptimization combines SEO + AI", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFullOptimization(audit, {
    brand: "FullStore",
    domain: "fullstore.com",
    storeUrl: "https://fullstore.com",
    keywords: ["apparel"],
    category: "Fashion",
  });

  assert.ok(result.fixes.length > 0, "should have SEO fixes");
  assert.ok(result.ai_optimization, "should have AI optimization");
  assert.ok(result.ai_optimization.actions.length > 0, "should have AI actions");
  assert.ok(result.total_actions > result.fixes_count, "total should exceed SEO-only");
  assert.ok(result.total_actions === result.fixes_count + result.ai_optimization.actions.length);
});

// ── Unit tests: snippet content validation ───────────────────────

test("seoAutoFix: JSON-LD includes Organization and WebSite schemas", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFixes(audit, { brand: "SchemaStore", domain: "schema.com" });

  const sd = result.snippets.structured_data;
  assert.ok(sd.schemas.length >= 2, "should have at least 2 schemas");
  assert.strictEqual(sd.schemas[0]["@type"], "Organization");
  assert.strictEqual(sd.schemas[1]["@type"], "WebSite");
  assert.ok(sd.html.includes("application/ld+json"), "should include script tag");
});

test("seoAutoFix: Shopify Liquid templates are included where applicable", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFixes(audit, { brand: "ShopifyStore" });

  assert.ok(result.snippets.title_tag.shopify, "title should have Shopify variant");
  assert.ok(result.snippets.meta_description.shopify, "meta desc should have Shopify variant");
  assert.ok(result.snippets.structured_data.shopify, "structured data should have Shopify variant");
  assert.ok(result.snippets.title_tag.shopify.includes("theme.liquid"), "should reference theme.liquid");
});

test("seoAutoFix: HowTo schema is generated for AI optimization", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const result = seoAutoFix.generateAiOptimization({
    brand: "GuideStore",
    category: "Cooking",
  });

  const howto = result.snippets.howto_schema;
  assert.ok(howto.html.includes("HowTo"), "should have HowTo type");
  assert.ok(howto.html.includes("GuideStore"), "should mention brand");
});

test("seoAutoFix: BreadcrumbList schema is generated", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const result = seoAutoFix.generateAiOptimization({
    brand: "NavStore",
    category: "Books",
  });

  const bc = result.snippets.breadcrumb_schema;
  assert.ok(bc.html.includes("BreadcrumbList"), "should have BreadcrumbList type");
  assert.ok(bc.html.includes("Books"), "should include category");
});

// ── HTTP API tests ───────────────────────────────────────────────

test("POST /seo/ai-optimize returns AI optimization", async () => {
  const { base, close } = await bootServer();
  try {
    const res = await fetch(`${base}/api/v1/seo/ai-optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "dev-key" },
      body: JSON.stringify({
        brand: "APITest",
        domain: "apitest.com",
        storeUrl: "https://apitest.com",
        keywords: ["widgets"],
        category: "Tools",
      }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.actions, "should have actions");
    assert.ok(data.snippets, "should have snippets");
    assert.ok(typeof data.ai_readiness_score === "number");
  } finally {
    await close();
  }
});

test("POST /seo/optimize runs full optimization and saves result", async () => {
  // Boot a fake store for the audit to hit
  const fakeStore = new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>`);
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })
    );
  });

  const store = await fakeStore;
  const { base, close, platform } = await bootServer();
  try {
    const res = await fetch(`${base}/api/v1/seo/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "dev-key" },
      body: JSON.stringify({
        url: store.url,
        brand: "TestBrand",
        keywords: ["test"],
        category: "Testing",
        store_id: "store-1",
      }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.fixes_count >= 0, "should have fixes count");
    assert.ok(data.ai_optimization, "should have AI optimization");
    assert.ok(data.total_actions >= 0, "should have total actions");
    assert.ok(data._id, "should be saved with an ID");

    // Verify it was persisted
    const saved = await platform.store.seoOptimizations.findById(data._id);
    assert.ok(saved, "optimization should be persisted in store");
    assert.strictEqual(saved.brand, "TestBrand");
  } finally {
    await close();
    store.close();
  }
});

test("GET /seo/optimizations/:store_id returns saved optimizations", async () => {
  const { base, close, platform } = await bootServer();
  try {
    // Insert a test optimization
    await platform.store.seoOptimizations.insert({
      store_id: "test-store",
      brand: "SavedBrand",
      fixes_count: 5,
      generated_at: new Date().toISOString(),
    });

    const res = await fetch(`${base}/api/v1/seo/optimizations/test-store`, {
      headers: { "X-API-Key": "dev-key" },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data), "should return array");
    assert.ok(data.length >= 1, "should have at least 1 optimization");
    assert.strictEqual(data[0].brand, "SavedBrand");
  } finally {
    await close();
  }
});

// ── Edge cases ───────────────────────────────────────────────────

test("seoAutoFix: generateFixes handles audit with no checks array", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const result = seoAutoFix.generateFixes({ url: "https://test.com", checks: [] }, { brand: "Test" });
  // With empty checks, OG/structured/robots are still suggested since they can't be confirmed
  assert.ok(Array.isArray(result.fixes), "should return fixes array");
  // Score is 0/0 which is NaN → 0 via Math.round
  assert.ok(typeof result.current_score === "number", "score should be a number");
});

test("seoAutoFix: generateAiOptimization uses defaults when no params given", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const result = seoAutoFix.generateAiOptimization({});

  assert.ok(result.actions.length > 0, "should still generate actions");
  assert.ok(result.snippets.llms_txt.includes("Our Store"), "should use default brand");
});

test("seoAutoFix: escapeHtml handles special characters", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const audit = makeBadAudit();
  const result = seoAutoFix.generateFixes(audit, {
    brand: 'Brand "with" <special> & chars',
  });

  const titleSnippet = result.snippets.title_tag?.html || "";
  assert.ok(!titleSnippet.includes('"with"'), "should escape quotes");
  assert.ok(!titleSnippet.includes("<special>"), "should escape angle brackets");
});

test("seoAutoFix: generateFixes handles audit with only some failing checks", () => {
  const seoAutoFix = createSeoAutoFix({ store: {}, seoGrowth: {} });
  const partialAudit = {
    url: "https://partial.com",
    checks: [
      { key: "title", check: "title_tag", status: "PASS", pass: true, detail: "Good title", weight: 1.5 },
      { key: "meta_description", check: "meta_description", status: "FAIL", pass: false, detail: "missing", weight: 1 },
      { key: "viewport", check: "mobile_viewport", status: "PASS", pass: true, detail: "present", weight: 1.5 },
    ],
  };

  const result = seoAutoFix.generateFixes(partialAudit, { brand: "Partial" });
  assert.ok(result.fixes.length >= 1, "should have at least 1 fix (meta_description)");
  assert.ok(!result.fixes.find((f) => f.area === "title_tag"), "should not fix passing title");
  assert.ok(!result.fixes.find((f) => f.area === "viewport"), "should not fix passing viewport");
});
