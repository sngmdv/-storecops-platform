"use strict";

/**
 * Generate a beautifully formatted HTML document from STORECOPS_PLATFORM.md
 * that can be printed to PDF from any browser (Ctrl+P → Save as PDF).
 *
 * Run: node generate-doc-pdf.js
 * Output: STORECOPS_PLATFORM.html (open in browser, Ctrl+P → Save as PDF)
 */

const fs = require("fs");
const path = require("path");

const md = fs.readFileSync(path.join(__dirname, "STORECOPS_PLATFORM.md"), "utf8");

// Simple markdown to HTML converter
function mdToHtml(md) {
  const lines = md.split("\n");
  let html = "";
  let inTable = false;
  let inCode = false;
  let tableRows = [];
  let codeLines = [];
  let inList = false;

  function flushTable() {
    if (!tableRows.length) return;
    html += '<table><thead><tr>';
    const headers = tableRows[0];
    for (const h of headers) html += `<th>${inlineFormat(h)}</th>`;
    html += '</tr></thead><tbody>';
    for (let r = 1; r < tableRows.length; r++) {
      html += '<tr>';
      for (const cell of tableRows[r]) html += `<td>${inlineFormat(cell)}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table>\n';
    tableRows = [];
    inTable = false;
  }

  function flushList() {
    if (inList) { html += '</ul>\n'; inList = false; }
  }

  function inlineFormat(text) {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] || "";

    // Code blocks
    if (line.startsWith("```")) {
      if (inCode) {
        html += `<pre><code>${codeLines.join("\n").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>\n`;
        codeLines = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    // Tables
    if (line.startsWith("|") && !inTable && next && /^\|[\s-:|]+\|$/.test(next.trim())) {
      flushList();
      inTable = true;
      tableRows = [line.split("|").slice(1, -1).map(c => c.trim())];
      i++; // skip separator
      continue;
    }
    if (inTable) {
      if (line.startsWith("|")) {
        tableRows.push(line.split("|").slice(1, -1).map(c => c.trim()));
      } else {
        flushTable();
        i--; // re-process
      }
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { flushList(); html += "<hr>\n"; continue; }

    // Blockquote
    if (line.startsWith(">")) {
      flushList();
      html += `<blockquote>${inlineFormat(line.replace(/^>\s*/, ""))}</blockquote>\n`;
      continue;
    }

    // Headers
    const h1 = line.match(/^# (.+)/);
    if (h1) { flushList(); html += `<h1>${inlineFormat(h1[1])}</h1>\n`; continue; }
    const h2 = line.match(/^## (.+)/);
    if (h2) { flushList(); html += `<h2 id="sec-${h2[1].split(".")[0]}">${inlineFormat(h2[1])}</h2>\n`; continue; }
    const h3 = line.match(/^### (.+)/);
    if (h3) { flushList(); html += `<h3>${inlineFormat(h3[1])}</h3>\n`; continue; }
    const h4 = line.match(/^#### (.+)/);
    if (h4) { flushList(); html += `<h4>${inlineFormat(h4[1])}</h4>\n`; continue; }

    // Unordered list
    if (/^[-*] /.test(line)) {
      if (!inList) { html += '<ul>\n'; inList = true; }
      html += `<li>${inlineFormat(line.replace(/^[-*] /, ""))}</li>\n`;
      continue;
    }

    // Numbered list
    if (/^\d+\.\s/.test(line)) {
      if (!inList) { html += '<ul class="ordered">\n'; inList = true; }
      html += `<li>${inlineFormat(line)}</li>\n`;
      continue;
    }

    // Empty line
    if (!line.trim()) { flushList(); continue; }

    // Paragraph
    flushList();
    html += `<p>${inlineFormat(line)}</p>\n`;
  }

  flushTable();
  flushList();
  return html;
}

const content = mdToHtml(md);

const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Storecops Growth Platform — Complete Technical Reference</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

  :root {
    --primary: #667eea;
    --primary-dark: #5a67d8;
    --accent: #764ba2;
    --text: #1a1a2e;
    --text-light: #4a5568;
    --text-muted: #718096;
    --border: #e2e8f0;
    --bg-light: #f7fafc;
    --bg-code: #edf2f7;
    --success: #38a169;
    --white: #ffffff;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--text);
    line-height: 1.7;
    font-size: 14px;
    max-width: 900px;
    margin: 0 auto;
    padding: 0 40px;
  }

  /* ── Cover Page ─────────────────────────────────────── */
  .cover {
    background: linear-gradient(135deg, var(--primary) 0%, var(--accent) 100%);
    color: white;
    padding: 80px 60px;
    border-radius: 16px;
    margin: 40px 0 60px;
    text-align: center;
    page-break-after: always;
  }
  .cover h1 { font-size: 48px; font-weight: 800; letter-spacing: -1px; margin-bottom: 8px; }
  .cover .subtitle { font-size: 18px; opacity: 0.85; font-weight: 500; margin-bottom: 30px; }
  .cover .divider { width: 120px; height: 3px; background: rgba(255,255,255,0.3); margin: 24px auto; border-radius: 2px; }
  .cover .desc { font-size: 15px; opacity: 0.9; max-width: 500px; margin: 0 auto 20px; line-height: 1.6; }
  .cover .stats {
    display: flex; justify-content: center; gap: 30px; flex-wrap: wrap;
    background: rgba(255,255,255,0.1); border-radius: 12px; padding: 20px; margin-top: 30px;
  }
  .cover .stat { text-align: center; }
  .cover .stat-num { font-size: 28px; font-weight: 800; }
  .cover .stat-label { font-size: 11px; opacity: 0.8; text-transform: uppercase; letter-spacing: 1px; }
  .cover .version { margin-top: 30px; font-size: 12px; opacity: 0.6; }

  /* ── Table of Contents ──────────────────────────────── */
  .toc {
    page-break-after: always;
    padding: 40px 0;
  }
  .toc h2 { font-size: 28px; color: var(--primary); margin-bottom: 24px; }
  .toc-list { list-style: none; }
  .toc-list li {
    padding: 10px 16px; border-bottom: 1px solid var(--border);
    font-size: 15px; font-weight: 500; display: flex; align-items: center; gap: 12px;
  }
  .toc-list li:nth-child(odd) { background: var(--bg-light); }
  .toc-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 8px;
    background: var(--primary); color: white; font-size: 13px; font-weight: 700; flex-shrink: 0;
  }

  /* ── Headings ───────────────────────────────────────── */
  h1 { font-size: 32px; font-weight: 800; color: var(--text); margin: 40px 0 16px; }
  h2 {
    font-size: 22px; font-weight: 700; color: var(--primary);
    margin: 48px 0 16px; padding-bottom: 8px;
    border-bottom: 3px solid var(--primary);
    page-break-after: avoid;
  }
  h3 { font-size: 17px; font-weight: 700; color: var(--accent); margin: 28px 0 10px; page-break-after: avoid; }
  h4 { font-size: 14px; font-weight: 700; color: var(--text); margin: 20px 0 8px; }

  /* ── Paragraphs & Text ──────────────────────────────── */
  p { margin: 8px 0 12px; color: var(--text-light); }
  strong { color: var(--text); font-weight: 600; }
  blockquote {
    border-left: 4px solid var(--primary);
    padding: 12px 20px; margin: 16px 0;
    background: var(--bg-light); border-radius: 0 8px 8px 0;
    font-style: italic; color: var(--text-light);
  }
  hr { border: none; border-top: 2px solid var(--border); margin: 32px 0; }

  /* ── Lists ──────────────────────────────────────────── */
  ul { margin: 8px 0 16px 24px; }
  ul.ordered { list-style: decimal; }
  li { margin: 4px 0; color: var(--text-light); }
  li strong { color: var(--text); }

  /* ── Tables ─────────────────────────────────────────── */
  table {
    width: 100%; border-collapse: collapse; margin: 16px 0 24px;
    font-size: 13px; page-break-inside: avoid;
  }
  thead { background: var(--primary); color: white; }
  th {
    padding: 10px 14px; text-align: left; font-weight: 600;
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;
  }
  td { padding: 9px 14px; border-bottom: 1px solid var(--border); color: var(--text-light); }
  tbody tr:nth-child(even) { background: var(--bg-light); }
  tbody tr:hover { background: #edf2f7; }

  /* ── Code ───────────────────────────────────────────── */
  code {
    background: var(--bg-code); padding: 2px 6px; border-radius: 4px;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 12px; color: var(--accent);
  }
  pre {
    background: #1a202c; color: #e2e8f0; padding: 20px; border-radius: 10px;
    overflow-x: auto; margin: 16px 0; font-size: 12px; line-height: 1.6;
    page-break-inside: avoid;
  }
  pre code { background: none; color: inherit; padding: 0; font-size: 12px; }

  /* ── Links ──────────────────────────────────────────── */
  a { color: var(--primary); text-decoration: none; font-weight: 500; }
  a:hover { text-decoration: underline; }

  /* ── Print Styles ───────────────────────────────────── */
  @media print {
    body { padding: 0; font-size: 12px; max-width: 100%; }
    .cover { page-break-after: always; margin: 0; border-radius: 0; }
    .toc { page-break-after: always; }
    h2 { page-break-after: avoid; margin-top: 28px; }
    h3, h4 { page-break-after: avoid; }
    table { page-break-inside: avoid; }
    pre { page-break-inside: avoid; background: #f7fafc; color: #1a202c; border: 1px solid #e2e8f0; }
    a { color: var(--primary); }
    @page { margin: 20mm 18mm; size: A4; }
  }
</style>
</head>
<body>

<!-- Cover Page -->
<div class="cover">
  <h1>STORECOPS</h1>
  <div class="subtitle">GROWTH PLATFORM</div>
  <div class="divider"></div>
  <div class="desc">
    Complete Technical Reference<br>
    AI-Driven E-Commerce Growth Platform
  </div>
  <div class="desc" style="font-size:13px; opacity:0.75;">
    Architecture &middot; Features &middot; API &middot; Database &middot; Deployment
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-num">188</div><div class="stat-label">Tests</div></div>
    <div class="stat"><div class="stat-num">58</div><div class="stat-label">Source Files</div></div>
    <div class="stat"><div class="stat-num">42</div><div class="stat-label">Collections</div></div>
    <div class="stat"><div class="stat-num">6</div><div class="stat-label">Layers</div></div>
    <div class="stat"><div class="stat-num">19</div><div class="stat-label">Test Files</div></div>
  </div>
  <div class="version">Version 1.0.0 &nbsp;|&nbsp; August 2026 &nbsp;|&nbsp; Node.js 18+</div>
</div>

<!-- Table of Contents -->
<div class="toc">
  <h2>Table of Contents</h2>
  <ul class="toc-list">
    <li><span class="toc-num">1</span> Vision &amp; Product Summary</li>
    <li><span class="toc-num">2</span> Tech Stack</li>
    <li><span class="toc-num">3</span> Architecture — 6-Layer Growth Loop</li>
    <li><span class="toc-num">4</span> Directory Structure</li>
    <li><span class="toc-num">5</span> Database Collections</li>
    <li><span class="toc-num">6</span> API Endpoints</li>
    <li><span class="toc-num">7</span> Key Features</li>
    <li><span class="toc-num">8</span> Growth Loop (Layer 6)</li>
    <li><span class="toc-num">9</span> Frontend Architecture</li>
    <li><span class="toc-num">10</span> Testing</li>
    <li><span class="toc-num">11</span> Configuration</li>
    <li><span class="toc-num">12</span> Deployment</li>
    <li><span class="toc-num">13</span> Code Conventions</li>
    <li><span class="toc-num">14</span> Extension Points</li>
    <li><span class="toc-num">15</span> Current Status</li>
  </ul>
</div>

<!-- Content -->
${content}

</body>
</html>`;

const outPath = path.join(__dirname, "STORECOPS_PLATFORM.html");
fs.writeFileSync(outPath, fullHtml);
console.log("Generated: STORECOPS_PLATFORM.html");
console.log(`Size: ${(fullHtml.length / 1024).toFixed(1)} KB`);
console.log("\nOpen this file in your browser, then press Ctrl+P → Save as PDF");
