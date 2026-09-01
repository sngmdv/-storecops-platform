'use strict';

const { describe, it, beforeEach, afterEach, } = require('node:test',);
const assert = require('node:assert/strict',);
const { createDeepAudit, } = require('../src/layers/intelligence/deepAudit',);
const { createPdfService, } = require('../src/layers/execution/pdfService',);
const { createStore, } = require('../src/storage/store',);

// ── Mock fetch helper ──────────────────────────────────────────────
function mockFetch(responseBody, ok = true, status = 200,) {
  const fn = async (url, opts,) => ({
    ok,
    status,
    headers: new Map([['content-type', 'text/html',],],),
    text: async () => typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody,),
    arrayBuffer: async () => {
      const str = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody,);
      return Buffer.from(str,);
    },
  });
  fn.calls = [];
  const wrapped = async (url, opts,) => { fn.calls.push({ url, opts, },); return fn(url, opts,); };
  wrapped.calls = fn.calls;
  return wrapped;
}

// ── Deep Audit Unit Tests ──────────────────────────────────────────────

describe('Deep Audit Engine', () => {
  const store = createStore();
  const deepAudit = createDeepAudit({ store, config: { env: 'test', allowPrivateHosts: true, }, },);

  describe('assertSafeUrl', () => {
    it('accepts valid https URLs', () => {
      const parsed = deepAudit.assertSafeUrl('https://example.com',);
      assert.equal(parsed.hostname, 'example.com',);
    },);

    it('accepts URLs without protocol (adds https)', () => {
      const parsed = deepAudit.assertSafeUrl('example.com',);
      assert.equal(parsed.protocol, 'https:',);
    },);

    it('rejects private addresses', () => {
      assert.throws(() => deepAudit.assertSafeUrl('http://localhost:3000',), /Private/,);
      assert.throws(() => deepAudit.assertSafeUrl('http://127.0.0.1',), /Private/,);
      assert.throws(() => deepAudit.assertSafeUrl('http://192.168.1.1',), /Private/,);
    },);

    it('rejects invalid URLs', () => {
      assert.throws(() => deepAudit.assertSafeUrl('not a url',), /Invalid/,);
    },);

    it('normalizes non-http-starting URLs by prepending https', () => {
      // The function prepends https:// to URLs not starting with "http"
      const parsed = deepAudit.assertSafeUrl('example.com/store',);
      assert.equal(parsed.protocol, 'https:',);
      assert.equal(parsed.hostname, 'example.com',);
    },);
  },);

  describe('analyzeSeo', () => {
    it('extracts title and meta description', () => {
      const html = '<html><head><title>My Store - Best Products</title><meta name="description" content="Buy the best products online at great prices. Fast shipping worldwide."></head><body></body></html>';
      const seo = deepAudit.analyzeSeo(html, 'https://example.com',);
      assert.equal(seo.title, 'My Store - Best Products',);
      assert.ok(seo.description.includes('best products',),);
      assert.equal(seo.title_length, 24,);
    },);

    it('detects missing title', () => {
      const html = '<html><head></head><body></body></html>';
      const seo = deepAudit.analyzeSeo(html, 'https://example.com',);
      assert.equal(seo.title, null,);
      assert.equal(seo.title_length, 0,);
    },);

    it('counts H1 tags', () => {
      const html = '<h1>Welcome</h1><h1>Second</h1>';
      const seo = deepAudit.analyzeSeo(html, 'https://example.com',);
      assert.equal(seo.h1_count, 2,);
    },);

    it('detects images missing alt text', () => {
      const html = '<img src="a.jpg"><img src="b.jpg" alt="B"><img src="c.jpg">';
      const seo = deepAudit.analyzeSeo(html, 'https://example.com',);
      assert.equal(seo.total_images, 3,);
      assert.equal(seo.images_missing_alt, 2,);
      assert.equal(seo.alt_coverage_pct, 33,);
    },);

    it('detects JSON-LD structured data', () => {
      const html = '<script type="application/ld+json">{"@type":"Organization","name":"Test"}</script>';
      const seo = deepAudit.analyzeSeo(html, 'https://example.com',);
      assert.equal(seo.has_json_ld, true,);
      assert.deepEqual(seo.json_ld_types, ['Organization',],);
    },);

    it('extracts OpenGraph tags', () => {
      const html = '<meta property="og:title" content="My Page"><meta property="og:image" content="https://example.com/img.jpg"><meta property="og:description" content="A great page">';
      const seo = deepAudit.analyzeSeo(html, 'https://example.com',);
      assert.equal(seo.og_title, 'My Page',);
      assert.equal(seo.og_image, 'https://example.com/img.jpg',);
      assert.equal(seo.og_description, 'A great page',);
    },);

    it('detects canonical URL', () => {
      const html = '<link rel="canonical" href="https://example.com/page">';
      const seo = deepAudit.analyzeSeo(html, 'https://example.com',);
      assert.equal(seo.canonical, 'https://example.com/page',);
    },);

    it('detects viewport meta', () => {
      const html = '<meta name="viewport" content="width=device-width, initial-scale=1">';
      const seo = deepAudit.analyzeSeo(html, 'https://example.com',);
      assert.ok(seo.viewport.includes('width=device-width',),);
    },);

    it('detects twitter card', () => {
      const html = '<meta name="twitter:card" content="summary_large_image">';
      const seo = deepAudit.analyzeSeo(html, 'https://example.com',);
      assert.equal(seo.twitter_card, 'summary_large_image',);
    },);

    it('counts internal links', () => {
      const html = '<a href="/page1">Page 1</a><a href="https://example.com/page2">Page 2</a><a href="https://other.com">External</a>';
      const seo = deepAudit.analyzeSeo(html, 'https://example.com',);
      assert.equal(seo.total_links, 3,);
      assert.equal(seo.internal_links, 2,);
    },);
  },);

  describe('analyzePerformance', () => {
    it('calculates page weight and grades', () => {
      const pageData = { bytes: 500 * 1024, ttfb: 400, headers: new Map([['content-encoding', 'gzip',],],), };
      // Simulate headers object with get method
      pageData.headers = { get: (k,) => k === 'content-encoding' ? 'gzip' : null, };
      const perf = deepAudit.analyzePerformance(pageData,);
      assert.equal(perf.page_weight_kb, 500,);
      assert.equal(perf.ttfb_ms, 400,);
      assert.equal(perf.ttfb_grade, 'A',);
      assert.equal(perf.weight_grade, 'A',);
      assert.equal(perf.compression, 'gzip',);
    },);

    it('gives poor grade for slow/heavy pages', () => {
      const pageData = { bytes: 5000 * 1024, ttfb: 3000, headers: { get: () => null, }, };
      const perf = deepAudit.analyzePerformance(pageData,);
      assert.equal(perf.ttfb_grade, 'D',);
      assert.equal(perf.weight_grade, 'D',);
    },);
  },);

  describe('analyzeSecurity', () => {
    it('scores security headers', () => {
      const pageData = {
        headers: {
          get: (h,) => {
            const present = ['strict-transport-security', 'x-frame-options', 'x-content-type-options',];
            return present.includes(h,) ? 'yes' : null;
          },
        },
      };
      const sec = deepAudit.analyzeSecurity(pageData, 'https://example.com',);
      assert.equal(sec.https, true,);
      assert.equal(sec.headers_present.length, 3,);
      assert.equal(sec.headers_missing.length, 3,);
      assert.equal(sec.headers_score, 50,);
      assert.equal(sec.grade, 'B',); // 3 present → B (>= 3)
    },);

    it('detects non-HTTPS', () => {
      const pageData = { headers: { get: () => null, }, };
      const sec = deepAudit.analyzeSecurity(pageData, 'http://example.com',);
      assert.equal(sec.https, false,);
    },);
  },);

  describe('analyzeAiReadiness', () => {
    it('scores AI readiness based on signals', () => {
      const seo = {
        has_json_ld: true,
        json_ld_types: ['Organization', 'FAQPage',],
        og_title: 'Test',
        og_image: 'https://example.com/img.jpg',
      };
      const crawlability = {
        llms_txt: { found: true, },
        robots_txt: { allows_ai_crawlers: true, },
      };
      const ai = deepAudit.analyzeAiReadiness(seo, crawlability,);
      assert.equal(ai.score, 100,);
      assert.equal(ai.grade, 'A',);
      assert.equal(ai.signals.length, 6,);
    },);

    it('detects missing AI readiness signals', () => {
      const seo = { has_json_ld: false, json_ld_types: [], og_title: null, og_image: null, };
      const crawlability = { llms_txt: { found: false, }, robots_txt: { allows_ai_crawlers: false, }, };
      const ai = deepAudit.analyzeAiReadiness(seo, crawlability,);
      assert.equal(ai.score, 0,);
      assert.equal(ai.grade, 'D',);
    },);

    it('gives partial credit for mixed signals', () => {
      const seo = { has_json_ld: true, json_ld_types: ['Product',], og_title: 'Test', og_image: null, };
      const crawlability = { llms_txt: { found: false, }, robots_txt: { allows_ai_crawlers: false, }, };
      const ai = deepAudit.analyzeAiReadiness(seo, crawlability,);
      assert.ok(ai.score > 0 && ai.score < 100,);
    },);
  },);

  describe('Full audit (integration)', () => {
    const mockHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Test Store - Best Products Online</title>
  <meta name="description" content="Buy the best products at great prices">
  <meta property="og:title" content="Test Store">
  <meta property="og:image" content="https://example.com/og.jpg">
  <meta property="og:description" content="Best products online">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="twitter:card" content="summary">
  <link rel="canonical" href="https://example.com">
  <script type="application/ld+json">{"@type":"Organization","name":"Test Store"}</script>
</head>
<body>
  <h1>Welcome to Test Store</h1>
  <img src="product1.jpg" alt="Product 1">
  <img src="product2.jpg">
  <a href="/about">About</a>
  <a href="https://example.com/contact">Contact</a>
</body>
</html>`;
    const mockRobotsTxt = 'User-agent: *\nAllow: /\nUser-agent: GPTBot\nAllow: /';
    const mockSitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
</urlset>`;
    const mockLlmsTxt = '# Test Store\n## About\nWe sell the best products.';

    let origFetch;
    beforeEach(() => {
      origFetch = globalThis.fetch;
      let callCount = 0;
      globalThis.fetch = async (url, opts,) => {
        callCount++;
        const urlStr = typeof url === 'string' ? url : url.toString();
        let content = mockHtml;
        let contentType = 'text/html';
        let status = 200;
        let ok = true;

        if (urlStr.includes('robots.txt',)) {
          content = mockRobotsTxt;
          contentType = 'text/plain';
        } else if (urlStr.includes('sitemap.xml',)) {
          content = mockSitemapXml;
          contentType = 'application/xml';
        } else if (urlStr.includes('llms.txt',)) {
          content = mockLlmsTxt;
          contentType = 'text/plain';
        } else if (urlStr.includes('favicon.ico',)) {
          content = '';
          status = 404;
          ok = false;
        }

        const buf = Buffer.from(content,);
        return {
          ok,
          status,
          headers: new Map([['content-type', contentType,], ['content-encoding', 'identity',],],),
          text: async () => content,
          arrayBuffer: async () => buf,
        };
      };
    },);
    afterEach(() => {
      globalThis.fetch = origFetch;
    },);

    it('runs a complete audit and stores the report', async () => {
      const report = await deepAudit.audit('https://example.com',);
      assert.ok(report.report_id,);
      assert.ok(report.overall_score >= 0 && report.overall_score <= 100,);
      assert.ok(['A', 'B', 'C', 'D', 'F',].includes(report.grade,),);
      assert.ok(report.categories,);
      assert.ok(report.categories.seo,);
      assert.ok(report.categories.performance,);
      assert.ok(report.categories.security,);
      assert.ok(report.categories.crawlability,);
      assert.ok(report.ai_readiness,);
      assert.ok(typeof report.passed_checks === 'number',);
      assert.ok(typeof report.total_checks === 'number',);
      assert.ok(Array.isArray(report.top_issues,),);

      // Verify it was stored
      const stored = await store.deepAudits.findById(report.report_id,);
      assert.ok(stored,);
      assert.equal(stored.url, report.url,);
    },);

    it('audit report has weighted category scores', async () => {
      const report = await deepAudit.audit('https://example.com',);
      assert.ok(report.categories.seo.checks.length >= 5,);
      assert.ok(report.categories.performance.checks.length >= 3,);
      assert.ok(report.categories.security.checks.length >= 2,);
      assert.ok(report.categories.crawlability.checks.length >= 3,);
    },);

    it('audit report has AI readiness signals', async () => {
      const report = await deepAudit.audit('https://example.com',);
      assert.ok(Array.isArray(report.ai_readiness.signals,),);
      assert.ok(report.ai_readiness.signals.length >= 4,);
      for (const signal of report.ai_readiness.signals) {
        assert.ok(signal.signal,);
        assert.ok(['pass', 'warn', 'fail',].includes(signal.status,),);
        assert.ok(signal.detail,);
      }
    },);
  },);
},);

// ── PDF Service Tests ──────────────────────────────────────────────────

describe('PDF Service', () => {
  const pdfService = createPdfService({ config: { publicUrl: 'https://storecops.com', }, },);

  it('generates a PDF buffer from a report', async () => {
    const report = {
      report_id: 'test-report-1',
      url: 'https://example.com',
      audited_at: new Date().toISOString(),
      overall_score: 72,
      grade: 'B',
      passed_checks: 18,
      total_checks: 25,
      categories: {
        seo: { score: 80, checks: [
          { label: 'Title tag', pass: true, weight: 15, },
          { label: 'Meta description', pass: true, weight: 12, },
          { label: 'Single H1', pass: false, weight: 10, },
        ], },
        performance: { score: 65, checks: [
          { label: 'TTFB < 800ms', pass: true, weight: 25, },
          { label: 'Compression', pass: false, weight: 25, },
        ], },
        security: { score: 50, checks: [
          { label: 'HTTPS', pass: true, weight: 30, },
          { label: 'Security headers', pass: false, weight: 40, },
        ], },
        crawlability: { score: 70, checks: [
          { label: 'robots.txt', pass: true, weight: 25, },
          { label: 'sitemap.xml', pass: true, weight: 25, },
          { label: 'llms.txt', pass: false, weight: 20, },
        ], },
      },
      ai_readiness: {
        score: 45,
        grade: 'D',
        signals: [
          { signal: 'structured_data', status: 'pass', detail: 'Types: Organization', },
          { signal: 'llms_txt', status: 'fail', detail: 'No /llms.txt found', },
          { signal: 'faq_schema', status: 'fail', detail: 'No FAQ schema', },
          { signal: 'entity_markup', status: 'pass', detail: 'Organization schema present', },
        ],
      },
      top_issues: [
        { label: 'Security headers', category: 'Security', weight: 40, },
        { label: 'Compression', category: 'Performance', weight: 25, },
        { label: 'llms.txt', category: 'Crawlability', weight: 20, },
      ],
    };

    const pdfBuffer = await pdfService.generateReportPdf(report,);
    assert.ok(Buffer.isBuffer(pdfBuffer,),);
    assert.ok(pdfBuffer.length > 1000,); // PDF should be at least 1KB

    // Verify it starts with PDF magic bytes
    assert.equal(pdfBuffer[0], 0x25,); // %
    assert.equal(pdfBuffer[1], 0x50,); // P
    assert.equal(pdfBuffer[2], 0x44,); // D
    assert.equal(pdfBuffer[3], 0x46,); // F
  },);

  it('includes pricing plans in the PDF', async () => {
    const report = {
      url: 'https://test.com',
      audited_at: new Date().toISOString(),
      overall_score: 45,
      grade: 'D',
      passed_checks: 8,
      total_checks: 25,
      categories: {
        seo: { score: 40, checks: [], },
        performance: { score: 50, checks: [], },
        security: { score: 30, checks: [], },
        crawlability: { score: 60, checks: [], },
      },
      ai_readiness: { score: 20, signals: [], },
      top_issues: [{ label: 'Many issues', category: 'SEO', weight: 30, },],
    };

    const pdfBuffer = await pdfService.generateReportPdf(report,);
    assert.ok(pdfBuffer.length > 5000,); // Multi-page PDF with pricing
  },);
},);
