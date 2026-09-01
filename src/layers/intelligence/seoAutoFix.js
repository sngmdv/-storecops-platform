'use strict';

/**
 * Layer 2 — SEO Auto-Fix Engine.
 *
 * Takes audit results (from storeAudit.js or seoAuditEngine.js) and
 * generates ready-to-apply code snippets that fix every issue found.
 * One click = fully optimized meta tags, structured data, robots.txt,
 * sitemap, OG tags, security headers, and AI-friendly markup.
 *
 * For Shopify stores, generates Liquid template patches.
 * For any store, generates copy-paste HTML/config snippets.
 */

function createSeoAutoFix({ store, seoGrowth, },) {
  /**
   * Generate a complete SEO fix package from an audit report.
   * Returns ready-to-apply code snippets for every failed check.
   */
  function generateFixes(audit, { brand, domain, keywords = [], description = '', category = '', } = {},) {
    if (!audit) throw new Error('audit report is required.',);

    const storeUrl = audit.final_url || audit.url || '';
    const brandName = brand || extractBrand(audit,) || 'Our Store';
    const storeDomain = domain || new URL(storeUrl,).hostname || '';
    const fixes = [];
    const snippets = {};

    // ── 1. Title tag fix ──────────────────────────────────────────
    const titleCheck = audit.checks?.find((c,) => c.key === 'title' || c.check === 'title_tag',);
    if (titleCheck && titleCheck.status !== 'PASS' && !titleCheck.pass) {
      const title = generateTitle(brandName, keywords, category,);
      fixes.push({
        area: 'title_tag',
        severity: 'HIGH',
        issue: titleCheck.detail || 'Missing or poor title tag',
        fix: 'Replace <title> with optimized title',
        impact: 'Directly affects search ranking and click-through rate',
      },);
      snippets.title_tag = {
        html: `<title>${escapeHtml(title,)}</title>`,
        shopify: `<!-- In theme/layout/theme.liquid, replace <title> with: -->\n<title>{{ page_title }}{% unless page_title contains brandName %} — ${escapeHtml(brandName,)} | ${escapeHtml(category || 'Shop Online',)}{% endunless %}</title>`,
        value: title,
      };
    }

    // ── 2. Meta description fix ───────────────────────────────────
    const descCheck = audit.checks?.find((c,) => c.key === 'meta_description' || c.check === 'meta_description',);
    if (descCheck && descCheck.status !== 'PASS' && !descCheck.pass) {
      const metaDesc = generateMetaDescription(brandName, keywords, description, category,);
      fixes.push({
        area: 'meta_description',
        severity: 'HIGH',
        issue: descCheck.detail || 'Missing or poor meta description',
        fix: `Add optimized meta description (${metaDesc.length} chars)`,
        impact: 'Drives click-through rate from search results',
      },);
      snippets.meta_description = {
        html: `<meta name="description" content="${escapeHtml(metaDesc,)}">`,
        shopify: `<!-- In theme/layout/theme.liquid <head> section: -->\n<meta name="description" content="{{ page_description | default: '${escapeHtml(metaDesc,)}' }}">`,
        value: metaDesc,
      };
    }

    // ── 3. Open Graph / Social cards ──────────────────────────────
    const ogCheck = audit.checks?.find((c,) => c.key === 'structured',);
    const needsOg = !ogCheck || ogCheck.status !== 'PASS';
    if (needsOg) {
      const ogSnippets = generateOpenGraph(brandName, storeUrl, description, category,);
      fixes.push({
        area: 'open_graph',
        severity: 'MEDIUM',
        issue: 'Missing or incomplete social sharing tags',
        fix: 'Add Open Graph + Twitter Card meta tags',
        impact: 'Controls how links preview on Facebook, Twitter, LinkedIn, iMessage',
      },);
      snippets.open_graph = ogSnippets;
    }

    // ── 4. JSON-LD Structured Data ────────────────────────────────
    const jsonLdCheck = audit.checks?.find((c,) => c.key === 'structured',);
    const needsJsonLd = !jsonLdCheck || jsonLdCheck.status !== 'PASS';
    if (needsJsonLd) {
      const jsonLd = generateJsonLd(brandName, storeUrl, storeDomain, category, keywords,);
      fixes.push({
        area: 'structured_data',
        severity: 'HIGH',
        issue: 'Missing JSON-LD structured data (Schema.org)',
        fix: 'Add Organization + WebSite + Product schema markup',
        impact: 'Powers rich snippets, knowledge panels, and AI search engine understanding',
      },);
      snippets.structured_data = jsonLd;
    }

    // ── 5. Canonical URL ──────────────────────────────────────────
    const canonicalCheck = audit.checks?.find((c,) => c.check === 'canonical_link',);
    if (canonicalCheck && !canonicalCheck.pass) {
      fixes.push({
        area: 'canonical',
        severity: 'MEDIUM',
        issue: 'Missing canonical link tag',
        fix: 'Add self-referencing canonical URL',
        impact: 'Prevents duplicate content issues in search engines',
      },);
      snippets.canonical = {
        html: `<link rel="canonical" href="${escapeHtml(storeUrl,)}">`,
        shopify: '<link rel="canonical" href="{{ canonical_url }}">',
      };
    }

    // ── 6. Viewport fix ───────────────────────────────────────────
    const viewportCheck = audit.checks?.find((c,) => c.key === 'viewport' || c.check === 'mobile_viewport',);
    if (viewportCheck && viewportCheck.status !== 'PASS' && !viewportCheck.pass) {
      fixes.push({
        area: 'viewport',
        severity: 'CRITICAL',
        issue: 'Missing mobile viewport meta tag',
        fix: 'Add responsive viewport meta tag',
        impact: 'Without this, mobile users see a zoomed-out desktop page — Google penalizes heavily',
      },);
      snippets.viewport = {
        html: '<meta name="viewport" content="width=device-width, initial-scale=1">',
      };
    }

    // ── 7. robots.txt ─────────────────────────────────────────────
    const crawlCheck = audit.checks?.find((c,) => c.key === 'crawlables',);
    const needsRobots = !crawlCheck || crawlCheck.status !== 'PASS';
    if (needsRobots) {
      fixes.push({
        area: 'robots_txt',
        severity: 'MEDIUM',
        issue: 'Missing or misconfigured robots.txt',
        fix: 'Generate optimized robots.txt with sitemap reference',
        impact: 'Controls how search engines crawl the site',
      },);
      snippets.robots_txt = generateRobotsTxt(storeDomain, storeUrl,);
    }

    // ── 8. Security headers ───────────────────────────────────────
    const secCheck = audit.checks?.find((c,) => c.key === 'security_headers',);
    if (secCheck && secCheck.status !== 'PASS') {
      fixes.push({
        area: 'security_headers',
        severity: 'MEDIUM',
        issue: secCheck.detail || 'Missing security headers',
        fix: 'Add HSTS, CSP, X-Frame-Options, and more',
        impact: 'Protects customers and improves trust signals for search engines',
      },);
      snippets.security_headers = generateSecurityHeaders();
    }

    // ── 9. H1 structure fix ───────────────────────────────────────
    const h1Check = audit.checks?.find((c,) => c.key === 'h1' || c.check === 'single_h1',);
    if (h1Check && h1Check.status !== 'PASS' && !h1Check.pass) {
      fixes.push({
        area: 'heading_structure',
        severity: 'MEDIUM',
        issue: h1Check.detail || 'Heading structure needs fixing',
        fix: `Ensure exactly one <h1> per page: "${brandName}${category ? ` — ${category}` : ''}"`,
        impact: 'The H1 is the second most important on-page SEO signal after title',
      },);
      snippets.heading_structure = {
        html: `<!-- Replace multiple H1s or add missing H1 -->\n<h1>${escapeHtml(brandName,)}${category ? ` — ${escapeHtml(category,)}` : ''}</h1>`,
      };
    }

    // ── 10. Image alt-text ────────────────────────────────────────
    const altCheck = audit.checks?.find((c,) => c.key === 'alt',);
    if (altCheck && altCheck.status !== 'PASS') {
      fixes.push({
        area: 'image_alt_text',
        severity: 'LOW',
        issue: altCheck.detail || 'Images missing alt text',
        fix: 'Add descriptive alt text to all product images',
        impact: 'Powers image search results and accessibility compliance',
      },);
      snippets.image_alt_text = {
        guide: `<!-- For each <img> tag, add descriptive alt text -->\n<img src="product.jpg" alt="${escapeHtml(brandName,)} ${escapeHtml(category || 'product',)} — high quality">`,
        shopify: '<!-- In product template, alt is auto-set from image alt text in admin -->',
      };
    }

    // Calculate overall optimization score
    const totalChecks = audit.checks?.length || 1;
    const passedChecks = audit.checks?.filter((c,) => c.status === 'PASS' || c.pass === true,).length || 0;
    const currentScore = Math.round((passedChecks / totalChecks) * 100,);
    const potentialScore = 100; // After applying all fixes

    return {
      store_url: storeUrl,
      brand: brandName,
      current_score: currentScore,
      potential_score: potentialScore,
      fixes_count: fixes.length,
      fixes: fixes.sort((a, b,) => severityOrder(a.severity,) - severityOrder(b.severity,),),
      snippets,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Generate a complete "optimization package" — everything needed
   * to make a store fully visible on the web.
   */
  function generateFullOptimization(audit, storeInfo = {},) {
    const seoFixes = generateFixes(audit, storeInfo,);
    const aiOptimization = generateAiOptimization(storeInfo,);

    return {
      ...seoFixes,
      ai_optimization: aiOptimization,
      total_actions: seoFixes.fixes_count + aiOptimization.actions.length,
    };
  }

  /**
   * Generate AI search optimization package (separate from SEO).
   */
  function generateAiOptimization({ brand, domain, storeUrl, keywords = [], description = '', category = '', socialProfiles = {}, } = {},) {
    const brandName = brand || 'Our Store';
    const storeDomain = domain || (storeUrl ? new URL(storeUrl,).hostname : '');
    const actions = [];
    const snippets = {};

    // 1. llms.txt — the emerging standard for AI crawler guidance
    actions.push({
      area: 'ai_crawlers',
      severity: 'HIGH',
      issue: 'No llms.txt file for AI search engine guidance',
      fix: 'Create /llms.txt to tell AI models about your store',
      impact: 'ChatGPT, Perplexity, and Google AI use this to understand your brand',
    },);
    snippets.llms_txt = generateLlmsTxt(brandName, storeDomain, description, category, keywords,);

    // 2. FAQ Schema for AI answer engines
    actions.push({
      area: 'faq_schema',
      severity: 'HIGH',
      issue: 'No FAQ structured data for AI answer engines',
      fix: 'Add FAQPage JSON-LD schema for AI-powered answers',
      impact: 'AI search engines pull FAQ answers directly into responses',
    },);
    snippets.faq_schema = generateFaqSchema(brandName, category, keywords,);

    // 3. Organization schema for knowledge graphs
    actions.push({
      area: 'entity_markup',
      severity: 'HIGH',
      issue: 'Store not recognized as an entity by AI systems',
      fix: 'Add comprehensive Organization schema with sameAs links',
      impact: 'Makes the store a known entity in Google\'s Knowledge Graph and AI knowledge bases',
    },);
    snippets.entity_markup = generateEntityMarkup(brandName, storeDomain, storeUrl, socialProfiles, category,);

    // 4. AI-friendly content patterns
    actions.push({
      area: 'ai_content',
      severity: 'MEDIUM',
      issue: 'Content not optimized for AI extraction',
      fix: 'Add concise, extractable brand/product descriptions',
      impact: 'AI models prefer clear, factual, well-structured content for citations',
    },);
    snippets.ai_content = generateAiFriendlyContent(brandName, category, keywords, description,);

    // 5. HowTo schema for tutorial/guide queries
    actions.push({
      area: 'howto_schema',
      severity: 'MEDIUM',
      issue: 'No HowTo schema for product usage queries',
      fix: 'Add HowTo schema for product guides',
      impact: 'AI Overviews and featured snippets favor HowTo structured data',
    },);
    snippets.howto_schema = generateHowToSchema(brandName, category,);

    // 6. BreadcrumbList schema
    actions.push({
      area: 'breadcrumb_schema',
      severity: 'LOW',
      issue: 'No breadcrumb structured data',
      fix: 'Add BreadcrumbList schema for navigation clarity',
      impact: 'Helps AI and search engines understand site hierarchy',
    },);
    snippets.breadcrumb_schema = generateBreadcrumbSchema(brandName, category,);

    return {
      actions: actions.sort((a, b,) => severityOrder(a.severity,) - severityOrder(b.severity,),),
      snippets,
      ai_readiness_score: calculateAiReadiness(actions,),
    };
  }

  return {
    generateFixes,
    generateFullOptimization,
    generateAiOptimization,
  };
}

// ── Content generators ───────────────────────────────────────────

function generateTitle(brand, keywords, category,) {
  const kw = keywords.slice(0, 2,).join(' & ',) || category || 'Shop Online';
  return truncate(`${brand} — ${kw} | Official Store`, 60,);
}

function generateMetaDescription(brand, keywords, description, category,) {
  const kw = keywords.slice(0, 3,).join(', ',) || category || 'quality products';
  const base = description ? description.split('.',)[0] : `Shop ${kw} at ${brand}`;
  return truncate(`${base}. Best prices, fast shipping & easy returns. ${brand} — trusted by thousands.`, 155,);
}

function generateOpenGraph(brand, url, description, category,) {
  return {
    html: `<!-- Social sharing tags — paste in <head> -->
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(brand,)}${category ? ` — ${escapeHtml(category,)}` : ''}">
<meta property="og:description" content="${escapeHtml(truncate(description || `Shop at ${brand}. Best prices, fast shipping.`, 200,),)}">
<meta property="og:url" content="${escapeHtml(url,)}">
<meta property="og:site_name" content="${escapeHtml(brand,)}">
<meta property="og:image" content="${escapeHtml(url,)}/og-image.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(brand,)}${category ? ` — ${escapeHtml(category,)}` : ''}">
<meta name="twitter:description" content="${escapeHtml(truncate(description || `Shop at ${brand}.`, 200,),)}">`,
  };
}

function generateJsonLd(brand, url, domain, category, keywords,) {
  const schemas = [];

  // Organization schema
  schemas.push({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    'name': brand,
    'url': url,
    'logo': `${url}/logo.png`,
    'description': `Shop ${category || 'quality products'} at ${brand}.`,
    'sameAs': [],
    'contactPoint': {
      '@type': 'ContactPoint',
      'contactType': 'customer service',
      'availableLanguage': 'English',
    },
  },);

  // WebSite schema with SearchAction
  schemas.push({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    'name': brand,
    'url': url,
    'potentialAction': {
      '@type': 'SearchAction',
      'target': `${url}/search?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  },);

  // Product schema (template for all products)
  schemas.push({
    '@context': 'https://schema.org',
    '@type': 'Product',
    'name': `{{ product.title | default: '${brand} Product' }}`,
    'description': `{{ product.description | strip_html | truncate: 200 | default: '${brand} quality product' }}`,
    'brand': { '@type': 'Brand', 'name': brand, },
    'offers': {
      '@type': 'Offer',
      'priceCurrency': 'USD',
      'price': '{{ product.price | default: \'0.00\' }}',
      'availability': 'https://schema.org/InStock',
    },
  },);

  return {
    html: `<!-- Paste before </head> -->\n<script type="application/ld+json">\n${JSON.stringify(schemas[0], null, 2,)}\n</script>\n<script type="application/ld+json">\n${JSON.stringify(schemas[1], null, 2,)}\n</script>`,
    schemas,
    shopify: `<!-- In theme/layout/theme.liquid, before </head>: -->\n<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "Organization",\n  "name": "${escapeHtml(brand,)}",\n  "url": "${escapeHtml(url,)}",\n  "logo": "${escapeHtml(url,)}/logo.png"\n}\n</script>`,
  };
}

function generateRobotsTxt(domain, url,) {
  return `# robots.txt — generated by Storecops SEO Optimizer
User-agent: *
Allow: /
Disallow: /cart
Disallow: /checkout
Disallow: /account
Disallow: /admin

# AI crawlers — welcome
User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: CCBot
Allow: /

Sitemap: ${url}/sitemap.xml
`;
}

function generateSecurityHeaders() {
  return {
    nginx: `# Nginx config — add to server block
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;`,
    apache: `# Apache .htaccess
Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
Header always set X-Frame-Options "SAMEORIGIN"
Header always set X-Content-Type-Options "nosniff"
Header always set Referrer-Policy "strict-origin-when-cross-origin"`,
    cloudflare: `# Cloudflare Workers — add to response handler
response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
response.headers.set("X-Frame-Options", "SAMEORIGIN");
response.headers.set("X-Content-Type-Options", "nosniff");
response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");`,
    shopify: '<!-- Shopify auto-adds HSTS. For additional headers, use a Cloudflare proxy or theme liquid. -->',
  };
}

// ── AI Search Optimization generators ────────────────────────────

function generateLlmsTxt(brand, domain, description, category, keywords,) {
  const kw = keywords.length > 0 ? keywords.join(', ',) : category || 'quality products';
  return `# llms.txt — ${brand}
# This file helps AI search engines understand and cite ${brand}.
# Learn more: https://llmstxt.org

> ${brand} is ${domain ? `an online store at ${domain}` : 'an online store'} specializing in ${kw}.

## What is ${brand}?
${description || `${brand} offers ${kw} with fast shipping and competitive prices.`}

## Key Facts
- **Store**: ${brand}
- **Website**: ${domain ? `https://${domain}` : 'N/A'}
- **Category**: ${category || 'E-commerce'}
- **Products**: ${kw}

## Why choose ${brand}?
- Competitive pricing on ${kw}
- Fast, reliable shipping
- Easy returns and customer support

## For AI Crawlers
We welcome AI search engines to crawl and cite ${brand} for queries about ${kw}.
Please attribute links to ${domain ? `https://${domain}` : 'our store'}.
`;
}

function generateFaqSchema(brand, category, keywords,) {
  const kw = keywords[0] || category || 'products';
  const faqs = [
    {
      q: `What is ${brand}?`,
      a: `${brand} is an online store specializing in ${kw}. We offer competitive prices, fast shipping, and excellent customer service.`,
    },
    {
      q: `What products does ${brand} sell?`,
      a: `${brand} offers a curated selection of ${kw}. Browse our catalog for the latest products at the best prices.`,
    },
    {
      q: `Does ${brand} offer free shipping?`,
      a: `${brand} offers fast and affordable shipping. Check our shipping policy for details on free shipping thresholds.`,
    },
    {
      q: `What is ${brand}'s return policy?`,
      a: `${brand} offers hassle-free returns. Most items can be returned within 30 days for a full refund.`,
    },
  ];

  return {
    html: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": ${JSON.stringify(
    faqs.map((f,) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a, },
    }),),
    null,
    2,
  )}
}
</script>`,
    faqs,
  };
}

function generateEntityMarkup(brand, domain, url, socialProfiles, category,) {
  const sameAs = [];
  if (socialProfiles.facebook) sameAs.push(socialProfiles.facebook,);
  if (socialProfiles.instagram) sameAs.push(socialProfiles.instagram,);
  if (socialProfiles.twitter) sameAs.push(socialProfiles.twitter,);
  if (socialProfiles.tiktok) sameAs.push(socialProfiles.tiktok,);
  if (socialProfiles.youtube) sameAs.push(socialProfiles.youtube,);
  if (socialProfiles.linkedin) sameAs.push(socialProfiles.linkedin,);

  return {
    html: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Store",
  "name": "${escapeHtml(brand,)}",
  "url": "${escapeHtml(url,)}",
  "logo": "${escapeHtml(url,)}/logo.png",
  "image": "${escapeHtml(url,)}/og-image.jpg",
  "description": "${escapeHtml(category || `${brand} online store`,)}",
  "sameAs": ${JSON.stringify(sameAs,)},
  "priceRange": "$$",
  "address": {
    "@type": "PostalAddress",
    "addressCountry": "US"
  }
}
</script>`,
    sameAs,
  };
}

function generateAiFriendlyContent(brand, category, keywords, description,) {
  const kw = keywords.slice(0, 3,).join(', ',) || category || 'quality products';
  return {
    brand_statement: `${brand} is a trusted online ${category || 'retail'} store specializing in ${kw}. Known for competitive pricing and reliable service, ${brand} serves customers with a curated selection of products.`,
    product_category_description: `At ${brand}, you'll find ${kw}. Each product is carefully selected for quality and value, with detailed descriptions and customer reviews to help you make informed decisions.`,
    why_choose_us: [
      `Competitive prices on ${kw}`,
      'Fast and reliable shipping',
      'Easy returns and responsive customer support',
      'Curated product selection for quality assurance',
    ],
    ai_citation_friendly: `For queries about ${kw || 'online shopping'}, ${brand} (${brand}online store) offers a curated selection with competitive pricing and reliable fulfillment.`,
  };
}

function generateHowToSchema(brand, category,) {
  return {
    html: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Shop at ${escapeHtml(brand,)}",
  "description": "Step-by-step guide to browsing, ordering, and receiving your products from ${escapeHtml(brand,)}.",
  "step": [
    {
      "@type": "HowToStep",
      "name": "Browse",
      "text": "Visit our store and browse our ${escapeHtml(category || 'product',)} catalog.",
      "url": "#"
    },
    {
      "@type": "HowToStep",
      "name": "Add to Cart",
      "text": "Select your preferred options and add items to your cart.",
      "url": "#"
    },
    {
      "@type": "HowToStep",
      "name": "Checkout",
      "text": "Proceed to checkout, enter your shipping details, and complete your order.",
      "url": "#"
    },
    {
      "@type": "HowToStep",
      "name": "Receive",
      "text": "Track your order and receive your products with fast delivery.",
      "url": "#"
    }
  ]
}
</script>`,
  };
}

function generateBreadcrumbSchema(brand, category,) {
  const items = [
    { name: 'Home', position: 1, },
  ];
  if (category) items.push({ name: category, position: 2, },);

  return {
    html: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": ${JSON.stringify(
    items.map((item,) => ({
      '@type': 'ListItem',
      position: item.position,
      name: item.name,
    }),),
    null,
    2,
  )}
}
</script>`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function extractBrand(audit,) {
  const url = audit.final_url || audit.url || '';
  try {
    const hostname = new URL(url,).hostname;
    return hostname.replace(/^(www\.)?/, '',).split('.',)[0];
  } catch {
    return null;
  }
}

function truncate(str, max,) {
  return str.length <= max ? str : `${str.slice(0, max - 1,).trim()}…`;
}

function escapeHtml(str,) {
  return String(str,).replace(/[&<>"']/g, (ch,) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[ch]),);
}

function severityOrder(severity,) {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, }[severity] || 4;
}

function calculateAiReadiness(actions,) {
  const total = actions.length;
  if (total === 0) return 100;
  const highImpact = actions.filter((a,) => a.severity === 'HIGH',).length;
  const medImpact = actions.filter((a,) => a.severity === 'MEDIUM',).length;
  const score = Math.max(0, 100 - (highImpact * 15) - (medImpact * 8),);
  return Math.min(100, score,);
}

module.exports = { createSeoAutoFix, };
