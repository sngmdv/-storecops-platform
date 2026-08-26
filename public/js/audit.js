"use strict";

/* Deep audit page: run audit, show summary (public), full report (gated). */

(function () {
  const $ = (sel) => document.querySelector(sel);

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  const BULB = '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--amber)"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>';

  let currentReport = null;
  let currentDeepAudit = null;
  let isAuthed = false;

  function ringColor(score) {
    if (score >= 85) return "linear-gradient(135deg, #22c55e, #16a34a)";
    if (score >= 70) return "linear-gradient(135deg, #84cc16, #22c55e)";
    if (score >= 55) return "linear-gradient(135deg, #f59e0b, #eab308)";
    return "linear-gradient(135deg, #f87171, #ef4444)";
  }

  function barColor(score) {
    if (score >= 70) return "#22c55e";
    if (score >= 50) return "#f59e0b";
    return "#ef4444";
  }

  // Check if user is authenticated (session in localStorage)
  async function checkAuth() {
    try {
      const sess = JSON.parse(localStorage.getItem("storecops_session") || "null");
      isAuthed = !!(sess?.token || sess?.apiKey);
      return isAuthed;
    } catch {
      isAuthed = false;
      return false;
    }
  }

  function authHeaders() {
    const sess = JSON.parse(localStorage.getItem("storecops_session") || "null");
    const headers = { "Content-Type": "application/json" };
    if (sess?.token) headers["Authorization"] = `Bearer ${sess.token}`;
    else if (sess?.apiKey) headers["X-API-Key"] = sess.apiKey;
    return headers;
  }

  /** Render the public summary view (score + top 3 issues + signup CTA). */
  function renderSummary(summary) {
    currentDeepAudit = summary;

    $("#score-num").textContent = summary.overall_score;
    $("#score-grade").textContent = summary.grade;
    $("#score-ring").style.background = ringColor(summary.overall_score);
    $("#report-url").textContent = summary.url;
    $("#report-sub").textContent = `${summary.passed_checks} of ${summary.total_checks} checks passed`;

    // Category scores
    const catHtml = Object.entries(summary.categories || {}).map(([key, val]) => `
      <div style="margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span style="font-weight: 600; text-transform: capitalize;">${esc(key)}</span>
          <span style="font-weight: 700; color: ${barColor(val.score)};">${val.score}%</span>
        </div>
        <div style="background: #e2e8f0; height: 8px; border-radius: 4px; overflow: hidden;">
          <div style="background: ${barColor(val.score)}; height: 100%; width: ${val.score}%; border-radius: 4px;"></div>
        </div>
      </div>
    `).join("");

    // AI readiness
    const aiScore = summary.ai_readiness?.score || 0;
    const aiHtml = `
      <div style="margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span style="font-weight: 600;">AI Search Readiness</span>
          <span style="font-weight: 700; color: ${barColor(aiScore)};">${aiScore}%</span>
        </div>
        <div style="background: #e2e8f0; height: 8px; border-radius: 4px; overflow: hidden;">
          <div style="background: ${barColor(aiScore)}; height: 100%; width: ${aiScore}%; border-radius: 4px;"></div>
        </div>
      </div>
    `;

    $("#category-scores").innerHTML = catHtml + aiHtml;

    // Top issues (limited to 3 for public)
    const issues = summary.top_issues || [];
    $("#top-actions").innerHTML = issues.length
      ? issues.map((a) => `<li>${esc(a.label)} <span style="color: #888; font-size: 12px;">(${esc(a.category)})</span></li>`).join("")
      : "<li>No critical issues found!</li>";

    // Show gated message
    $("#gated-message").style.display = "block";
    $("#gated-message").innerHTML = `
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 24px; border-radius: 12px; text-align: center; margin-top: 20px;">
        <h3 style="color: white; margin: 0 0 8px;">Want the full report?</h3>
        <p style="color: #e2e8f0; margin: 0 0 16px; font-size: 14px;">
          Sign up free to unlock detailed findings, PDF download, and email delivery.
        </p>
        <a href="/app" style="background: white; color: #667eea; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
          Sign Up & Get Full Report
        </a>
      </div>
    `;

    $("#report-card").style.display = "block";
    $("#cta-strip").style.display = "block";
    $("#report-card").scrollIntoView({ behavior: "smooth" });
  }

  /** Render the full authenticated report view. */
  function renderFullReport(report) {
    currentReport = report;

    $("#score-num").textContent = report.overall_score;
    $("#score-grade").textContent = report.grade;
    $("#score-ring").style.background = ringColor(report.overall_score);
    $("#report-url").textContent = report.url;
    $("#report-sub").textContent = `Audited ${new Date(report.audited_at).toLocaleString()} · ${report.passed_checks}/${report.total_checks} checks passed`;

    // All category scores with detailed breakdowns
    const categories = report.categories || {};
    const catHtml = Object.entries(categories).map(([key, cat]) => {
      const checks = cat.checks || [];
      const checksHtml = checks.map((c) => `
        <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px;">
          <span style="color: ${c.pass ? "#22c55e" : "#ef4444"}; font-weight: 700;">${c.pass ? "✓" : "✗"}</span>
          <span>${esc(c.label)}</span>
        </div>
      `).join("");
      return `
        <div style="margin-bottom: 16px; padding: 12px; background: #f8f9fa; border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-weight: 700; text-transform: capitalize; font-size: 14px;">${esc(key)}</span>
            <span style="font-weight: 700; color: ${barColor(cat.score)}; font-size: 16px;">${cat.score}%</span>
          </div>
          <div style="background: #e2e8f0; height: 6px; border-radius: 3px; overflow: hidden; margin-bottom: 8px;">
            <div style="background: ${barColor(cat.score)}; height: 100%; width: ${cat.score}%; border-radius: 3px;"></div>
          </div>
          <div>${checksHtml}</div>
        </div>
      `;
    }).join("");

    // AI readiness signals
    const ai = report.ai_readiness || {};
    const aiSignals = (ai.signals || []).map((s) => `
      <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px;">
        <span style="color: ${s.status === "pass" ? "#22c55e" : s.status === "warn" ? "#f59e0b" : "#ef4444"}; font-weight: 700;">
          ${s.status === "pass" ? "✓" : s.status === "warn" ? "!" : "✗"}
        </span>
        <span style="font-weight: 600;">${esc(s.signal.replace(/_/g, " "))}</span>
        <span style="color: #666; font-size: 12px;">— ${esc(s.detail)}</span>
      </div>
    `).join("");

    $("#category-scores").innerHTML = catHtml + `
      <div style="margin-bottom: 16px; padding: 12px; background: #f0f4ff; border-radius: 8px; border: 1px solid #667eea;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-weight: 700; font-size: 14px;">AI Search Readiness</span>
          <span style="font-weight: 700; color: ${barColor(ai.score || 0)}; font-size: 16px;">${ai.score || 0}%</span>
        </div>
        <div style="background: #e2e8f0; height: 6px; border-radius: 3px; overflow: hidden; margin-bottom: 8px;">
          <div style="background: ${barColor(ai.score || 0)}; height: 100%; width: ${ai.score || 0}%; border-radius: 3px;"></div>
        </div>
        <div>${aiSignals}</div>
      </div>
    `;

    // All top issues
    const issues = report.top_issues || [];
    $("#top-actions").innerHTML = issues.length
      ? issues.map((a) => `
          <li>
            <span style="color: ${a.weight >= 20 ? "#ef4444" : a.weight >= 10 ? "#f59e0b" : "#888"}; font-weight: 700;">
              [${a.weight >= 20 ? "HIGH" : a.weight >= 10 ? "MED" : "LOW"}]
            </span>
            ${esc(a.label)} <span style="color: #888; font-size: 12px;">(${esc(a.category)})</span>
          </li>
        `).join("")
      : "<li>No critical issues found!</li>";

    // Hide gated message, show action buttons
    $("#gated-message").style.display = "none";
    $("#full-actions").style.display = "flex";
    $("#email-btn").style.display = "inline-flex";

    $("#report-card").style.display = "block";
    $("#cta-strip").style.display = "block";
    $("#report-card").scrollIntoView({ behavior: "smooth" });
  }

  /** Download PDF report (authenticated). */
  async function downloadPdf() {
    if (!currentReport) return;
    try {
      const res = await fetch(`/api/v1/audit/report/${currentReport._id}/pdf`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to download PDF");
      const data = await res.json();
      const pdfBytes = Uint8Array.from(atob(data.pdf), c => c.charCodeAt(0));
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (error) {
      alert("Failed to download PDF: " + error.message);
    }
  }

  /** Email PDF report (authenticated). */
  async function emailReport() {
    if (!currentReport) return;
    const email = prompt("Enter your email to receive the full PDF report:");
    if (!email) return;
    try {
      const res = await fetch(`/api/v1/audit/report/${currentReport._id}/email`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error("Failed to send email");
      const data = await res.json();
      if (data.delivered) {
        alert("Report sent to " + email + "!");
      } else {
        alert("Failed to send report. Please try again.");
      }
    } catch (error) {
      alert("Failed to send email: " + error.message);
    }
  }

  // ── Event listeners ───────────────────────────────────────────────

  $("#audit-btn").addEventListener("click", async () => {
    const url = $("#audit-url").value.trim();
    $("#audit-error").textContent = "";
    if (!url) {
      $("#audit-error").textContent = "Enter your store URL first.";
      return;
    }

    const btn = $("#audit-btn");
    btn.disabled = true;
    btn.textContent = "Analyzing…";
    $("#audit-progress").style.display = "block";
    $("#report-card").style.display = "none";
    $("#cta-strip").style.display = "none";
    $("#full-actions").style.display = "none";

    try {
      // Check auth first
      await checkAuth();

      // Run deep audit (public endpoint returns summary)
      const email = $("#audit-email")?.value?.trim() || null;
      const res = await fetch("/api/v1/audit/deep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, email }),
      });
      const summary = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(summary.error || `Audit failed (${res.status})`);

      // If authenticated, fetch full report
      if (isAuthed && summary.report_id) {
        const fullRes = await fetch(`/api/v1/audit/report/${summary.report_id}`, { headers: authHeaders() });
        if (fullRes.ok) {
          const fullReport = await fullRes.json();
          renderFullReport(fullReport);
        } else {
          renderSummary(summary);
        }
      } else {
        renderSummary(summary);
      }
    } catch (error) {
      $("#audit-error").innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> ' + esc(error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Audit my store";
      $("#audit-progress").style.display = "none";
    }
  });

  $("#audit-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#audit-btn").click();
  });

  // Download button (PDF for authed, HTML for public)
  $("#download-btn").addEventListener("click", () => {
    if (isAuthed && currentReport) {
      downloadPdf();
    } else {
      // Fallback to HTML download for public
      if (!currentReport) return;
      const r = currentDeepAudit;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Storecops Audit — ${esc(r.url)}</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;max-width:860px;margin:40px auto;color:#171923">
<h1>Store Health Report</h1>
<p><b>${esc(r.url)}</b></p>
<h2 style="color:${r.overall_score >= 70 ? "#22c55e" : r.overall_score >= 55 ? "#f59e0b" : "#ef4444"}">Score ${r.overall_score}/100 — Grade ${r.grade}</h2>
<p>${r.passed_checks} of ${r.total_checks} checks passed</p>
<h3>Top Issues</h3>
<ol>${(r.top_issues || []).map((a) => `<li>${esc(a.label)} (${esc(a.category)})</li>`).join("") || "<li>None found.</li>"}</ol>
<p style="margin-top:30px;color:#888;font-size:13px">Sign up at storecops.com for the full detailed report with PDF download.</p>
</body></html>`;
      const blob = new Blob([html], { type: "text/html" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `storecops-audit-summary.html`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  });

  // Email button (only for authenticated)
  const emailBtn = $("#email-btn");
  if (emailBtn) {
    emailBtn.addEventListener("click", emailReport);
  }

  // Email report button in full-actions section
  const emailReportBtn = $("#email-report-btn");
  if (emailReportBtn) {
    emailReportBtn.addEventListener("click", emailReport);
  }

  // Check auth on page load
  checkAuth();
})();
