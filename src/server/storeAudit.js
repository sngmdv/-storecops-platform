'use strict';

/**
 * Free public store audit — no signup, no connection required.
 *
 * Anyone pastes their store URL and gets a REAL audit built from
 * live measurements of their site: timing, TLS, headers, SEO tags,
 * structure, performance signals — each with a concrete suggestion.
 *
 * Everything is measured server-side with zero external deps:
 *   1.  HTTPS / TLS certificate validity
 *   2.  Response time (TTFB)
 *   3.  Page weight + estimated load time
 *   4.  Redirect chain (HTTP→HTTPS, hop count)
 *   5.  Title tag quality
 *   6.  Meta description quality
 *   7.  Heading structure (H1)
 *   8.  Image alt-text coverage
 *   9.  Mobile viewport
 *  10.  Security headers
 *  11.  Compression (gzip/brotli)
 *  12.  Social cards + structured data
 *  13.  robots.txt / sitemap.xml / favicon (bonus)
 */

const { URL, } = require('url',);

const TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3 MB is plenty for an audit
const MAX_REDIRECTS = 7;

// ── SSRF guard ─────────────────────────────────────────────────────
// The audit endpoint is public, so never let it hit internal hosts.
const PRIVATE_HOST_RE =
  /^(localhost|0\.0\.0\.0|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|169\.254\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+|.*\.local|\[?::1\]?)$/i;

function assertSafeUrl(rawUrl, { allowPrivateHosts = false, } = {},) {
  let parsed;
  try {
    parsed = new URL(rawUrl.startsWith('http',) ? rawUrl : `https://${rawUrl}`,);
  } catch {
    throw new Error('That doesn\'t look like a valid URL.',);
  }
  if (!['http:', 'https:',].includes(parsed.protocol,)) {
    throw new Error('Only http/https URLs can be audited.',);
  }
  if (!allowPrivateHosts && PRIVATE_HOST_RE.test(parsed.hostname,)) {
    throw new Error('Private/local addresses cannot be audited.',);
  }
  return parsed;
}

// ── helpers ────────────────────────────────────────────────────────
function tag(html, name,) {
  const m = html.match(new RegExp(`<${name}\\b[^>]*>`, 'i',),);
  return m ? m[0] : null;
}

function attr(openTag, name,) {
  const m = openTag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i',),);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function metaContent(html, name,) {
  const m = html.match(
    new RegExp(`<meta\\b[^>]*(?:name|property)\\s*=\\s*["']?${name}["']?[^>]*>`, 'i',),
  );
  return m ? attr(m[0], 'content',) : null;
}

function checkCertificate(url,) {
  return new Promise((resolve,) => {
    if (url.protocol !== 'https:') return resolve(null,);
    try {
      const https = require('https',);
      const req = https.request(
        { hostname: url.hostname, port: url.port || 443, path: '/', method: 'HEAD', timeout: TIMEOUT_MS, },
        (res,) => {
          const cert = res.socket.getPeerCertificate();
          res.resume();
          return resolve(cert && cert.valid_to ? { valid_to: cert.valid_to, issuer: cert.issuer?.O || '', } : null,);
        },
      );
      req.on('error', () => resolve(null,),);
      req.on('timeout', () => req.destroy(),);
      req.end();
    } catch {
      return resolve(null,);
    }
    return undefined;
  },);
}

/** Fetch following redirects manually so we can report the chain. */
async function fetchChain(href,) {
  const chain = [];
  let current = href;
  let response = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS,),
      headers: { 'User-Agent': 'Storecops-Audit/1.0', Accept: 'text/html', },
    },);
    const location = res.headers.get('location',);
    if ([301, 302, 303, 307, 308,].includes(res.status,) && location) {
      chain.push({ url: current, status: res.status, },);
      current = new URL(location, current,).toString();
      res.body?.cancel?.();
      continue;
    }
    response = res;
    break;
  }
  return { response, chain, finalUrl: current, };
}

// ── the audit ──────────────────────────────────────────────────────
function createStoreAudit({ store, config, },) {
  const allowPrivateHosts = config?.env === 'test' || config?.allowPrivateHosts === true;

  async function probe(url, path,) {
    try {
      const res = await fetch(new URL(path, url,).toString(), {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS,),
        headers: { 'User-Agent': 'Storecops-Audit/1.0', },
        redirect: 'follow',
      },);
      return res.status;
    } catch {
      return 0;
    }
  }

  async function audit(rawUrl,) {
    const url = assertSafeUrl(rawUrl, { allowPrivateHosts, },);
    const checks = [];
    const add = (key, label, status, value, detail, suggestion, weight = 1,) =>
      checks.push({ key, label, status, value, detail, suggestion, weight, },);

    // 1–4: network-level measurements.
    const started = Date.now();
    const { response, chain, finalUrl, } = await fetchChain(url.toString(),).catch((e,) => {
      throw new Error(`Could not reach the site: ${e.message}`,);
    },);
    const ttfb = Date.now() - started;
    const status = response.status;
    if (status >= 400) {
      throw new Error(`The site answered with HTTP ${status} — is the URL correct and the store online?`,);
    }

    const buf = Buffer.from(await response.arrayBuffer(),);
    const bytes = buf.length;
    const html = buf.toString('utf8',).slice(0, MAX_BODY_BYTES,);
    const headers = response.headers;
    const finalParsed = new URL(finalUrl,);

    // 1. HTTPS + certificate
    const cert = await checkCertificate(finalParsed,);
    const httpsOk = finalParsed.protocol === 'https:';
    let certExpired = false;
    if (httpsOk && cert?.valid_to) certExpired = new Date(cert.valid_to,) < new Date();
    add(
      'https',
      'HTTPS & TLS certificate',
      !httpsOk ? 'FAIL' : certExpired ? 'WARN' : 'PASS',
      httpsOk ? (cert ? `cert valid until ${cert.valid_to.slice(0, 16,)}` : 'HTTPS on') : 'plain HTTP',
      !httpsOk
        ? 'The store is served over insecure HTTP.'
        : certExpired
          ? 'The TLS certificate has expired.'
          : 'Encrypted connection with a valid certificate.',
      !httpsOk
        ? 'Install a TLS certificate (Let\'s Encrypt is free) and force HTTPS — browsers mark HTTP shops as \'Not secure\' and buyers abandon checkout.'
        : certExpired
          ? 'Renew the TLS certificate immediately; expired certs trigger hard browser warnings.'
          : 'Nothing to do — keep auto-renewal enabled.',
      2,
    );

    // 2. Response time (TTFB incl. redirects)
    add(
      'ttfb',
      'Server response time (TTFB)',
      ttfb < 800 ? 'PASS' : ttfb < 2000 ? 'WARN' : 'FAIL',
      `${ttfb} ms`,
      'Time from request to first byte, redirects included.',
      ttfb < 800
        ? 'Fast server response.'
        : 'Enable page caching / a CDN (Cloudflare is free), review slow server-side rendering, and upgrade hosting if the backend is the bottleneck. Every +500 ms costs conversions.',
      2,
    );

    // 3. Page weight + estimated load
    const kb = Math.round(bytes / 1024,);
    const est4gSec = (bytes / (4 * 1024 * 1024)) * 8; // ~4 Mbps effective
    add(
      'weight',
      'Page weight',
      kb < 1024 ? 'PASS' : kb < 3072 ? 'WARN' : 'FAIL',
      `${kb} KB (~${est4gSec.toFixed(1,)}s on 4 Mbps)`,
      'Full HTML document size as delivered.',
      kb < 1024
        ? 'Lightweight page.'
        : 'Compress and lazy-load images (WebP/AVIF), remove unused scripts and fonts, and enable minification. Heavy pages destroy mobile conversion.',
      1.5,
    );

    // 4. Redirect chain
    const httpToHttps = chain.some((c,) => c.url.startsWith('http://',),) && httpsOk;
    add(
      'redirects',
      'Redirect chain',
      chain.length === 0 ? 'PASS' : chain.length <= 2 && (httpToHttps || httpsOk) ? 'WARN' : 'FAIL',
      chain.length === 0 ? 'no redirects' : `${chain.length} hop(s) → ${finalParsed.hostname}`,
      chain.length ? chain.map((c,) => `${c.status} ${new URL(c.url,).hostname}`,).join(' → ',) : 'Direct response.',
      chain.length === 0
        ? 'No redirect hops.'
        : 'Collapse redirect chains to a single 301 to the final https:// URL — each hop adds latency and leaks PageRank.',
      1,
    );

    // 5. Title tag
    const titleTag = tag(html, 'title',);
    const titleClean = titleTag ? html.slice(titleTag.indexOf('>',) + 1,).split('<',)[0].trim() : null;
    add(
      'title',
      'Title tag',
      titleClean && titleClean.length >= 15 && titleClean.length <= 65 ? 'PASS' : titleClean ? 'WARN' : 'FAIL',
      titleClean ? `"${titleClean.slice(0, 70,)}" (${titleClean.length} chars)` : 'missing',
      'The <title> is the #1 on-page SEO signal and your search-result headline.',
      !titleClean
        ? 'Add a unique <title> of 30–60 characters containing your brand + top keyword.'
        : titleClean.length < 15 || titleClean.length > 65
          ? 'Rewrite the title to 30–60 characters: brand + product category + differentiator.'
          : 'Good title length.',
      1.5,
    );

    // 6. Meta description
    const desc = metaContent(html, 'description',);
    add(
      'meta_description',
      'Meta description',
      desc && desc.length >= 70 && desc.length <= 170 ? 'PASS' : desc ? 'WARN' : 'FAIL',
      desc ? `${desc.length} chars` : 'missing',
      'Shown under your link in Google — it drives click-through rate.',
      !desc
        ? 'Add a 70–160 character meta description with a benefit + call to action.'
        : desc.length < 70 || desc.length > 170
          ? 'Adjust the meta description to 70–160 characters so Google doesn\'t truncate it.'
          : 'Solid description.',
      1,
    );

    // 7. Heading structure
    const h1s = html.match(/<h1\b[^>]*>/gi,) || [];
    add(
      'h1',
      'Heading structure (H1)',
      h1s.length === 1 ? 'PASS' : h1s.length > 1 ? 'WARN' : 'FAIL',
      `${h1s.length} H1 tag(s)`,
      'Exactly one H1 tells search engines what the page is about.',
      h1s.length === 1
        ? 'Clean heading structure.'
        : h1s.length === 0
          ? 'Add exactly one <h1> with the page\'s main keyword.'
          : `Consolidate ${h1s.length} H1s into one; demote the rest to H2/H3.`,
      1,
    );

    // 8. Image alt coverage
    const imgs = html.match(/<img\b[^>]*>/gi,) || [];
    const missingAlt = imgs.filter((i,) => !/\balt\s*=/.test(i,),).length;
    const coverage = imgs.length ? Math.round(((imgs.length - missingAlt) / imgs.length) * 100,) : 100;
    add(
      'alt',
      'Image alt-text coverage',
      imgs.length === 0 || coverage >= 90 ? 'PASS' : coverage >= 60 ? 'WARN' : 'FAIL',
      imgs.length ? `${coverage}% of ${imgs.length} image(s)` : 'no images found',
      'Alt text powers image search + accessibility.',
      missingAlt === 0
        ? 'All images carry alt attributes.'
        : `Add descriptive alt text to ${missingAlt} image(s) — product name + key attribute ("blue leather wallet").`,
      1,
    );

    // 9. Mobile viewport
    const viewport = metaContent(html, 'viewport',);
    add(
      'viewport',
      'Mobile viewport',
      viewport ? 'PASS' : 'FAIL',
      viewport || 'missing',
      'Without a viewport, phones render the desktop layout zoomed out.',
      viewport ? 'Mobile-friendly meta found.' : 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> and test on a phone.',
      1.5,
    );

    // 10. Security headers
    const wanted = [
      ['strict-transport-security', 'HSTS',],
      ['content-security-policy', 'CSP',],
      ['x-frame-options', 'X-Frame-Options',],
      ['x-content-type-options', 'X-Content-Type-Options',],
      ['referrer-policy', 'Referrer-Policy',],
    ];
    const missing = wanted.filter(([h,],) => !headers.get(h,),);
    add(
      'security_headers',
      'Security headers',
      missing.length <= 1 ? 'PASS' : missing.length <= 3 ? 'WARN' : 'FAIL',
      missing.length ? `${missing.length} missing: ${missing.map(([, n,],) => n,).join(', ',)}` : 'all present',
      'These headers protect customers from clickjacking, MIME sniffing and downgrade attacks.',
      missing.length
        ? `Add the missing headers in your server/CDN config: ${missing.map(([, n,],) => n,).join(', ',)}.`
        : 'Header hygiene looks great.',
      1.5,
    );

    // 11. Compression
    let compressed = null;
    try {
      const cres = await fetch(finalUrl, {
        headers: { 'Accept-Encoding': 'gzip, br', 'User-Agent': 'Storecops-Audit/1.0', },
        signal: AbortSignal.timeout(TIMEOUT_MS,),
      },);
      compressed = cres.headers.get('content-encoding',);
      cres.body?.cancel?.();
    } catch {
      compressed = null;
    }
    add(
      'compression',
      'Response compression',
      compressed ? 'PASS' : 'WARN',
      compressed || 'none detected',
      'gzip/brotli typically cuts page weight 60–80%.',
      compressed ? 'Compression enabled.' : 'Enable gzip or brotli on your server/CDN — free speed.',
      1,
    );

    // 12. Social cards + structured data
    const og = metaContent(html, 'og:title',) || metaContent(html, 'og:image',);
    const jsonLd = /<script[^>]+application\/ld\+json/i.test(html,);
    add(
      'structured',
      'Social cards & structured data',
      og && jsonLd ? 'PASS' : og || jsonLd ? 'WARN' : 'FAIL',
      `${og ? 'OpenGraph ✓' : 'OpenGraph ✗'} · ${jsonLd ? 'JSON-LD ✓' : 'JSON-LD ✗'}`,
      'OG tags control how links preview on social; JSON-LD (Product schema) powers rich results.',
      'Add OpenGraph tags (og:title, og:image) and Product JSON-LD schema with price + availability for rich snippets.',
      1,
    );

    // 13. Bonus: robots / sitemap / favicon
    const [robots, sitemap, favicon,] = await Promise.all([
      probe(finalParsed, '/robots.txt',),
      probe(finalParsed, '/sitemap.xml',),
      probe(finalParsed, '/favicon.ico',),
    ],);
    const found = [robots < 400 && robots > 0, sitemap < 400 && sitemap > 0, favicon < 400 && favicon > 0,];
    add(
      'crawlables',
      'robots.txt, sitemap.xml, favicon',
      found.filter(Boolean,).length === 3 ? 'PASS' : found.filter(Boolean,).length >= 1 ? 'WARN' : 'FAIL',
      `robots ${robots || '—'} · sitemap ${sitemap || '—'} · favicon ${favicon || '—'}`,
      'Crawl infrastructure for search engines + browser branding.',
      'Publish /robots.txt and /sitemap.xml (submit the sitemap in Google Search Console) and add a favicon.',
      1,
    );

    // Score.
    const maxScore = checks.reduce((sum, c,) => sum + c.weight, 0,);
    const gotScore = checks.reduce(
      (sum, c,) => sum + (c.status === 'PASS' ? c.weight : c.status === 'WARN' ? c.weight / 2 : 0),
      0,
    );
    const score = Math.round((gotScore / maxScore) * 100,);

    const report = {
      report_id: undefined,
      url: url.toString(),
      final_url: finalUrl,
      audited_at: new Date().toISOString(),
      score,
      grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F',
      timings: { ttfb_ms: ttfb, page_kb: kb, },
      checks,
      top_actions: checks
        .filter((c,) => c.status !== 'PASS',)
        .sort((a, b,) => b.weight - a.weight,)
        .slice(0, 5,)
        .map((c,) => c.suggestion,),
    };

    const saved = await store.siteAudits.insert(report,);
    return { ...report, report_id: saved._id, };
  }

  return {
    audit,
    assertSafeUrl,
    async get(report_id,) {
      return store.siteAudits.findById(report_id,);
    },
    async recent(limit = 10,) {
      const all = await store.siteAudits.find({},);
      return all.sort((a, b,) => b.audited_at.localeCompare(a.audited_at,),).slice(0, limit,);
    },
  };
}

module.exports = { createStoreAudit, assertSafeUrl, };
