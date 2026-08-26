"use strict";

/**
 * Layer 2 — SEO Audit Engine.
 *
 * Fetches a page and runs a deterministic on-page SEO checklist:
 * title, meta description, H1, canonical, HTTPS, viewport. Results are
 * persisted so weekly crawls can be compared over time.
 */

function scoreChecks(checks) {
  const passed = checks.filter((check) => check.pass).length;
  return Math.round((passed / checks.length) * 100);
}

function createSeoAuditEngine({ store }) {
  /**
   * Run the audit against HTML. Kept separate from fetch so it is fully
   * testable without network access.
   */
  function auditHtml(html, url) {
    const getTag = (regex) => {
      const match = html.match(regex);
      return match ? match[1] : null;
    };

    const title = getTag(/<title[^>]*>([\s\S]*?)<\/title>/i)?.trim() || null;
    const description = getTag(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i);
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const canonical = getTag(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
    const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);

    const checks = [
      {
        check: "title_tag",
        pass: !!title && title.length >= 10 && title.length <= 70,
        detail: title || "missing",
      },
      {
        check: "meta_description",
        pass: !!description && description.length >= 50 && description.length <= 160,
        detail: description || "missing",
      },
      {
        check: "single_h1",
        pass: !!h1Match && (html.match(/<h1[\s>]/gi) || []).length === 1,
        detail: h1Match ? h1Match[1].replace(/<[^>]+>/g, "").trim() : "missing",
      },
      {
        check: "canonical_link",
        pass: !!canonical,
        detail: canonical || "missing",
      },
      {
        check: "https",
        pass: String(url).startsWith("https://"),
        detail: url,
      },
      {
        check: "mobile_viewport",
        pass: viewport,
        detail: viewport ? "present" : "missing",
      },
    ];

    return {
      url,
      score: scoreChecks(checks),
      checks,
      audited_at: new Date().toISOString(),
    };
  }

  return {
    auditHtml,

    /** Fetch a live URL and audit it. Fails soft on network errors. */
    async auditUrl(url) {
      let audit;

      try {
        const response = await fetch(url, {
          headers: { "user-agent": "StorecopsGrowthPlatform/1.0 (SEO audit)" },
          signal: AbortSignal.timeout(15000),
        });
        const html = await response.text();
        audit = auditHtml(html, url);
        audit.status = "ok";
      } catch (error) {
        audit = {
          url,
          status: "unreachable",
          error: error.message,
          score: 0,
          checks: [],
          audited_at: new Date().toISOString(),
        };
      }

      await store.seoAudits.insert(audit);
      return audit;
    },

    /** Audit history for trend comparison (weekly crawls). */
    async history(url, limit = 10) {
      const audits = await store.seoAudits.find((audit) => audit.url === url);
      return audits
        .sort((a, b) => b.audited_at.localeCompare(a.audited_at))
        .slice(0, limit);
    },
  };
}

module.exports = { createSeoAuditEngine, scoreChecks };
