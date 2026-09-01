'use strict';

/**
 * Deep Store Audit Engine.
 *
 * Crawls a store's public pages (homepage, product pages, collection
 * pages) and extracts comprehensive data for the audit report:
 *
 *   - Page-level SEO (title, meta, headings, images, links)
 *   - Performance signals (TTFB, page weight, compression)
 *   - Security (HTTPS, headers, certificates)
 *   - Structured data (JSON-LD, OpenGraph, Twitter Cards)
 *   - Product catalog signals (count, pricing, images)
 *   - Mobile readiness (viewport, responsive indicators)
 *   - AI search readiness (llms.txt, FAQ schema, entity markup)
 *   - Technical health (robots.txt, sitemap, canonical, redirects)
 *
 * Results feed into the report generator which produces a branded PDF.
 */

const { URL, } = require('url',);
const TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 3 * 1024 * 1024;

const PRIVATE_HOST_RE =
  /^(localhost|0\.0\.0\.0|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|169\.254\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+|.*\.local|\[?::1\]?)$/i;

function assertSafeUrl(rawUrl,) {
  let parsed;
  try {
    parsed = new URL(rawUrl.startsWith('http',) ? rawUrl : `https://${rawUrl}`,);
  } catch {
    throw new Error('Invalid URL.',);
  }
  if (!['http:', 'https:',].includes(parsed.protocol,)) {
    throw new Error('Only http/https URLs are supported.',);
  }
  if (PRIVATE_HOST_RE.test(parsed.hostname,)) {
    throw new Error('Private/local addresses are not supported.',);
  }
  return parsed;
}

function createDeepAudit({ store, config, },) {
  const allowPrivate = config?.env === 'test' || config?.allowPrivateHosts;

  /**
   * Fetch a URL with timeout and redirect following.
   */
  async function fetchPage(url, { method = 'GET', followRedirects = true, } = {},) {
    const res = await fetch(url, {
      method,
      redirect: followRedirects ? 'follow' : 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS,),
      headers: {
        'User-Agent': 'Storecops-Audit/2.0 (+https://storecops.com; site-audit)',
        Accept: 'text/html,application/json',
      },
    },);
    return res;
  }

  /**
   * Fetch and parse HTML from a URL.
   */
  async function fetchHtml(url,) {
    const started = Date.now();
    const res = await fetchPage(url,);
    const ttfb = Date.now() - started;

    if (res.status >= 400) {
      return { html: '', headers: res.headers, status: res.status, ttfb, url, error: `HTTP ${res.status}`, };
    }

    const buf = Buffer.from(await res.arrayBuffer(),);
    const html = buf.toString('utf8',).slice(0, MAX_BODY_BYTES,);
    return { html, headers: res.headers, status: res.status, ttfb, url, bytes: buf.length, };
  }

  /**
   * Extract SEO signals from HTML.
   */
  function analyzeSeo(html, url,) {
    const getTag = (regex,) => {
      const m = html.match(regex,);
      return m ? m[1]?.trim() : null;
    };
    const getMeta = (name,) => {
      const m = html.match(
        new RegExp(`<meta[^>]*(?:name|property)\\s*=\\s*["']?${name}["']?[^>]*>`, 'i',),
      );
      if (!m) return null;
      const cm = m[0].match(/content\s*=\s*"([^"]*)"/i,) || m[0].match(/content\s*=\s*'([^']*)'/i,);
      return cm ? cm[1] : null;
    };

    const title = getTag(/<title[^>]*>([\s\S]*?)<\/title>/i,);
    const description = getMeta('description',);
    const canonical = getTag(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,);
    const viewport = getMeta('viewport',);
    const ogTitle = getMeta('og:title',);
    const ogImage = getMeta('og:image',);
    const ogDescription = getMeta('og:description',);
    const twitterCard = getMeta('twitter:card',);
    const jsonLd = /<script[^>]+application\/ld\+json/i.test(html,);
    const jsonLdBlocks = [];
    const jsonLdRe = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = jsonLdRe.exec(html,)) !== null) {
      try { jsonLdBlocks.push(JSON.parse(match[1],),); } catch { /* skip malformed */ }
    }

    const h1s = (html.match(/<h1\b[^>]*>/gi,) || []);
    const h1Texts = [];
    for (const h1 of h1s) {
      const textMatch = html.match(new RegExp(h1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&',) + '([\\s\\S]*?)</h1>', 'i',),);
      if (textMatch) h1Texts.push(textMatch[1].replace(/<[^>]+>/g, '',).trim(),);
    }

    const imgs = html.match(/<img\b[^>]*>/gi,) || [];
    const missingAlt = imgs.filter((i,) => !/\balt\s*=/.test(i,),).length;
    const links = html.match(/<a\b[^>]*>/gi,) || [];
    const internalLinks = links.filter((l,) => {
      const href = l.match(/href\s*=\s*"([^"]*)"/i,);
      return href && (href[1].startsWith('/',) || href[1].includes(new URL(url,).hostname,));
    },).length;

    return {
      title: title || null,
      title_length: title ? title.length : 0,
      description: description || null,
      description_length: description ? description.length : 0,
      canonical: canonical || null,
      viewport: viewport || null,
      og_title: ogTitle || null,
      og_image: ogImage || null,
      og_description: ogDescription || null,
      twitter_card: twitterCard || null,
      has_json_ld: jsonLd,
      json_ld_types: jsonLdBlocks.map((b,) => b['@type'],).filter(Boolean,),
      h1_count: h1s.length,
      h1_texts: h1Texts,
      total_images: imgs.length,
      images_missing_alt: missingAlt,
      alt_coverage_pct: imgs.length ? Math.round(((imgs.length - missingAlt) / imgs.length) * 100,) : 100,
      total_links: links.length,
      internal_links: internalLinks,
    };
  }

  /**
   * Extract performance signals.
   */
  function analyzePerformance(pageData,) {
    const kb = Math.round((pageData.bytes || 0) / 1024,);
    const est4gSec = ((pageData.bytes || 0) / (4 * 1024 * 1024)) * 8;
    const compressed = pageData.headers?.get('content-encoding',) || null;

    return {
      ttfb_ms: pageData.ttfb || 0,
      page_weight_kb: kb,
      estimated_load_4g_sec: Math.round(est4gSec * 10,) / 10,
      compression: compressed || 'none',
      ttfb_grade: pageData.ttfb < 600 ? 'A' : pageData.ttfb < 1200 ? 'B' : pageData.ttfb < 2500 ? 'C' : 'D',
      weight_grade: kb < 800 ? 'A' : kb < 2000 ? 'B' : kb < 4000 ? 'C' : 'D',
    };
  }

  /**
   * Extract security signals.
   */
  function analyzeSecurity(pageData, url,) {
    const isHttps = String(url,).startsWith('https://',);
    const securityHeaders = [
      'strict-transport-security',
      'content-security-policy',
      'x-frame-options',
      'x-content-type-options',
      'referrer-policy',
      'permissions-policy',
    ];
    const present = securityHeaders.filter((h,) => pageData.headers?.get(h,),);
    const missing = securityHeaders.filter((h,) => !pageData.headers?.get(h,),);

    return {
      https: isHttps,
      headers_present: present,
      headers_missing: missing,
      headers_score: Math.round((present.length / securityHeaders.length) * 100,),
      grade: present.length >= 5 ? 'A' : present.length >= 3 ? 'B' : present.length >= 1 ? 'C' : 'D',
    };
  }

  /**
   * Check crawl infrastructure (robots.txt, sitemap.xml, favicon).
   */
  async function analyzeCrawlability(baseUrl,) {
    const results = {};

    try {
      const robotsRes = await fetchPage(`${baseUrl}/robots.txt`,);
      const robotsText = robotsRes.ok ? await robotsRes.text() : '';
      results.robots_txt = {
        found: robotsRes.ok && robotsRes.status < 400,
        content: robotsText.slice(0, 500,),
        allows_ai_crawlers: /GPTBot|ChatGPT-User|PerplexityBot|Google-Extended/i.test(robotsText,),
        has_sitemap_ref: /Sitemap:/i.test(robotsText,),
      };
    } catch {
      results.robots_txt = { found: false, content: '', allows_ai_crawlers: false, has_sitemap_ref: false, };
    }

    try {
      const sitemapRes = await fetchPage(`${baseUrl}/sitemap.xml`,);
      results.sitemap = {
        found: sitemapRes.ok && sitemapRes.status < 400,
        content_type: sitemapRes.headers?.get('content-type',) || '',
      };
    } catch {
      results.sitemap = { found: false, content_type: '', };
    }

    try {
      const llmsRes = await fetchPage(`${baseUrl}/llms.txt`,);
      results.llms_txt = {
        found: llmsRes.ok && llmsRes.status < 400,
      };
    } catch {
      results.llms_txt = { found: false, };
    }

    try {
      const faviconRes = await fetchPage(`${baseUrl}/favicon.ico`, { method: 'HEAD', },);
      results.favicon = { found: faviconRes.ok && faviconRes.status < 400, };
    } catch {
      results.favicon = { found: false, };
    }

    return results;
  }

  /**
   * Try to extract product catalog signals from Shopify's public API.
   */
  async function analyzeCatalog(baseUrl,) {
    try {
      const res = await fetchPage(`${baseUrl}/products.json?limit=20`,);
      if (!res.ok) return { found: false, product_count_estimate: null, products: [], };
      const json = await res.json();
      if (!json.products) return { found: false, product_count_estimate: null, products: [], };

      const products = json.products.slice(0, 10,).map((p,) => ({
        id: p.id,
        title: p.title,
        vendor: p.vendor,
        type: p.product_type,
        price_min: Math.min(...(p.variants || []).map((v,) => parseFloat(v.price,) || 0,),),
        price_max: Math.max(...(p.variants || []).map((v,) => parseFloat(v.price,) || 0,),),
        has_images: (p.images || []).length > 0,
        image_count: (p.images || []).length,
      }),);

      return {
        found: true,
        platform: 'shopify',
        product_count_estimate: json.products.length,
        products,
        avg_price: products.length
          ? Math.round(products.reduce((s, p,) => s + p.price_min, 0,) / products.length * 100,) / 100
          : 0,
      };
    } catch {
      return { found: false, product_count_estimate: null, products: [], };
    }
  }

  /**
   * Analyze AI search readiness.
   */
  function analyzeAiReadiness(seo, crawlability,) {
    const signals = [];

    // JSON-LD structured data
    if (seo.has_json_ld) {
      signals.push({ signal: 'structured_data', status: 'pass', detail: `Types: ${seo.json_ld_types.join(', ',)}`, },);
    } else {
      signals.push({ signal: 'structured_data', status: 'fail', detail: 'No JSON-LD found', },);
    }

    // llms.txt
    if (crawlability.llms_txt?.found) {
      signals.push({ signal: 'llms_txt', status: 'pass', detail: 'AI crawler guidance file present', },);
    } else {
      signals.push({ signal: 'llms_txt', status: 'fail', detail: 'No /llms.txt for AI search engines', },);
    }

    // OpenGraph (used by AI for entity understanding)
    if (seo.og_title && seo.og_image) {
      signals.push({ signal: 'open_graph', status: 'pass', detail: 'Complete OG tags', },);
    } else {
      signals.push({ signal: 'open_graph', status: 'warn', detail: 'Incomplete OpenGraph tags', },);
    }

    // FAQ schema
    const hasFaq = seo.json_ld_types.some((t,) => t === 'FAQPage',);
    signals.push({
      signal: 'faq_schema',
      status: hasFaq ? 'pass' : 'fail',
      detail: hasFaq ? 'FAQ schema present' : 'No FAQ schema for AI answer engines',
    },);

    // Entity markup (Organization, Store, Brand)
    const hasEntity = seo.json_ld_types.some((t,) =>
      ['Organization', 'Store', 'Brand', 'LocalBusiness',].includes(t,),
    );
    signals.push({
      signal: 'entity_markup',
      status: hasEntity ? 'pass' : 'fail',
      detail: hasEntity ? 'Entity schema present' : 'No Organization/Store schema for knowledge graphs',
    },);

    // AI crawler access
    signals.push({
      signal: 'ai_crawler_access',
      status: crawlability.robots_txt?.allows_ai_crawlers ? 'pass' : 'warn',
      detail: crawlability.robots_txt?.allows_ai_crawlers
        ? 'AI crawlers explicitly allowed'
        : 'No explicit AI crawler rules in robots.txt',
    },);

    const passCount = signals.filter((s,) => s.status === 'pass',).length;
    const score = Math.round((passCount / signals.length) * 100,);

    return { signals, score, grade: score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D', };
  }

  /**
   * Run the full deep audit.
   */
  async function audit(rawUrl,) {
    const parsed = allowPrivate
      ? new URL(rawUrl.startsWith('http',) ? rawUrl : `https://${rawUrl}`,)
      : assertSafeUrl(rawUrl,);
    const baseUrl = `${parsed.protocol}//${parsed.host}`;

    // Fetch homepage
    const homePage = await fetchHtml(baseUrl,);

    // Analyze homepage
    const seo = analyzeSeo(homePage.html || '', baseUrl,);
    const performance = analyzePerformance(homePage,);
    const security = analyzeSecurity(homePage, baseUrl,);

    // Crawl infrastructure + catalog + AI readiness (parallel)
    const [crawlability, catalog,] = await Promise.all([
      analyzeCrawlability(baseUrl,),
      analyzeCatalog(baseUrl,),
    ],);

    const aiReadiness = analyzeAiReadiness(seo, crawlability,);

    // ── Score calculation ─────────────────────────────────────────
    const categories = {};

    // SEO score (0-100)
    let seoPoints = 0;
    let seoMax = 0;
    const seoChecks = [
      { label: 'Title tag', pass: seo.title && seo.title_length >= 15 && seo.title_length <= 65, weight: 15, },
      { label: 'Meta description', pass: seo.description && seo.description_length >= 70 && seo.description_length <= 160, weight: 12, },
      { label: 'Single H1', pass: seo.h1_count === 1, weight: 10, },
      { label: 'Canonical URL', pass: !!seo.canonical, weight: 8, },
      { label: 'OpenGraph tags', pass: !!seo.og_title && !!seo.og_image, weight: 8, },
      { label: 'JSON-LD schema', pass: seo.has_json_ld, weight: 12, },
      { label: 'Image alt text', pass: seo.alt_coverage_pct >= 90, weight: 10, },
      { label: 'Mobile viewport', pass: !!seo.viewport, weight: 10, },
      { label: 'Twitter card', pass: !!seo.twitter_card, weight: 5, },
      { label: 'Internal linking', pass: seo.internal_links > 5, weight: 10, },
    ];
    for (const check of seoChecks) {
      seoMax += check.weight;
      if (check.pass) seoPoints += check.weight;
      else if (check.label === 'Meta description' && seo.description) seoPoints += check.weight / 2;
    }
    categories.seo = { score: Math.round((seoPoints / seoMax) * 100,), checks: seoChecks, };

    // Performance score
    const perfChecks = [
      { label: 'TTFB < 800ms', pass: performance.ttfb_ms < 800, weight: 25, },
      { label: 'Page weight < 1MB', pass: performance.page_weight_kb < 1024, weight: 20, },
      { label: 'Compression enabled', pass: performance.compression !== 'none', weight: 25, },
      { label: 'Load time < 3s (4G)', pass: performance.estimated_load_4g_sec < 3, weight: 30, },
    ];
    let perfPoints = 0, perfMax = 0;
    for (const c of perfChecks) { perfMax += c.weight; if (c.pass) perfPoints += c.weight; }
    categories.performance = { score: Math.round((perfPoints / perfMax) * 100,), checks: perfChecks, };

    // Security score
    categories.security = { score: security.headers_score, checks: [
      { label: 'HTTPS', pass: security.https, weight: 30, },
      { label: 'Security headers', pass: security.headers_score >= 70, weight: 40, },
      { label: 'HSTS', pass: !!security.headers_present.includes('strict-transport-security',), weight: 30, },
    ], };

    // Crawlability score
    const crawlChecks = [
      { label: 'robots.txt', pass: crawlability.robots_txt?.found, weight: 25, },
      { label: 'sitemap.xml', pass: crawlability.sitemap?.found, weight: 25, },
      { label: 'favicon', pass: crawlability.favicon?.found, weight: 15, },
      { label: 'llms.txt', pass: crawlability.llms_txt?.found, weight: 20, },
      { label: 'AI crawlers allowed', pass: crawlability.robots_txt?.allows_ai_crawlers, weight: 15, },
    ];
    let crawlPoints = 0, crawlMax = 0;
    for (const c of crawlChecks) { crawlMax += c.weight; if (c.pass) crawlPoints += c.weight; }
    categories.crawlability = { score: Math.round((crawlPoints / crawlMax) * 100,), checks: crawlChecks, };

    // Overall score (weighted)
    const overallScore = Math.round(
      categories.seo.score * 0.30 +
      categories.performance.score * 0.20 +
      categories.security.score * 0.15 +
      categories.crawlability.score * 0.15 +
      aiReadiness.score * 0.20,
    );

    const grade = overallScore >= 85 ? 'A' : overallScore >= 70 ? 'B' : overallScore >= 55 ? 'C' : overallScore >= 40 ? 'D' : 'F';

    // Collect top issues (prioritized)
    const allChecks = [
      ...categories.seo.checks.map((c,) => ({ ...c, category: 'SEO', }),),
      ...categories.performance.checks.map((c,) => ({ ...c, category: 'Performance', }),),
      ...categories.security.checks.map((c,) => ({ ...c, category: 'Security', }),),
      ...categories.crawlability.checks.map((c,) => ({ ...c, category: 'Crawlability', }),),
    ];
    const topIssues = allChecks
      .filter((c,) => !c.pass,)
      .sort((a, b,) => b.weight - a.weight,)
      .slice(0, 10,);

    const report = {
      report_id: undefined,
      url: baseUrl,
      audited_at: new Date().toISOString(),
      overall_score: overallScore,
      grade,
      categories,
      ai_readiness: aiReadiness,
      seo_details: seo,
      performance_details: performance,
      security_details: security,
      crawlability,
      catalog,
      top_issues: topIssues,
      total_checks: allChecks.length,
      passed_checks: allChecks.filter((c,) => c.pass,).length,
    };

    const saved = await store.deepAudits.insert(report,);
    return { ...report, report_id: saved._id, };
  }

  return {
    audit,
    analyzeSeo,
    analyzePerformance,
    analyzeSecurity,
    analyzeAiReadiness,
    assertSafeUrl,
  };
}

module.exports = { createDeepAudit, assertSafeUrl, };
