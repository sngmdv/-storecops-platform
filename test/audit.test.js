"use strict";

process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert");
const { createPlatform } = require("../src/platform");
const { createApp } = require("../src/server/createApp");
const { assertSafeUrl } = require("../src/server/storeAudit");

/** Boot the app on an ephemeral port and return base URL + closer. */
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

// A deliberately poor storefront page: short title, no description,
// duplicate H1s, missing alt text, no viewport, no OG/JSON-LD.
const BAD_HTML = `<!DOCTYPE html>
<html><head><title>Buy</title></head>
<body>
  <h1>One headline</h1>
  <h1>Second headline</h1>
  <img src="/a.jpg">
  <img src="/b.jpg">
  <img src="/c.jpg" alt="the only described image">
</body></html>`;

function startBadStore() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("User-agent: *\nAllow: /\n");
      }
      if (req.url === "/sitemap.xml" || req.url === "/favicon.ico") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(BAD_HTML);
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })
    );
  });
}

test("Store audit: runs 13 real checks against a live site and persists the report", async () => {
  const target = await startBadStore();
  const { base, close } = await bootServer();

  try {
    const res = await fetch(`${base}/api/v1/audit/site`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: target.url }),
    });
    assert.equal(res.status, 201);
    const report = await res.json();

    assert.ok(report.report_id, "report is persisted and addressable");
    assert.ok(report.checks.length >= 12, `expected 12+ checks, got ${report.checks.length}`);
    assert.ok(report.score >= 0 && report.score < 60, "bad page should score poorly");
    assert.ok(report.top_actions.length >= 3, "suggestions are listed");

    const byKey = Object.fromEntries(report.checks.map((c) => [c.key, c]));
    assert.equal(byKey.https.status, "FAIL", "plain HTTP site fails the TLS check");
    assert.equal(byKey.ttfb.status, "PASS", "local server answers fast");
    assert.equal(byKey.title.status, "WARN", "3-char title is out of range");
    assert.equal(byKey.meta_description.status, "FAIL");
    assert.equal(byKey.h1.status, "WARN", "two H1s");
    assert.equal(byKey.alt.status, "FAIL", "1/3 images described");
    assert.equal(byKey.viewport.status, "FAIL");
    assert.equal(byKey.security_headers.status, "FAIL", "no security headers set");
    assert.equal(byKey.structured.status, "FAIL", "no OG, no JSON-LD");
    assert.equal(byKey.crawlables.status, "WARN", "only robots.txt present");
    // Every check carries an actionable suggestion.
    for (const check of report.checks) {
      assert.ok(check.suggestion && check.suggestion.length > 10, `${check.key} needs a suggestion`);
    }

    // Report retrievable by id + listed in recent audits.
    const got = await fetch(`${base}/api/v1/audit/site/${report.report_id}`);
    assert.equal(got.status, 200);
    assert.equal((await got.json()).score, report.score);

    const recent = await (await fetch(`${base}/api/v1/audit/recent`)).json();
    assert.ok(recent.some((r) => r.report_id === report.report_id));

    // Unknown report → 404.
    const missing = await fetch(`${base}/api/v1/audit/site/nope-nope`);
    assert.equal(missing.status, 404);
  } finally {
    await close();
    target.close();
  }
});

test("Store audit: SSRF guard blocks private hosts outside test mode", () => {
  assert.throws(() => assertSafeUrl("http://localhost:4000"), /Private\/local/);
  assert.throws(() => assertSafeUrl("http://192.168.1.5"), /Private\/local/);
  assert.throws(() => assertSafeUrl("http://10.0.0.12/admin"), /Private\/local/);
  assert.throws(() => assertSafeUrl("httpz://example.com"), /http\/https/);
  assert.throws(() => assertSafeUrl("::::not a url"), /valid URL/);

  // Opt-in escape hatch (used by the test suite itself).
  const parsed = assertSafeUrl("http://127.0.0.1:3000", { allowPrivateHosts: true });
  assert.equal(parsed.hostname, "127.0.0.1");

  // Public hosts pass, scheme defaults to https.
  assert.equal(assertSafeUrl("example.com").protocol, "https:");
  assert.equal(assertSafeUrl("https://my-store.com").hostname, "my-store.com");
});

test("Store audit: unreachable / garbage URLs produce a friendly error", async () => {
  const { base, close } = await bootServer();
  try {
    // No body at all.
    const empty = await fetch(`${base}/api/v1/audit/site`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);

    // Non-http(s) scheme rejected with a friendly error.
    const bad = await fetch(`${base}/api/v1/audit/site`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "httpz://nope.example" }),
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /http\/https/);
  } finally {
    await close();
  }
});
