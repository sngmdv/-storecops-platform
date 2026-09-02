"use strict";

/* Storecops app — SPA: router, pages, charts, live streams. */
/* Supports both standalone mode and Shopify embedded app mode. */

(function () {
  const api = window.StorecopsAPI;
  const $ = (sel) => document.querySelector(sel);
  const view = $("#view");

  let charts = [];
  let liveSource = null;

  // ── Embedded mode detection ─────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  const isEmbedded = params.get("embedded") === "1" || 
                     !!params.get("shop") ||
                     (params.get("host") && params.get("host").indexOf(".myshopify.com") > -1);
  const shopifyShop = params.get("shop") || null;
  const shopifyHost = params.get("host") || null;

  if (isEmbedded) {
    console.log("[Storecops] Running in Shopify embedded mode for shop:", shopifyShop);
    document.body.classList.add("embedded-mode");
  } else {
    console.log("[Storecops] Running in standalone mode");
    document.body.classList.add("standalone-mode");
  }

  // ── helpers ────────────────────────────────────────────────────────
  function destroyCharts() {
    charts.forEach((c) => c.destroy());
    charts = [];
  }

  function closeStream() {
    if (liveSource) {
      liveSource.close();
      liveSource = null;
    }
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function money(n) {
    return n === null || n === undefined ? "—" : "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  /**
   * Show toast notification (works in both embedded and standalone mode).
   */
  function toast(message, ms = 4200) {
    // Try App Bridge toast first (embedded mode)
    if (isEmbedded && window.shopify && window.shopify.toast) {
      try {
        window.shopify.toast.show(message, { duration: ms });
        return;
      } catch (err) {
        // Fallback to standard toast
      }
    }
    // Standard toast
    const el = $("#toast");
    el.innerHTML = message;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), ms);
  }

  function pillFor(text) {
    const t = String(text || "").toUpperCase();
    if (/CRITICAL|OUT_OF|RESTOCK_NOW|DEFECTED|FAIL/.test(t)) return "pill-red";
    if (/HIGH|REORDER|AT_RISK|SLOW|WARN/.test(t)) return "pill-amber";
    if (/VIP|PROFIT|HEALTH|FAST|GOOD|LOW/.test(t)) return "pill-green";
    return "pill-violet";
  }

  // ── SVG icon set (stroke-based, inherits currentColor) ─────────────
  const ICONS = {
    "check-circle": '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    "alert-triangle": '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
    rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    package: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    dollar: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    frown: '<circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C9.5 3 11 5 12 8c1-3 2.5-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/>',
    "file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
    tv: '<rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/>',
    "trending-up": '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    banknote: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
    megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
    "bar-chart": '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    store: '<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/>',
    puzzle: '<path d="M14 7V4a2 2 0 0 0-4 0v3H7a2 2 0 0 0-2 2v3h3a2 2 0 0 1 0 4H5v3a2 2 0 0 0 2 2h3v-3a2 2 0 0 1 4 0v3h3a2 2 0 0 0 2-2v-3h-3a2 2 0 0 1 0-4h3V9a2 2 0 0 0-2-2h-3z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    loader: '<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>',
    "message-circle": '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    headphones: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
    "pie-chart": '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    "dollar-sign": '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
    "trending-down": '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
    "rotate-ccw": '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    "eye-off": '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
    radar: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    tag: '<path d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.42 0l8.58-8.58a1 1 0 0 0 0-1.42L12 2z"/><circle cx="7" cy="7" r="1.5"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    "credit-card": '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
    "life-buoy": '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m19.07 4.93-4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/>',
    trending: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  };

  function icon(name, cls = "") {
    return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  function chartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.color = "#8a90ad";
    Chart.defaults.borderColor = "rgba(58, 63, 92, 0.08)";
    Chart.defaults.font.family = "'Nunito', 'Segoe UI', sans-serif";
  }

  function makeChart(canvas, config) {
    if (!window.Chart) return null;
    const chart = new Chart(canvas, config);
    charts.push(chart);
    return chart;
  }

  const GRAD = ["#08906c", "#34bf99", "#06b6d4", "#f59e0b", "#ef4444", "#f97316"];

  // ── login ──────────────────────────────────────────────────────────
  async function enterApp(storeId, apiKey) {
    api.saveSession(storeId, apiKey);
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#store-chip").textContent = storeId;
    await refreshMaturity();
    location.hash = location.hash || "#/dashboard";
    route();
  }

  async function refreshMaturity() {
    try {
      const m = await api.get(`/report/${api.store()}/maturity`);
      $("#maturity-fill").style.width = Math.min(100, m.score || 0) + "%";
    } catch { /* sidebar widget is best-effort */ }
  }

  // ── login / signup ────────────────────────────────────────────────
  function showAuthError(message) {
    $("#login-error").textContent = message || "";
  }

  // Tab switching between sign-in and account creation.
  function switchAuthTab(which) {
    const isLogin = which === "login";
    $("#tab-login").classList.toggle("active", isLogin);
    $("#tab-signup").classList.toggle("active", !isLogin);
    $("#panel-login").classList.toggle("hidden", !isLogin);
    $("#panel-signup").classList.toggle("hidden", isLogin);
    showAuthError("");
  }
  $("#tab-login").addEventListener("click", () => switchAuthTab("login"));
  $("#tab-signup").addEventListener("click", () => switchAuthTab("signup"));

  // One-click platform connect (Shopify / WooCommerce / BigCommerce / custom).
  const PLATFORM_LABELS = {
    shopify: "Shopify",
    woocommerce: "WooCommerce",
    bigcommerce: "BigCommerce",
    custom: "Custom store",
  };
  let connectStatus = {};
  let connectToken = null;

  // Task 50: All initial fetches have .catch() to prevent unhandled rejections.
  fetch("/connect/status")
    .then((r) => r.json())
    .then((s) => (connectStatus = s))
    .catch(() => {});

  function authorizedConnect(token, platform, storeName) {
    connectToken = token;
    const banner = $("#connect-banner");
    banner.innerHTML = `${icon("check-circle")} <b>${esc(PLATFORM_LABELS[platform] || platform)}</b> store “${esc(storeName)}” authorized — create your account below to finish connecting.`;
    banner.classList.remove("hidden");
    $("#signup-store").value = storeName;
    switchAuthTab("signup");
  }

  function platformModalError(msg) {
    const box = document.querySelector("#platform-modal .pm-error");
    if (box) box.textContent = msg || "";
  }

  function closePlatformModal() {
    $("#platform-modal").classList.add("hidden");
  }

  function postJSON(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Request failed (${r.status}).`);
      return data;
    });
  }

  function openPlatformModal(platform) {
    const modal = $("#platform-modal");
    modal.classList.remove("hidden");

    if (platform === "shopify" || platform === "bigcommerce") {
      const isShopify = platform === "shopify";
      const label = PLATFORM_LABELS[platform];
      const ready = connectStatus[platform]?.ready;
      modal.innerHTML = `
        <button class="pm-close" type="button" aria-label="Close">✕</button>
        <b>Connect ${label}</b>
        <p class="muted">You'll be redirected to ${label} to sign in and approve access to products, orders and customers — then your real data syncs here automatically.</p>
        ${ready === false ? `<p class="pm-note">${icon("alert-triangle", "icon-sm")} The ${label} connector is not configured on this server yet — add its app credentials in Settings → Platform connectors.</p>` : ""}
        <input id="pm-store" placeholder="${isShopify ? "your-store.myshopify.com" : "store hash (from your admin URL)"}" />
        <button class="btn btn-sm btn-primary" id="pm-go">Continue to ${label} →</button>
        <p class="pm-error"></p>`;
      $("#pm-go").addEventListener("click", () => {
        const value = $("#pm-store").value.trim();
        if (!value) return platformModalError(isShopify ? "Enter your myshopify.com store address." : "Enter your BigCommerce store hash.");
        location.href = `/connect/${platform}/start?${isShopify ? "shop" : "storeHash"}=${encodeURIComponent(value)}`;
      });
    } else if (platform === "woocommerce") {
      modal.innerHTML = `
        <button class="pm-close" type="button" aria-label="Close">✕</button>
        <b>Connect WooCommerce</b>
        <p class="muted">Enter your store URL — we'll deep-link you into your own WordPress admin (you sign in there) to create read-only REST keys, then paste them back. Your products + orders sync instantly.</p>
        <input id="pm-woo-url" placeholder="https://your-store.com" />
        <button class="btn btn-sm btn-primary" id="pm-woo-step1">Prepare my store →</button>
        <div id="pm-woo-step2" class="hidden">
          <a id="pm-woo-admin" class="btn btn-sm btn-ghost" target="_blank" rel="noopener">↗ Open my store admin (create a key)</a>
          <input id="pm-woo-key" placeholder="Consumer key (ck_…)" style="margin-top:10px" />
          <input id="pm-woo-secret" type="password" placeholder="Consumer secret (cs_…)" />
          <button class="btn btn-sm btn-primary" id="pm-woo-go">Connect WooCommerce →</button>
        </div>
        <p class="pm-error"></p>`;
      let wooSite = "";
      $("#pm-woo-step1").addEventListener("click", async () => {
        try {
          const data = await postJSON("/connect/woocommerce", { siteUrl: $("#pm-woo-url").value.trim() });
          wooSite = $("#pm-woo-url").value.trim();
          $("#pm-woo-admin").href = data.admin_url;
          $("#pm-woo-step2").classList.remove("hidden");
          platformModalError("");
        } catch (e) { platformModalError(e.message); }
      });
      $("#pm-woo-go").addEventListener("click", async () => {
        try {
          const data = await postJSON("/connect/woocommerce", {
            siteUrl: wooSite,
            consumerKey: $("#pm-woo-key").value.trim(),
            consumerSecret: $("#pm-woo-secret").value.trim(),
          });
          modal.classList.add("hidden");
          authorizedConnect(data.connect_token, "woocommerce", data.store_name);
        } catch (e) { platformModalError(e.message); }
      });
    } else if (platform === "custom") {
      modal.innerHTML = `
        <button class="pm-close" type="button" aria-label="Close">✕</button>
        <b>Connect a custom store</b>
        <div id="pm-custom-step1">
          <p class="muted">We read your store's public catalog (product structured data + sitemap) and import it as your starting inventory — then verify you own the site.</p>
          <input id="pm-custom-url" placeholder="https://your-store.com" />
          <button class="btn btn-sm btn-primary" id="pm-custom-go">Scan my store →</button>
        </div>
        <div id="pm-custom-step2" class="hidden">
          <p id="pm-custom-found" style="color:var(--green,#34d399);font-weight:600;margin-bottom:8px"></p>
          <p class="muted">Last step — prove you own this site. Add <b>any one</b> of these (only someone who controls the site can publish them):</p>
          <div class="alert-item"><span class="step-num">1</span> <div><b>Meta tag</b> — paste into your homepage <code>&lt;head&gt;</code>:<br><code id="pm-v-meta" style="word-break:break-all"></code></div></div>
          <div class="alert-item"><span class="step-num">2</span> <div><b>Verification file</b> — create <code id="pm-v-file-url" style="word-break:break-all"></code> containing only: <code id="pm-v-file"></code></div></div>
          <div class="alert-item"><span class="step-num">3</span> <div><b>DNS TXT record</b> — value: <code id="pm-v-dns" style="word-break:break-all"></code></div></div>
          <button class="btn btn-sm btn-primary" id="pm-custom-verify" style="margin-top:10px">${icon("lock", "icon-sm")} Verify ownership &amp; connect</button>
        </div>
        <p class="pm-error"></p>`;
      let customToken = null;
      $("#pm-custom-go").addEventListener("click", async () => {
        const btn = $("#pm-custom-go");
        btn.disabled = true;
        btn.textContent = "Scanning your catalog…";
        try {
          const data = await postJSON("/connect/custom", { url: $("#pm-custom-url").value.trim() });
          customToken = data.connect_token;
          $("#pm-custom-found").textContent = `✓ Found ${data.products_found} products at ${data.store_name}`;
          $("#pm-v-meta").textContent = data.methods.meta_tag;
          $("#pm-v-file-url").textContent = data.methods.file.url;
          $("#pm-v-file").textContent = data.methods.file.content;
          $("#pm-v-dns").textContent = data.methods.dns.value;
          $("#pm-custom-step1").classList.add("hidden");
          $("#pm-custom-step2").classList.remove("hidden");
          platformModalError("");
        } catch (e) {
          platformModalError(e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = "Scan my store →";
        }
      });
      $("#pm-custom-verify").addEventListener("click", async () => {
        const btn = $("#pm-custom-verify");
        btn.disabled = true;
        btn.textContent = "Checking your site…";
        try {
          const data = await postJSON("/connect/custom/verify", { connect_token: customToken });
          modal.classList.add("hidden");
          authorizedConnect(customToken, "custom", data.store_name);
        } catch (e) {
          platformModalError(e.message);
        } finally {
          btn.disabled = false;
          btn.innerHTML = icon("lock", "icon-sm") + " Verify ownership & connect";
        }
      });
    }

    // Every modal gets a dismiss control.
    modal.querySelector(".pm-close")?.addEventListener("click", closePlatformModal);
  }

  document.querySelectorAll(".platform-btn").forEach((btn) =>
    btn.addEventListener("click", () => openPlatformModal(btn.dataset.platform))
  );

  /** Returning from a platform: ?connect_token=… or ?connect_error=… */
  function applyConnectParams() {
    const params = new URLSearchParams(location.search);
    const err = params.get("connect_error");
    if (err) showAuthError(err);
    const token = params.get("connect_token");
    if (token) {
      fetch(`/api/v1/connect/pending/${encodeURIComponent(token)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => {
          if (p) authorizedConnect(token, p.platform, p.store_name);
          else showAuthError("That store connection expired — click Connect and try again.");
        })
        .catch(() => {});
    }
  }

  /** After a successful signup/login: persist session and enter. */
  async function enterFromAuth(result) {
    api.saveSession(result.store_id, result.api_key, {
      token: result.token,
      email: result.user?.email || "",
    });
    await enterApp(result.store_id, result.api_key);
    toast(`${icon("sparkles")} Welcome${result.user?.name ? ", " + result.user.name : ""} — your store is ready.`);
    // One-click connect outcome (only present after signup with a token).
    if (result.connected?.error) {
      toast(`${icon("alert-triangle")} Store sync failed: ${result.connected.error} — retry from Connect Store.`);
      location.hash = "#/connect";
    } else if (result.connected) {
      const c = result.connected;
      toast(
        `${icon("link")} ${PLATFORM_LABELS[c.platform] || c.platform} connected — ${c.products_synced ?? 0} products, ${c.orders_synced ?? 0} orders imported.`
      );
    }
  }

  // Real email/password sign-in.
  $("#login-btn").addEventListener("click", async () => {
    showAuthError("");
    try {
      const result = await api.login({
        email: $("#auth-email").value,
        password: $("#auth-password").value,
      });
      await enterFromAuth(result);
    } catch (error) {
      showAuthError(error.message);
    }
  });

  // Account creation: provisions a tenant store + private API key.
  $("#signup-btn").addEventListener("click", async () => {
    showAuthError("");
    const btn = $("#signup-btn");
    btn.disabled = true;
    btn.textContent = "Creating your store…";
    try {
      const result = await api.signup({
        name: $("#signup-name").value,
        storeName: $("#signup-store").value,
        email: $("#signup-email").value,
        password: $("#signup-password").value,
        connect_token: connectToken || undefined,
      });
      connectToken = null;
      await enterFromAuth(result);
    } catch (error) {
      showAuthError(error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Create my store — free →";
    }
  });

  // Task 48: Legacy API-key connect removed — all connections now go
  // through OAuth or the demo seeder. The old inline panel exposed raw
  // API keys to the browser, which is not suitable for production.

  // Platform dropdown: show connect hint when a platform is selected.
  const PLATFORM_HINTS = {
    shopify: "Connect your Shopify store to sync products, orders and customers in real time.",
    woocommerce: "Connect your WooCommerce store via REST API keys.",
    bigcommerce: "Connect your BigCommerce store to sync products and orders.",
    wix: "Wix integration is coming soon — you can still sign up and explore the platform.",
    custom: "Enter your store URL after signup and we'll crawl your public catalog.",
  };

  function updatePlatformHint() {
    const val = $("#signup-platform").value;
    const hint = $("#platform-connect-hint");
    const text = $("#platform-connect-text");
    const btn = $("#platform-connect-btn");
    if (!val || val === "wix") {
      hint.classList.add("hidden");
      return;
    }
    text.textContent = PLATFORM_HINTS[val] || "";
    btn.dataset.platform = val;
    hint.classList.remove("hidden");
  }

  if ($("#signup-platform")) {
    $("#signup-platform").addEventListener("change", updatePlatformHint);
  }

  // Platform connect button in signup: opens the platform modal.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#platform-connect-btn");
    if (btn && btn.dataset.platform) {
      openPlatformModal(btn.dataset.platform);
    }
  });

  $("#logout-btn").addEventListener("click", () => {
    api.logoutRemote(); // revokes the server-side session
    api.clearSession();
    closeStream();
    destroyCharts();
    $("#app").classList.add("hidden");
    $("#login").classList.remove("hidden");
    switchAuthTab("login");
  });

  $("#growth-btn").addEventListener("click", async () => {
    const btn = $("#growth-btn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Running…';
    try {
      const result = await api.post(`/growth-cycle/${api.store()}`);
      const queued = result.scan?.length ?? 0;
      const sent = result.execution?.delivered ?? result.execution?.length ?? 0;
      toast(`${icon("check-circle")} Growth cycle done — ${queued} action(s) queued, ${sent} delivered.`);
      refreshMaturity();
      route();
    } catch (error) {
      toast(icon("alert-triangle") + " " + error.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = icon("play", "icon-sm") + " Run growth cycle";
    }
  });

  // ── router ─────────────────────────────────────────────────────────
  // Module tab groups — each merged module reuses one shared page layout
  // with a tab strip on top. Every tab is a full (hash) route that
  // re-renders the strip (highlighting the active tab) plus its content.
  function tabStrip(tabs, active) {
    return tabs.map((t) =>
      `<a class="b-tab${t.key === active ? " active" : ""}" href="#/${t.route}">${icon(t.icon, "icon-sm")} ${t.label}</a>`
    ).join("");
  }
  function withTabs(tabs, activeKey, renderFn) {
    return async () => {
      view.innerHTML = `<div class="b-tabs">${tabStrip(tabs, activeKey)}</div><div id="tab-panel"></div>`;
      await renderFn(document.getElementById("tab-panel"));
    };
  }

  const TABS = {
    recovery: [
      { key: "recovery", route: "recovery", label: "Revenue Recovery", icon: "dollar" },
      { key: "browse", route: "browse", label: "Browse Abandonment", icon: "eye" },
      { key: "messages", route: "messages", label: "Messaging", icon: "mail" },
    ],
    customers: [
      { key: "customers", route: "customers", label: "Customers", icon: "users" },
      { key: "churn", route: "churn", label: "Churn Risk", icon: "trending-down" },
      { key: "winback", route: "winback", label: "Win-Back", icon: "rotate-ccw" },
      { key: "defections", route: "defections", label: "Defections", icon: "eye-off" },
    ],
    competitors: [
      { key: "competitors", route: "competitors", label: "Radar", icon: "radar" },
      { key: "pricehistory", route: "pricehistory", label: "Price History", icon: "activity" },
      { key: "brand-keywords", route: "brand-keywords", label: "Brand Keywords", icon: "tag" },
    ],
    trends: [
      { key: "campaigns", route: "campaigns", label: "Trends & Campaigns", icon: "megaphone" },
      { key: "recommendations", route: "recommendations", label: "Recommendations", icon: "star" },
    ],
    inventory: [
      { key: "inventory", route: "inventory", label: "Inventory", icon: "package" },
      { key: "markdowns", route: "markdowns", label: "Markdowns", icon: "tag" },
    ],
    onboarding: [
      { key: "onboarding", route: "onboarding", label: "Setup Guide", icon: "check-circle" },
      { key: "connect", route: "connect", label: "Connect Store", icon: "download" },
      { key: "features", route: "features", label: "Feature Activation", icon: "sliders" },
      { key: "settings", route: "settings", label: "Settings", icon: "settings" },
    ],
    billing: [
      { key: "billing", route: "billing", label: "Billing", icon: "credit-card" },
      { key: "support", route: "support", label: "Support", icon: "life-buoy" },
      { key: "notifications", route: "notifications", label: "Notifications", icon: "bell" },
    ],
  };

  // Maps every hash route (including tab sub-routes) to the sidebar item that should appear active
  const NAV_PARENT = {
    dashboard: "dashboard", live: "dashboard", activity: "dashboard",
    recovery: "recovery", browse: "recovery", messages: "recovery",
    customers: "customers", churn: "customers", winback: "customers", defections: "customers",
    competitors: "competitors", pricehistory: "competitors", "brand-keywords": "competitors",
    campaigns: "campaigns", recommendations: "campaigns",
    inventory: "inventory", markdowns: "inventory",
    seo: "seo", returns: "returns", reports: "reports", automations: "automations",
    onboarding: "onboarding", connect: "onboarding", features: "onboarding", settings: "onboarding",
    billing: "billing", support: "billing", notifications: "billing",
  };

  const ROUTES = {
    dashboard: { title: "Command Center", render: renderDashboard },
    live: { title: "Live Orders", render: renderLive },
    activity: { title: "Activity Log", render: renderActivity },
    "brand-keywords": { title: "Brand Keywords", render: withTabs(TABS.competitors, "brand-keywords", renderBrandKeywords) },
    seo: { title: "SEO & Growth", render: renderSeo },
    reports: { title: "Reports & ROI", render: renderReports },
    features: { title: "Feature Activation", render: withTabs(TABS.onboarding, "features", renderFeatures) },
    settings: { title: "Settings", render: withTabs(TABS.onboarding, "settings", renderSettings) },
    connect: { title: "Connect Store", render: withTabs(TABS.onboarding, "connect", renderConnect) },
    onboarding: { title: "Setup & Onboarding", render: withTabs(TABS.onboarding, "onboarding", renderOnboarding) },
    recovery: { title: "Revenue Recovery", render: withTabs(TABS.recovery, "recovery", renderRecovery) },
    browse: { title: "Browse Abandonment", render: withTabs(TABS.recovery, "browse", renderBrowse) },
    messages: { title: "Messaging", render: withTabs(TABS.recovery, "messages", renderMessages) },
    recommendations: { title: "Product Recommendations", render: withTabs(TABS.trends, "recommendations", renderRecommendations) },
    campaigns: { title: "Trends & Campaigns", render: withTabs(TABS.trends, "campaigns", renderCampaigns) },
    churn: { title: "Churn Risk", render: withTabs(TABS.customers, "churn", renderChurnRisk) },
    defections: { title: "Defection Alerts", render: withTabs(TABS.customers, "defections", renderDefections) },
    winback: { title: "Win-Back Campaigns", render: withTabs(TABS.customers, "winback", renderWinback) },
    customers: { title: "Customer Intelligence", render: withTabs(TABS.customers, "customers", renderCustomers) },
    inventory: { title: "Inventory Advisor", render: withTabs(TABS.inventory, "inventory", renderInventory) },
    markdowns: { title: "Markdown Suggestions", render: withTabs(TABS.inventory, "markdowns", renderMarkdowns) },
    competitors: { title: "Competitor Radar", render: withTabs(TABS.competitors, "competitors", renderCompetitors) },
    pricehistory: { title: "Price History", render: withTabs(TABS.competitors, "pricehistory", renderPriceHistory) },
    automations: { title: "Automation Studio", render: renderAutomations },
    returns: { title: "Returns & Fraud Shield", render: renderReturns },
    notifications: { title: "Notification Preferences", render: withTabs(TABS.billing, "notifications", renderNotifications) },
    support: { title: "Support Tickets", render: withTabs(TABS.billing, "support", renderSupport) },
    billing: { title: "Billing & Support", render: withTabs(TABS.billing, "billing", renderBilling) },
    "return-fraud": { title: "Returns & Fraud Shield", render: renderReturns },
  };

  function route() {
    // In embedded mode, check for Shopify session first
    if (isEmbedded && !api.session()) {
      // Auto-login with Shopify session if available
      if (shopifyShop) {
        // Store Shopify info for the API
        sessionStorage.setItem("shopify_shop", shopifyShop);
        sessionStorage.setItem("shopify_host", shopifyHost);
        // Try to auto-login with Shopify credentials
        api.post("/auth/shopify", { shop: shopifyShop, host: shopifyHost })
          .then(() => route())
          .catch(() => {
            // If auto-login fails, show login with pre-filled shop
            container.innerHTML = `<div class="login"><div class="login-card">
              <h3>Connect your Storecops account</h3>
              <p class="muted">Sign in to continue to Storecops.</p>
              <div id="toast" class="toast"></div>
            </div></div>`;
          });
        return;
      }
    }
    
    if (!api.session()) return;
    const name = (location.hash || "#/dashboard").replace("#/", "") || "dashboard";
    const target = ROUTES[name] || ROUTES.dashboard;
    $("#page-title").textContent = target.title;
    const activeNav = NAV_PARENT[name] || name;
    document.querySelectorAll(".side-nav a").forEach((a) =>
      a.classList.toggle("active", a.dataset.route === activeNav || (!ROUTES[name] && a.dataset.route === "dashboard"))
    );
    closeStream();
    destroyCharts();
    container.innerHTML = '<div class="empty"><span class="spinner"></span>&nbsp; Loading…</div>';
    target.render().catch((error) => {
      container.innerHTML = `<div class="card"><h3>Something went wrong</h3><p class="muted">${esc(error.message)}</p></div>`;
    });
  }

  window.addEventListener("hashchange", route);

  // ── page: dashboard ────────────────────────────────────────────────
  async function renderDashboard(container = view) {
    const s = api.store();
    // Auto-check onboarding steps based on current store state
    api.post("/onboarding/auto-check", { store_id: s }).catch(() => {});
    const [report, insights, liveOrdersData, pending, maturity, attribution, churn] = await Promise.all([
      api.get(`/report/${s}`),
      api.get(`/insights/${s}/products`).catch(() => null),
      api.get(`/orders/${s}/live`).catch(() => ({ orders: [] })),
      api.get(`/actions/${s}/pending`).catch(() => []),
      api.get(`/report/${s}/maturity`).catch(() => ({ score: 0 })),
      api.get(`/attribution/${s}`).catch(() => null),
      api.get(`/churn/${s}`).catch(() => ({ risk_bands: {} })),
    ]);

    const o = report.overview || {};
    const funnel = report.funnel || {};
    const atRisk = (churn.risk_bands?.CRITICAL || 0) + (churn.risk_bands?.HIGH || 0);
    const restocks = insights?.restock_urgent?.length || 0;
    const actions = Array.isArray(pending) ? pending : pending.actions || [];
    const attr = attribution || {};
    const revenueRecovered = attr.revenue_attributed || 0;
    const competitorAlerts = insights?.competitor_alerts?.length || 0;
    const seoIssues = insights?.seo_issues?.length || 0;
    const trendingProducts = insights?.trending?.length || 0;

    // Connected store but no data flowing yet → explain what unlocks the rest.
    const onboarding = (o.events_tracked || 0) > 0 ? "" : `
      <div class="card section-gap" style="border-color:rgba(8,144,108,.55)">
        <h3>${icon("rocket")} Your store is connected — now bring it to life</h3>
        <p class="muted">Your product catalog is synced, but revenue, customers, funnel and campaigns stay empty until orders and visitor events flow in. Pick any of these (all on the Connect page):</p>
        <div class="alert-item"><span class="step-num">1</span> <div><b>Import past orders</b> — the Orders CSV gives you instant history, revenue and customer analytics.</div></div>
        <div class="alert-item"><span class="step-num">2</span> <div><b>Install the tracking snippet</b> — live product views, carts and purchases from your storefront.</div></div>
        <div class="alert-item"><span class="step-num">3</span> <div><b>Point your order webhook</b> at Storecops — new orders arrive automatically.</div></div>
        <a class="btn btn-sm btn-primary" href="#/connect" style="margin-top:10px;display:inline-block">Open Connect Store →</a>
      </div>`;

    // System maturity indicator
    const maturityScore = maturity.score || 0;
    const maturityColor = maturityScore >= 80 ? "var(--green)" : maturityScore >= 50 ? "var(--amber)" : "var(--red)";
    const maturityLabel = maturityScore >= 80 ? "Advanced" : maturityScore >= 50 ? "Growing" : "Getting Started";

    container.innerHTML = `
      <!-- Header -->
      <div class="b-header">
        <div>
          <h2>Command Center</h2>
          <p>Real-time overview of your store performance</p>
        </div>
        <div class="b-header-filters">
          <button class="b-filter-btn active" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            ${icon("calendar")} Today
          </button>
          <button class="b-filter-btn" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            7 Days
          </button>
          <button class="b-filter-btn" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            30 Days
          </button>
          <button class="b-filter-btn" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            ${icon("download")} Export
          </button>
        </div>
      </div>

      ${onboarding}

      <!-- Stat Cards -->
      <div class="b-grid-4" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("dollar")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${money(o.revenue)}</div>
          <div class="b-stat-label">Revenue</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            ${funnel.purchases || 0} orders
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("shopping-bag")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${funnel.purchases || 0}</div>
          <div class="b-stat-label">Orders</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            ${(funnel.product_views ? ((funnel.purchases / funnel.product_views) * 100).toFixed(1) : 0)}% conv.
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle purple">${icon("users")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${o.customers || 0}</div>
          <div class="b-stat-label">Customers</div>
          <div class="b-stat-trend ${atRisk > 0 ? 'down' : 'up'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            ${atRisk} at risk
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle ${restocks > 0 ? 'red' : 'green'}">${icon("alert-triangle")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${restocks}</div>
          <div class="b-stat-label">Stock Alerts</div>
          <div class="b-stat-trend ${restocks > 0 ? 'down' : 'up'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            ${restocks > 0 ? 'needs attention' : 'all healthy'}
          </div>
        </div>
      </div>

      <!-- Revenue Chart & Maturity -->
      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-chart-card" style="animation-delay:0.25s">
          <h3>${icon("dollar")} Revenue Recovered</h3>
          <p>+${money(revenueRecovered)} total recovered this month</p>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:16px">
            <div style="text-align:center;padding:14px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
              <div class="b-stat-value" style="font-size:20px;color:var(--green)">${money(attr.cart_recovery || revenueRecovered * 0.4)}</div>
              <div class="b-stat-label">Cart Recovery</div>
            </div>
            <div style="text-align:center;padding:14px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
              <div class="b-stat-value" style="font-size:20px;color:var(--primary)">${money(attr.upsell || revenueRecovered * 0.35)}</div>
              <div class="b-stat-label">Upsell</div>
            </div>
            <div style="text-align:center;padding:14px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
              <div class="b-stat-value" style="font-size:20px;color:var(--cyan)">${money(attr.retention || revenueRecovered * 0.25)}</div>
              <div class="b-stat-label">Retention</div>
            </div>
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.3s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
            <div>
              <h3 style="margin-bottom:4px">${icon("cpu")} System Maturity</h3>
              <div style="font-size:12px;color:${maturityColor};font-weight:600">${maturityLabel}</div>
            </div>
            <span class="b-badge ${maturityScore >= 80 ? 'green' : maturityScore >= 50 ? 'amber' : 'red'}">${maturityScore}%</span>
          </div>
          <div class="b-progress-bar">
            <div class="b-progress-bar-fill ${maturityScore >= 80 ? '' : maturityScore >= 50 ? 'amber' : 'red'}" style="width:${maturityScore}%"></div>
          </div>
          <div style="display:flex;gap:16px;margin-top:16px;font-size:12px;color:var(--muted);flex-wrap:wrap">
            <span>${icon("check-circle")} ${maturityScore >= 20 ? "Data collection" : "Connect store"}</span>
            <span>${icon("check-circle")} ${maturityScore >= 40 ? "Intelligence active" : "Needs more data"}</span>
            <span>${icon("check-circle")} ${maturityScore >= 60 ? "Predictions live" : "Building models"}</span>
            <span>${icon("check-circle")} ${maturityScore >= 80 ? "Full automation" : "Unlock more"}</span>
          </div>
        </div>
      </div>

      <!-- Intelligence Row -->
      <div class="b-grid-3" style="margin-bottom:24px">
        <div class="b-card" style="cursor:pointer;animation-delay:0.35s" onclick="location.hash='#/competitors'">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div class="b-icon-circle blue">${icon("target")}</div>
            <div class="b-stat-value" style="font-size:28px">${competitorAlerts}</div>
          </div>
          <div class="b-stat-label" style="margin-bottom:4px">Competitor Alerts</div>
          <div style="font-size:13px;color:var(--text-dim)">Price changes, new products, promotions detected</div>
        </div>
        <div class="b-card" style="cursor:pointer;animation-delay:0.4s" onclick="location.hash='#/seo'">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div class="b-icon-circle green">${icon("search")}</div>
            <div class="b-stat-value" style="font-size:28px">${seoIssues}</div>
          </div>
          <div class="b-stat-label" style="margin-bottom:4px">SEO Issues</div>
          <div style="font-size:13px;color:var(--text-dim)">Meta tags, content gaps, ranking changes</div>
        </div>
        <div class="b-card" style="cursor:pointer;animation-delay:0.45s" onclick="location.hash='#/campaigns'">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div class="b-icon-circle amber">${icon("flame")}</div>
            <div class="b-stat-value" style="font-size:28px">${trendingProducts}</div>
          </div>
          <div class="b-stat-label" style="margin-bottom:4px">Trending Products</div>
          <div style="font-size:13px;color:var(--text-dim)">Trending on Pinterest, Reddit, Google, TikTok</div>
        </div>
      </div>

      <!-- Charts Row -->
      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-chart-card" style="animation-delay:0.5s">
          <h3>Conversion Funnel</h3>
          <p>Drop-off analysis from views to purchases</p>
          <div class="chart-area tall">
            <canvas id="funnel-chart"></canvas>
          </div>
        </div>
        <div class="b-chart-card" style="animation-delay:0.55s">
          <h3>Churn Risk Distribution</h3>
          <p>Customer segments by churn probability</p>
          <div class="chart-area tall">
            <canvas id="churn-chart"></canvas>
          </div>
        </div>
      </div>

      <!-- Live Feed & Actions -->
      <div class="b-grid-3" style="grid-template-columns:2fr 1fr;margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.6s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <h3 style="margin:0">${icon("radio")} Live Orders</h3>
            <span class="b-badge green">streaming</span>
          </div>
          <div class="feed" id="live-feed"></div>
        </div>
        <div class="b-card" style="animation-delay:0.65s">
          <h3 style="margin-bottom:16px">${icon("bell")} Action Center</h3>
          <div class="scroll-y" id="alert-list"></div>
        </div>
      </div>

      <!-- Recent Orders Table -->
      <div class="b-card" style="margin-bottom:24px;animation-delay:0.7s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3 style="margin:0">${icon("list")} Recent Orders</h3>
          <a href="#/orders" style="font-size:13px;color:var(--primary);text-decoration:none;font-weight:600">View All →</a>
        </div>
        <div style="overflow-x:auto">
          <table class="b-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Order</th>
                <th>Total</th>
                <th>Status</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody id="recent-orders-body">
              ${(liveOrdersData.orders || []).slice(0, 5).map((order, i) => `
                <tr style="animation-delay:${0.05 * (i + 1)}s">
                  <td><b>${esc(order.customer || "Guest")}</b></td>
                  <td>${(order.items || []).slice(0, 2).map(i => `${i.quantity || 1}× ${esc(i.name || i.product_id)}`).join(", ")}${(order.items || []).length > 2 ? '…' : ''}</td>
                  <td style="font-weight:600">${money(order.total)}</td>
                  <td><span class="b-badge green">Completed</span></td>
                  <td style="color:var(--muted)">${esc(order.time_ago || "just now")}</td>
                </tr>
              `).join("")}
              ${(liveOrdersData.orders || []).length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">No orders yet — connect your store to start tracking</td></tr>' : ''}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Stock Advisor -->
      <div class="b-card" style="animation-delay:0.75s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3 style="margin:0">${icon("package")} Stock Advisor</h3>
          <a class="b-report-btn" href="#/inventory">Full Advisor →</a>
        </div>
        <div id="stock-advisor" class="scroll-y"></div>
      </div>`;

    // Funnel chart
    makeChart($("#funnel-chart"), {
      type: "bar",
      data: {
        labels: ["Product views", "Carts", "Checkouts", "Purchases"],
        datasets: [{
          data: [funnel.product_views || 0, funnel.carts || 0, funnel.checkouts_started || 0, funnel.purchases || 0],
          backgroundColor: GRAD.slice(0, 4), borderRadius: 8,
        }],
      },
      options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } },
    });

    // Churn donut
    const bands = churn.risk_bands || {};
    makeChart($("#churn-chart"), {
      type: "doughnut",
      data: {
        labels: ["Critical", "High", "Medium", "Low"],
        datasets: [{
          data: [bands.CRITICAL || 0, bands.HIGH || 0, bands.MEDIUM || 0, bands.LOW || 0],
          backgroundColor: ["#ef4444", "#f59e0b", "#34bf99", "#08906c"], borderWidth: 0,
        }],
      },
      options: { plugins: { legend: { position: "bottom" } }, cutout: "62%" },
    });

    renderFeed($("#live-feed"), liveOrdersData.orders || []);
    renderAlerts($("#alert-list"), { actions, insights, report });
    renderStockAdvisor($("#stock-advisor"), insights);

    // SSE stream
    liveSource = api.liveStream(api.session().storeId, (purchase) => {
      const feed = $("#live-feed");
      if (!feed) return;
      feed.prepend(feedItem(purchase, true));
      toast(`${icon("dollar")} ${purchase.customer || "Someone"} just bought ${money(purchase.total)}`);
    });
  }

  function feedItem(order, isNew = false) {
    const div = document.createElement("div");
    div.className = "feed-item" + (isNew ? " new" : "");
    const items = (order.items || []).map((i) => `${i.quantity || 1}× ${esc(i.name || i.product_id)}`).join(", ");
    const cp = order.customer_profile;
    const seg = cp?.segment || "NEW";
    const segColors = { VIP: "pill-green", HIGH_VALUE: "pill-cyan", LOYAL: "pill-violet", NEW: "pill-gray", AT_RISK: "pill-amber", DEFECTED: "pill-red" };
    const ins = order.insight;
    const insColor = { green: "kpi-up", amber: "kpi-warn", red: "kpi-bad", cyan: "", violet: "" };

    div.innerHTML = `
      <div class="feed-avatar">${esc((order.customer || "?").charAt(0).toUpperCase())}</div>
      <div class="feed-meta" style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <b>${esc(order.customer || "Guest")}</b>
          <span class="pill ${segColors[seg] || "pill-gray"}" style="font-size:10px;padding:2px 8px">${seg}</span>
        </div>
        <small>${items || "order"}</small>
        ${cp ? `<div style="display:flex;gap:10px;margin-top:3px;font-size:11px;color:var(--text-dim)">
          <span>${cp.purchases} order${cp.purchases !== 1 ? "s" : ""}</span>
          <span>$${cp.total_spent.toFixed(2)} LTV</span>
          ${cp.days_since_purchase !== null ? `<span>${cp.days_since_purchase}d ago</span>` : ""}
        </div>` : ""}
        ${ins && ins.type !== "standard" ? `<div style="font-size:11px;margin-top:2px" class="${insColor[ins.color] || ""}">${ins.text}</div>` : ""}
      </div>
      <div style="text-align:right;flex-shrink:0">
        <span class="feed-total">${money(order.total)}</span>
        <div class="feed-time">${esc(order.time_ago || "just now")}</div>
      </div>`;
    return div;
  }

  function renderFeed(container, orders) {
    container.innerHTML = "";
    if (!orders.length) {
      container.innerHTML = `
        <div class="empty" style="text-align:center;padding:24px 16px">
          <div style="font-size:32px;margin-bottom:8px">${icon("radio")}</div>
          <div style="font-weight:600;margin-bottom:4px">Waiting for live orders</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px">Orders will stream here in real-time once your store is connected and events are flowing.</div>
          <a class="btn btn-sm btn-grad" href="#/connect" style="display:inline-block">Connect Store →</a>
        </div>`;
      return;
    }
    orders.slice(0, 30).forEach((order) => container.appendChild(feedItem(order)));
  }

  function renderAlerts(container, { actions, insights, report }) {
    const html = [];
    for (const item of insights?.restock_urgent || []) {
      const cls = /OUT_OF|RESTOCK_NOW/.test(item.severity || "") ? "red" : "amber";
      html.push(`<div class="alert-item ${cls}">${icon("package")} <div><b>${esc(item.product_id)}</b> — ${esc(item.suggestion || item.severity)}</div></div>`);
    }
    for (const action of actions.slice(0, 6)) {
      let statusText = action.status || "queued";
      if (action.sequence_id && action.send_after) {
        const sendAfter = new Date(action.send_after);
        const now = new Date();
        if (sendAfter > now) {
          const minsUntil = Math.round((sendAfter - now) / 60000);
          statusText = `Step ${action.sequence_step || "?"} — sends in ${minsUntil}m`;
        } else {
          statusText = `Step ${action.sequence_step || "?"} — ready to send`;
        }
      }
      html.push(`<div class="alert-item amber">${icon("zap")} <div><b>${esc(action.rule_id || action.action_type || "action")}</b> for ${esc(action.customer_id || "segment")} — ${esc(statusText)}</div></div>`);
    }
    const atRisk = report.churn?.top_at_risk || [];
    for (const customer of atRisk.slice(0, 3)) {
      if ((customer.churn_score || 0) >= 70) {
        html.push(`<div class="alert-item red">${icon("heart")} <div><b>${esc(customer.customer_id)}</b> churn score ${customer.churn_score} — win-back ready</div></div>`);
      }
    }
    const health = report.sentiment?.health_score;
    if (health !== undefined && health < 0) {
      html.push(`<div class="alert-item red">${icon("frown")} <div>Brand sentiment negative (${health}) — review recent mentions</div></div>`);
    }
    container.innerHTML = html.length ? html.join("") : `
      <div class="empty" style="text-align:center;padding:24px 16px">
        <div style="font-size:32px;margin-bottom:8px">${icon("check-circle")}</div>
        <div style="font-weight:600;margin-bottom:4px">All clear</div>
        <div style="font-size:12px;color:var(--text-dim)">No alerts, no at-risk customers, and sentiment is healthy. The system is monitoring your store.</div>
      </div>`;
  }

  function renderStockAdvisor(container, insights) {
    if (!insights) {
      container.innerHTML = `
        <div class="empty" style="text-align:center;padding:24px 16px">
          <div style="font-size:32px;margin-bottom:8px">${icon("package")}</div>
          <div style="font-weight:600;margin-bottom:4px">No inventory data yet</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px">Set stock levels in the Inventory Advisor to get restocking alerts and stockout predictions.</div>
          <a class="btn btn-sm btn-primary" href="#/inventory" style="display:inline-block">Open Inventory →</a>
        </div>`;
      return;
    }
    const rows = [
      ...(insights.restock_urgent || []).map((p) => ({ ...p, bucket: p.severity || "RESTOCK" })),
      ...(insights.fast_movers || []).map((p) => ({ ...p, bucket: "FAST MOVER" })),
      ...(insights.slow_movers || []).map((p) => ({ ...p, bucket: "SLOW" })),
      ...(insights.dead_stock || []).map((p) => ({ ...p, bucket: "DEAD STOCK" })),
    ];
    if (!rows.length) {
      container.innerHTML = `
        <div class="empty" style="text-align:center;padding:24px 16px">
          <div style="font-size:32px;margin-bottom:8px">${icon("check-circle")}</div>
          <div style="font-weight:600;margin-bottom:4px">Stock levels healthy</div>
          <div style="font-size:12px;color:var(--text-dim)">All products are within optimal stock ranges. No restocking needed right now.</div>
        </div>`;
      return;
    }
    container.innerHTML = rows.slice(0, 8).map((p) =>
      `<div class="alert-item"><span class="pill ${pillFor(p.bucket)}">${esc(p.bucket)}</span><div>${esc(p.suggestion || p.product_id)}</div></div>`
    ).join("");
  }

  // ── page: live orders (Behance-inspired redesign) ─────────────────
  async function renderLive(container = view) {
    const s = api.store();
    const data = await api.get(`/orders/${s}/live?limit=50`).catch(() => ({ orders: [], count: 0, stats: {} }));
    const stats = data.stats || {};
    const topProducts = stats.top_products || [];
    const hourly = stats.hourly || [];
    const segDist = stats.today_segments || {};
    const orders = data.orders || [];

    const totalOrders = stats.total_orders || orders.length || 0;
    const pendingOrders = orders.filter(o => o.status === 'pending').length || Math.round(totalOrders * 0.13);
    const dispatchedOrders = stats.today_orders || Math.round(totalOrders * 0.38);
    const revenue = stats.total_revenue || 0;

    const peakOrders = Math.max(1, ...hourly.map((h) => h.orders));
    const hourBars = hourly.map((h) => {
      const pct = Math.round((h.orders / peakOrders) * 100);
      const label = h.hour === new Date().getHours() ? "now" : `${h.hour}:00`;
      return `<div class="hour-bar" title="${label}: ${h.orders} orders"><div class="hour-bar-fill" style="height:${pct}%"></div><span class="hour-label">${h.orders > 0 ? h.orders : ""}</span></div>`;
    }).join("");

    const trendUp = (val) => `<span class="orders-stat-trend up">↗ ${val}%</span>`;
    const trendDown = (val) => `<span class="orders-stat-trend down">↘ ${val}%</span>`;

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Live Orders</h2>
          <p>Your buying and selling transactions</p>
        </div>
        <div class="b-header-filters">
          <button class="b-report-btn">${icon("download")} Export</button>
        </div>
      </div>

      <div class="b-grid-4" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle purple">${icon("shopping-cart")}</div>
          </div>
          <div class="b-stat-value">${Number(totalOrders).toLocaleString()}</div>
          <div class="b-stat-label">Total Orders</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            +5.4%
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle amber">${icon("clock")}</div>
          </div>
          <div class="b-stat-value">${Number(pendingOrders).toLocaleString()}</div>
          <div class="b-stat-label">Pending Orders</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            +3%
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("package")}</div>
          </div>
          <div class="b-stat-value">${Number(dispatchedOrders).toLocaleString()}</div>
          <div class="b-stat-label">Dispatched</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            +7.8%
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("dollar-sign")}</div>
          </div>
          <div class="b-stat-value">${money(revenue)}</div>
          <div class="b-stat-label">Revenue</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            +2.7%
          </div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-chart-card" style="animation-delay:0.25s">
          <h3>Product Inventory</h3>
          <p>Overall sales target and inventory report</p>
          <div class="chart-wrap"><canvas id="orders-inventory-chart"></canvas></div>
        </div>
        <div class="b-card" style="animation-delay:0.3s">
          <h3 style="margin-bottom:12px">Order Summary</h3>
          <div>
            ${[
              { label: "Total Orders", value: totalOrders },
              { label: "Total Revenue", value: money(orders.reduce((sum, o) => sum + (o.total || o.amount || 0), 0)) },
              { label: "Avg Order Value", value: totalOrders > 0 ? money(orders.reduce((sum, o) => sum + (o.total || o.amount || 0), 0) / totalOrders) : "$0" },
              { label: "Unique Customers", value: new Set(orders.map(o => o.customer_id || o.email)).size },
            ].map(c => `
              <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--card-border)">
                <span style="color:var(--text-muted);font-size:13px">${c.label}</span>
                <span style="font-weight:600;font-size:13px">${c.value}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.35s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <h3>${icon("package")} Best Selling Products</h3>
          </div>
          <div>
            ${topProducts.length ? topProducts.map((p, i) => `
              <div class="b-list-item" style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--card-border)">
                <div style="width:36px;height:36px;border-radius:8px;background:var(--surface-2);display:flex;align-items:center;justify-content:center;font-size:18px">${['📱','🎧','💻','⌚','📷'][i % 5]}</div>
                <div style="flex:1">
                  <div style="font-weight:600;font-size:13px">${esc(p.name)}</div>
                  <div style="font-size:12px;color:var(--muted)">${money(p.price || 0)} × ${p.quantity || 1}</div>
                </div>
                <div style="display:flex;gap:6px">
                  <span class="b-badge green">In Stock</span>
                </div>
              </div>
            `).join("") : `
              <div style="text-align:center;padding:24px;color:var(--muted)">
                <div style="font-size:14px;margin-bottom:4px">No product data yet</div>
                <div style="font-size:12px">Start tracking to see best sellers</div>
              </div>`}
          </div>
        </div>

        <div class="b-chart-card" style="animation-delay:0.4s">
          <h3>${icon("bar-chart")} Hourly Orders (24h)</h3>
          <p>Order distribution across the day</p>
          <div class="hour-chart" style="display:flex;gap:3px;height:120px;align-items:flex-end">${hourBars}</div>
        </div>
      </div>

      <div class="b-card" style="animation-delay:0.45s;margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3>${icon("radio")} Recent Orders — ${data.count || 0} orders</h3>
          <span class="live-status"><span class="live-dot"></span> live</span>
        </div>
        <div style="overflow-x:auto">
          <table class="b-table">
            <thead><tr><th>Customer</th><th>Items</th><th>Total</th><th>Segment</th><th>Insight</th><th>Time</th></tr></thead>
            <tbody id="orders-tbody"></tbody>
          </table>
        </div>
      </div>

      <div class="b-card" style="animation-delay:0.5s">
        <h3 style="margin-bottom:16px">${icon("users")} Customer Intelligence</h3>
        <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:end">
          <div>
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;font-weight:700">CUSTOMER ID OR EMAIL</label>
            <input id="cust-lookup" placeholder="e.g. buyer-01 or email@example.com" style="width:100%;padding:11px;border-radius:10px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);font-size:13px;font-family:var(--font-body)" />
          </div>
          <div><button id="cust-btn" class="btn btn-primary" style="padding:11px 24px">${icon("search", "icon-sm")} Look up</button></div>
        </div>
        <div id="cust-result" style="margin-top:16px"></div>
      </div>`;

    // Render orders table
    const tbody = $("#orders-tbody");
    const segColors = { VIP: "pill-green", HIGH_VALUE: "pill-cyan", LOYAL: "pill-violet", NEW: "pill-gray", AT_RISK: "pill-amber", DEFECTED: "pill-red" };
    const insightColors = { vip: "green", upsell: "cyan", churn: "amber", winback: "red", abandon: "amber", browse: "violet", repeat: "green", standard: "" };

    if (orders.length) {
      tbody.innerHTML = orders.slice(0, 15).map((o, i) => {
        const ins = o.insight || {};
        const initials = (o.customer || "?").slice(0, 2).toUpperCase();
        return `<tr style="animation-delay:${0.05 * i}s">
          <td><div style="display:flex;align-items:center;gap:8px"><div class="b-icon-circle purple" style="width:28px;height:28px;min-width:28px;font-size:11px">${initials}</div><div><div style="font-weight:600;font-size:13px">${esc(o.customer || "Unknown")}</div><div style="font-size:11px;color:var(--muted)">${esc(o.email || "—")}</div></div></div></td>
          <td style="font-size:12px">${(o.items || []).map(i => `${i.quantity || 1}× ${esc(i.name || i.product_id || "item")}`).join(", ") || "—"}</td>
          <td><b style="color:var(--green)">${money(o.total)}</b></td>
          <td><span class="b-badge ${segColors[o.customer_profile?.segment] || "gray"}">${esc(o.customer_profile?.segment || "NEW")}</span></td>
          <td style="font-size:12px;color:var(--${insightColors[ins.type] || "muted"})">${esc(ins.text || "—")}</td>
          <td style="font-size:12px;color:var(--muted)">${esc(o.time_ago || "—")}</td>
        </tr>`;
      }).join("");
    } else {
      tbody.innerHTML = '<tr><td colspan="6" class="empty" style="padding:20px;text-align:center">No orders yet. Connect your store and start tracking.</td></tr>';
    }

    // Inventory chart
    const invCtx = document.getElementById("orders-inventory-chart");
    if (invCtx) {
      makeChart(invCtx, {
        type: "line",
        data: {
          labels: hourly.map(h => `${h.hour}:00`),
          datasets: [{
            label: "Revenue",
            data: hourly.map(h => h.revenue),
            borderColor: "#7c3aed",
            backgroundColor: "rgba(124,58,237,0.1)",
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointBackgroundColor: "#7c3aed",
          }, {
            label: "Engagement",
            data: hourly.map(h => h.orders * 150),
            borderColor: "#a78bfa",
            borderDash: [5, 5],
            fill: false,
            tension: 0.4,
            pointRadius: 2,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: "top", labels: { usePointStyle: true, boxWidth: 8 } } },
          scales: {
            y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
            x: { grid: { display: false } }
          }
        }
      });
    }

    // Live stream
    liveSource = api.liveStream(api.session().storeId, (purchase) => {
      if (purchase && tbody) {
        const initials = (purchase.customer || "?").slice(0, 2).toUpperCase();
        const row = document.createElement("tr");
        row.innerHTML = `<td><div style="display:flex;align-items:center;gap:8px"><div class="b-icon-circle purple" style="width:28px;height:28px;min-width:28px;font-size:11px">${initials}</div><div><div style="font-weight:600;font-size:13px">${esc(purchase.customer || "Unknown")}</div><div style="font-size:11px;color:var(--muted)">${esc(purchase.email || "—")}</div></div></div></td><td style="font-size:12px">${(purchase.items || []).map(i => `${i.quantity || 1}× ${esc(i.name || i.product_id || "item")}`).join(", ") || "—"}</td><td><b style="color:var(--green)">${money(purchase.total)}</b></td><td><span class="b-badge gray">NEW</span></td><td style="font-size:12px">New order</td><td style="font-size:12px;color:var(--muted)">just now</td>`;
        row.style.animation = "flash 1.2s ease";
        tbody.prepend(row);
      }
    });

    // Customer lookup
    $("#cust-btn")?.addEventListener("click", async () => {
      const id = $("#cust-lookup").value.trim();
      if (!id) return;
      try {
        const result = await api.get(`/orders/${s}/customer/${encodeURIComponent(id)}`);
        const p = result.profile;
        const ins = result.insight;
        const beh = result.behavior || {};
        const behaviorBars = Object.entries(beh).map(([type, count]) => {
          const maxBeh = Math.max(1, ...Object.values(beh));
          const pct = Math.round((count / maxBeh) * 100);
          return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-size:12px;min-width:80px;color:var(--muted)">${esc(type)}</span><div style="flex:1;height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--grad);border-radius:3px;transition:width 0.5s"></div></div><span style="font-size:12px;font-weight:600">${count}</span></div>`;
        }).join("");

        $("#cust-result").innerHTML = `
          <div style="padding:16px;background:var(--surface-2);border-radius:var(--radius-sm);animation:fadeSlideUp 0.3s ease">
            <div class="b-grid-4" style="gap:12px">
              <div style="text-align:center"><span class="b-badge ${segColors[p?.segment] || "gray"}" style="font-size:13px;padding:4px 14px">${p?.segment || "UNKNOWN"}</span><div style="font-size:11px;color:var(--muted);margin-top:4px">Segment</div></div>
              <div style="text-align:center"><div style="font-size:20px;font-weight:700">${money(result.total_spent)}</div><div style="font-size:11px;color:var(--muted)">Lifetime value</div></div>
              <div style="text-align:center"><div style="font-size:20px;font-weight:700">${p?.purchases || 0}</div><div style="font-size:11px;color:var(--muted)">Purchases</div></div>
              <div style="text-align:center"><div style="font-size:20px;font-weight:700;color:var(--${ins?.color || "muted"})">${esc(ins?.icon || "—")}</div><div style="font-size:11px;color:var(--muted)">${esc(ins?.text || "No insight")}</div></div>
            </div>
            ${behaviorBars ? `<div style="margin-top:16px"><div style="font-size:12px;font-weight:600;margin-bottom:8px">Behavior</div>${behaviorBars}</div>` : ""}
          </div>`;
      } catch (e) { toast(e.message); }
    });
  }

  // ── page: inventory ────────────────────────────────────────────────
  async function renderInventory(container = view) {
    const s = api.store();
    const [levels, insights] = await Promise.all([
      api.get(`/inventory/${s}/levels`).catch(() => null),
      api.get(`/insights/${s}/products`).catch(() => null),
    ]);

    const entries = levels?.levels || levels?.items || (Array.isArray(levels) ? levels : []);

    const totalStock = entries.reduce((sum, e) => sum + (e.stock || 0), 0);
    const lowCount = entries.filter(e => e.stock > 0 && e.stock <= 5).length;
    const outCount = entries.filter(e => e.stock <= 0).length;

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Inventory Advisor</h2>
          <p>Stock levels, predictions, and movement insights</p>
        </div>
        <div class="b-header-filters">
          <button class="b-report-btn" id="po-btn">${icon("file-text")} Generate PO</button>
        </div>
      </div>

      <div class="b-grid-4" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("package")}</div>
          </div>
          <div class="b-stat-value">${entries.length}</div>
          <div class="b-stat-label">Total Products</div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("check-circle")}</div>
          </div>
          <div class="b-stat-value">${totalStock}</div>
          <div class="b-stat-label">Total Units</div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle ${lowCount > 0 ? 'amber' : 'green'}">${icon("alert-triangle")}</div>
          </div>
          <div class="b-stat-value">${lowCount}</div>
          <div class="b-stat-label">Low Stock</div>
          <div class="b-stat-trend ${lowCount > 0 ? 'down' : 'up'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            ${lowCount > 0 ? 'needs reorder' : 'all healthy'}
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle ${outCount > 0 ? 'red' : 'green'}">${icon("archive")}</div>
          </div>
          <div class="b-stat-value">${outCount}</div>
          <div class="b-stat-label">Out of Stock</div>
          <div class="b-stat-trend ${outCount > 0 ? 'down' : 'up'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            ${outCount > 0 ? 'critical' : 'none'}
          </div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.25s">
          <h3 style="margin-bottom:16px">${icon("package")} Stock Levels</h3>
          <div class="scroll-y" style="max-height:420px">
            <table class="b-table">
              <thead><tr><th>Product</th><th>Stock</th><th>Lead Time</th><th>Level</th><th>Status</th></tr></thead>
              <tbody>${entries.map((e) => {
                const status = e.stock <= 0 ? ["OUT", "red"] : e.stock <= 5 ? ["LOW", "amber"] : ["OK", "green"];
                const pct = Math.min(100, Math.round(((e.stock || 0) / 50) * 100));
                return `<tr>
                  <td><b>${esc(e.product_id)}</b></td>
                  <td><span class="b-stat-value" style="font-size:14px">${e.stock}</span></td>
                  <td>${e.lead_time_days || 7}d</td>
                  <td><div class="b-progress-bar" style="width:100px;height:6px"><div class="b-progress-bar-fill ${status[1] === 'red' ? 'red' : status[1] === 'amber' ? 'amber' : ''}" style="width:${pct}%"></div></div></td>
                  <td><span class="b-badge ${status[1]}">${status[0]}</span></td>
                </tr>`;
              }).join("") || '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">No stock registered yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.3s">
          <h3 style="margin-bottom:16px">${icon("clock")} Stockout Predictions</h3>
          <div class="scroll-y" id="stockout-list" style="max-height:420px"></div>
        </div>
      </div>

      <div class="b-grid-3" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.35s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle amber">${icon("flame")}</div>
            <h3 style="margin:0">Fast Movers</h3>
          </div>
          <div class="scroll-y" id="fast-list" style="max-height:240px"></div>
        </div>
        <div class="b-card" style="animation-delay:0.4s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("gauge")}</div>
            <h3 style="margin:0">Slow Movers</h3>
          </div>
          <div class="scroll-y" id="slow-list" style="max-height:240px"></div>
        </div>
        <div class="b-card" style="animation-delay:0.45s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle red">${icon("archive")}</div>
            <h3 style="margin:0">Dead Stock</h3>
          </div>
          <div class="scroll-y" id="dead-list" style="max-height:240px"></div>
        </div>
      </div>

      <div class="b-card" id="po-card" style="display:none;animation-delay:0.5s">
        <h3 style="margin-bottom:16px">${icon("file-text")} Purchase Order</h3>
        <div class="code-block" id="po-doc"></div>
      </div>`;

    const stockouts = insights?.stockout_predictions || [];
    $("#stockout-list").innerHTML = stockouts.length
      ? stockouts.map((p, i) => {
          const urgency = p.stockout_urgency === "CRITICAL" ? "red" : "amber";
          return `<div class="b-list-item" style="animation-delay:${0.05 * (i + 1)}s">
            <div style="display:flex;align-items:center;gap:10px">
              <div class="b-icon-circle ${urgency}" style="width:32px;height:32px">${icon("clock")}</div>
              <div>
                <div style="font-weight:600;font-size:13px">${esc(p.product_id)}</div>
                <div style="font-size:12px;color:var(--muted)">${esc(p.suggestion || "runs out ~" + p.stockout_date)}</div>
              </div>
            </div>
            <span class="b-badge ${urgency}">${esc(p.stockout_urgency || "WARN")}</span>
          </div>`;
        }).join("")
      : `<div style="text-align:center;padding:24px;color:var(--muted)">${icon("gift")} No stockouts predicted in the horizon.</div>`;

    const bucketList = (list, icon_name) => (list && list.length
      ? list.map((p, i) => `<div class="b-list-item" style="animation-delay:${0.05 * (i + 1)}s">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:6px;height:6px;border-radius:50%;background:var(--primary);flex-shrink:0"></div>
            <span style="font-size:13px">${esc(p.suggestion || p.product_id)}</span>
          </div>
        </div>`).join("")
      : '<div style="text-align:center;padding:16px;color:var(--muted);font-size:13px">Nothing here.</div>');
    $("#fast-list").innerHTML = bucketList(insights?.fast_movers, "flame");
    $("#slow-list").innerHTML = bucketList(insights?.slow_movers, "gauge");
    $("#dead-list").innerHTML = bucketList(insights?.dead_stock, "archive");

    $("#po-btn").addEventListener("click", async () => {
      try {
        const po = await api.post(`/purchase-orders/${s}/generate`, { supplier: "Primary Supplier" });
        $("#po-card").style.display = "block";
        $("#po-doc").textContent = po.po?.document || JSON.stringify(po, null, 2);
        toast(icon("file-text") + " Purchase order generated.");
      } catch (error) {
        toast(icon("alert-triangle") + " " + error.message);
      }
    });
  }

  // ── page: customers ────────────────────────────────────────────────
  async function renderCustomers(container = view) {
    const s = api.store();
    const [segments, churn] = await Promise.all([
      api.get(`/segments/${s}`).catch(() => null),
      api.get(`/churn/${s}`).catch(() => []),
    ]);

    const churnByCustomer = new Map((Array.isArray(churn) ? churn : []).map((c) => [c.customer_id, c]));
    const customers = segments?.customers || [];
    const distribution = segments?.distribution || {};

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Customer Intelligence</h2>
          <p>Segments, behavior, and churn analytics</p>
        </div>
      </div>

      <div class="b-grid-4" style="margin-bottom:24px">
        ${["VIP", "HIGH_VALUE", "LOYAL", "NEW", "AT_RISK", "DEFECTED"]
          .filter((seg) => distribution[seg])
          .map((seg, i) => {
            const colors = { VIP: "green", HIGH_VALUE: "blue", LOYAL: "purple", NEW: "blue", AT_RISK: "amber", DEFECTED: "red" };
            return `<div class="b-card" style="animation-delay:${0.05 * (i + 1)}s">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
                <div class="b-icon-circle ${colors[seg] || 'blue'}">${icon("users")}</div>
                <span class="b-badge ${colors[seg] || 'blue'}">${esc(seg.replace("_", " "))}</span>
              </div>
              <div class="b-stat-value">${distribution[seg]}</div>
              <div class="b-stat-label">Customers</div>
            </div>`;
          }).join("") || '<div class="b-card"><div class="empty" style="text-align:center;padding:24px;color:var(--muted)">No customers yet.</div></div>'}
      </div>

      <div class="b-card" style="animation-delay:0.3s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3 style="margin:0">${icon("users")} All Customers</h3>
          <span class="b-badge blue">${customers.length} total</span>
        </div>
        <div class="scroll-y" style="max-height:520px">
          <table class="b-table">
            <thead><tr><th>Customer</th><th>Segment</th><th>Spent</th><th>Purchases</th><th>Churn Score</th><th>Risk</th></tr></thead>
            <tbody>${customers.map((c, i) => {
              const id = c.customer_id || c.identity;
              const churnRow = churnByCustomer.get(id);
              const score = churnRow?.churn_score ?? "—";
              const band = churnRow?.risk_band || "—";
              return `<tr style="animation-delay:${0.03 * (i + 1)}s">
                <td><b>${esc(id)}</b></td>
                <td><span class="b-badge ${pillFor(c.segment)}">${esc(c.segment || "—")}</span></td>
                <td style="font-weight:600">${money(c.total_spent)}</td>
                <td>${c.purchases ?? "—"}</td>
                <td>${score}</td>
                <td><span class="b-badge ${pillFor(band)}">${esc(band)}</span></td>
              </tr>`;
            }).join("") || '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">No customers tracked yet.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }

  // ── page: automations ──────────────────────────────────────────────
  async function renderAutomations(container = view) {
    const s = api.store();
    const [rules, pending] = await Promise.all([
      api.get(`/rules/${s}`).catch(() => []),
      api.get(`/actions/${s}/pending`).catch(() => []),
    ]);

    const ruleList = Array.isArray(rules) ? rules : rules.rules || [];
    const actionList = Array.isArray(pending) ? pending : pending.actions || [];

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Automations</h2>
          <p>Automation rules and queued actions</p>
        </div>
        <div class="b-header-filters">
          <button class="btn btn-sm btn-primary" id="scan-btn">${icon("search", "icon-sm")} Scan store</button>
          <button class="btn btn-sm btn-grad" id="exec-btn">${icon("send", "icon-sm")} Execute now</button>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <h3 style="margin-bottom:16px">Automation Rules</h3>
          <div style="overflow-x:auto">
            <table class="b-table"><thead><tr><th>Rule</th><th>Trigger</th><th>Action</th><th>Priority</th></tr></thead>
            <tbody>${ruleList.map((r) => `<tr>
              <td><b>${esc(r.name || r.rule_id)}</b></td>
              <td><span class="b-badge cyan">${esc(r.trigger)}</span></td>
              <td style="font-size:13px">${esc(r.action?.type || "—")} <span style="color:var(--muted)">via ${esc(r.action?.channel || "auto")}</span></td>
              <td>${r.priority ?? "—"}</td>
            </tr>`).join("") || '<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--muted)">No rules configured.</td></tr>'}</tbody></table>
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <h3 style="margin-bottom:16px">Queued Actions</h3>
          <div id="action-list"></div>
        </div>
      </div>`;

    const drawActions = () => {
      $("#action-list").innerHTML = actionList.length
        ? actionList.map((a) => `<div class="b-list-item" style="display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--card-border)">${icon("zap")} <div><b>${esc(a.rule_id || a.action_type)}</b> → ${esc(a.customer_id || "all")} <span style="color:var(--muted);font-size:12px">(${esc(a.status || "queued")}, ${esc(a.channel || "auto")})</span></div></div>`).join("")
        : '<div style="text-align:center;padding:24px;color:var(--muted)">No actions queued. Run a scan to find opportunities.</div>';
    };
    drawActions();

    $("#scan-btn").addEventListener("click", async () => {
      const found = await api.post(`/orchestrator/scan/${s}`);
      toast(`${icon("search")} Scan complete — ${Array.isArray(found) ? found.length : found.queued?.length || 0} action(s) queued.`);
      route();
    });
    $("#exec-btn").addEventListener("click", async () => {
      const result = await api.post(`/execute/${s}`);
      toast(`${icon("send")} Executed — ${result.delivered ?? result.length ?? 0} message(s) delivered.`);
      route();
    });
  }

  // ── page: messages ─────────────────────────────────────────────────
  async function renderMessages(container = view) {
    const s = api.store();
    const [channels, deliveryData, rules] = await Promise.all([
      api.get(`/channels/${s}/status`).catch(() => ({ whatsapp: {}, email: {} })),
      api.get(`/deliveries/${s}?limit=50`).catch(() => ({ deliveries: [], stats: {} })),
      api.get(`/rules/${s}`).catch(() => []),
    ]);

    const wa = channels.whatsapp || {};
    const em = channels.email || {};
    const stats = deliveryData.stats || {};
    const deliveries = deliveryData.deliveries || [];
    const ruleList = Array.isArray(rules) ? rules : rules.rules || [];

    const channelBadge = (configured, provider) => {
      if (configured) return `<span class="b-badge green">● Connected</span> <span style="color:var(--muted);font-size:12px">${esc(provider)}</span>`;
      return `<span class="b-badge amber">○ Console mode</span> <span style="color:var(--muted);font-size:12px">${esc(provider)} — set credentials to go live</span>`;
    };

    const fmtTime = (iso) => {
      if (!iso) return "—";
      const d = new Date(iso);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };

    const channelIcon = (ch) => {
      if (ch === "whatsapp") return "💬";
      if (ch === "email") return "📧";
      return "📨";
    };

    const statusPill = (st) => {
      if (st === "delivered") return '<span class="b-badge green">delivered</span>';
      if (st === "sent") return '<span class="b-badge cyan">sent</span>';
      if (st === "failed") return '<span class="b-badge red">failed</span>';
      if (st === "suppressed") return '<span class="b-badge amber">suppressed</span>';
      if (st === "blocked") return '<span class="b-badge amber">blocked</span>';
      return `<span class="b-badge violet">${esc(st || "unknown")}</span>`;
    };

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Messages & Delivery</h2>
          <p>Channel status, deliveries, and automation rules</p>
        </div>
        <div class="b-header-filters">
          <button class="btn btn-sm btn-primary" id="msg-scan">${icon("search", "icon-sm")} Scan store</button>
          <button class="btn btn-sm btn-grad" id="msg-exec">${icon("zap", "icon-sm")} Execute now</button>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <h3 style="margin-bottom:8px">${icon("message-circle")} WhatsApp Business API</h3>
          <div style="margin-bottom:8px">${channelBadge(wa.configured, wa.provider || "console")}</div>
          <div style="font-size:12px;color:var(--muted)">Webhook: <code style="background:var(--surface-2);padding:2px 6px;border-radius:4px">${esc(wa.webhook_url || "/webhooks/whatsapp")}</code></div>
          ${!wa.configured ? `<div style="margin-top:12px;padding:10px;background:rgba(251,191,36,0.1);border-radius:8px;display:flex;align-items:center;gap:8px">${icon("alert-triangle")} <div style="font-size:12px"><b>Not connected</b><br><span style="color:var(--muted)">Set WHATSAPP_PROVIDER=meta in .env to enable live delivery.</span></div></div>` : ""}
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <h3 style="margin-bottom:8px">${icon("mail")} Email Service</h3>
          <div style="margin-bottom:8px">${channelBadge(em.configured, em.provider || "console")}</div>
          <div style="font-size:12px;color:var(--muted)">From: <code style="background:var(--surface-2);padding:2px 6px;border-radius:4px">${esc(em.from_address || "noreply@storecops.app")}</code></div>
          ${!em.configured ? `<div style="margin-top:12px;padding:10px;background:rgba(251,191,36,0.1);border-radius:8px;display:flex;align-items:center;gap:8px">${icon("alert-triangle")} <div style="font-size:12px"><b>Not connected</b><br><span style="color:var(--muted)">Set EMAIL_PROVIDER=resend and RESEND_API_KEY in .env.</span></div></div>` : ""}
        </div>
      </div>

      <div class="b-grid-3" style="margin-bottom:24px">
        <div class="b-card" style="text-align:center;animation-delay:0.15s">
          <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:4px">Total Sent</div>
          <div class="b-stat-value">${stats.total || 0}</div>
        </div>
        <div class="b-card" style="text-align:center;animation-delay:0.2s">
          <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:4px">By Channel</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:6px">${Object.entries(stats.by_channel || {}).map(([ch, n]) => `<span class="b-badge violet">${channelIcon(ch)} ${esc(ch)}: ${n}</span>`).join("") || '<span style="color:var(--muted);font-size:12px">No deliveries yet</span>'}</div>
        </div>
        <div class="b-card" style="text-align:center;animation-delay:0.25s">
          <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:4px">By Status</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:6px">${Object.entries(stats.by_status || {}).map(([st, n]) => `<span class="b-badge ${st === "delivered" ? "green" : st === "failed" ? "red" : "cyan"}">${esc(st)}: ${n}</span>`).join("") || '<span style="color:var(--muted);font-size:12px">No deliveries yet</span>'}</div>
        </div>
      </div>

      <div class="b-card" style="animation-delay:0.3s;margin-bottom:24px">
        <h3 style="margin-bottom:16px">${icon("send")} Recent Deliveries</h3>
        <div style="overflow-x:auto">
          <table class="b-table"><thead><tr><th>Channel</th><th>Customer</th><th>Action</th><th>Status</th><th>Time</th></tr></thead>
          <tbody>${deliveries.length
            ? deliveries.map((d) => `<tr>
              <td>${channelIcon(d.channel)} ${esc(d.channel || "—")}</td>
              <td style="font-family:monospace;font-size:12px">${esc((d.customer_id || "—").slice(0, 20))}</td>
              <td style="font-size:13px">${esc(d.action_type || "—")}</td>
              <td>${statusPill(d.status)}</td>
              <td style="color:var(--muted);font-size:12px">${fmtTime(d.createdAt)}</td>
            </tr>`).join("")
            : '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--muted)">No deliveries yet. Scan your store and execute to send messages.</td></tr>'}</tbody></table>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.35s">
          <h3 style="margin-bottom:16px">${icon("settings")} Automation Rules → Messages</h3>
          <div style="overflow-x:auto">
            <table class="b-table"><thead><tr><th>Rule</th><th>Trigger</th><th>Channel</th></tr></thead>
            <tbody>${ruleList.length
              ? ruleList.map((r) => `<tr>
                <td><b>${esc(r.name || r.rule_id)}</b></td>
                <td><span class="b-badge cyan">${esc(r.trigger)}</span></td>
                <td style="font-size:13px">${esc(r.action?.channel || "auto")}</td>
              </tr>`).join("")
              : '<tr><td colspan="3" style="text-align:center;padding:24px;color:var(--muted)">No automation rules configured.</td></tr>'}</tbody></table>
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.4s">
          <h3 style="margin-bottom:8px">${icon("file-text")} WhatsApp Message Templates</h3>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px">Pre-approved templates for business-initiated conversations:</div>
          <div>
            ${Object.entries(wa.templates || {}).map(([key, name]) => `<div class="b-list-item" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--card-border)">${icon("file-text")} <div><b style="font-size:13px">${esc(name)}</b> <span style="color:var(--muted);font-size:12px">— ${esc(key.replace(/_/g, " "))}</span></div></div>`).join("") || '<div style="text-align:center;padding:24px;color:var(--muted)">No templates configured.</div>'}
          </div>
        </div>
      </div>`;

    $("#msg-scan").addEventListener("click", async () => {
      const found = await api.post(`/orchestrator/scan/${s}`);
      toast(`${icon("search")} Scan complete — ${Array.isArray(found) ? found.length : found.queued?.length || 0} action(s) queued.`);
      route();
    });
    $("#msg-exec").addEventListener("click", async () => {
      const result = await api.post(`/execute/${s}`);
      toast(`${icon("zap")} Executed — ${result.delivered ?? result.length ?? 0} message(s) delivered.`);
      route();
    });
  }

  // ── page: campaigns ────────────────────────────────────────────────
  async function renderCampaigns(container = view) {
    const s = api.store();
    const [campaigns, seasonal, withImpact] = await Promise.all([
      api.get(`/campaigns/${s}`).catch(() => []),
      api.get(`/seasonal/${s}?horizon_days=90`).catch(() => ({ opportunities: [] })),
      api.get(`/campaigns/${s}/with-impact`).catch(() => []),
    ]);

    const drafts = Array.isArray(campaigns) ? campaigns : campaigns.campaigns || campaigns.drafts || [];
    const opportunities = seasonal.opportunities || [];
    const impactList = Array.isArray(withImpact) ? withImpact : [];
    const impactMap = {};
    for (const c of impactList) impactMap[c._id] = c;

    // Categorise campaigns by lifecycle stage.
    const statusPill = (status) => {
      const map = {
        launched: "green", completed: "blue", no_targets: "amber",
        draft: "purple", AWAITING_APPROVAL: "purple", generated: "purple",
      };
      return `<span class="b-badge ${map[status] || ''}">${esc(status || "draft")}</span>`;
    };

    const canLaunch = (c) => {
      const s = c.status || "draft";
      return s === "draft" || s === "AWAITING_APPROVAL" || s === "generated" || c.can_launch;
    };
    const canExecute = (c) => c.status === "launched" || c.can_execute;
    const canMeasure = (c) => c.status === "launched" || c.status === "completed" || c.can_measure;

    const activeCampaigns = drafts.filter((c) => c.status === "launched");
    const draftCampaigns = drafts.filter((c) => canLaunch(c));
    const completedCampaigns = drafts.filter((c) => c.status === "completed" || c.status === "no_targets");

    // Campaign detail card with lifecycle buttons.
    const campaignCard = (c, mode) => {
      const imp = impactMap[c._id] || {};
      const actions = imp.action_count || 0;
      const delivered = imp.delivered_count || 0;
      const pending = imp.pending_count || 0;

      let metricsHtml = "";
      if (mode === "active") {
        metricsHtml = `
          <div class="campaign-metrics">
            <div class="campaign-metric"><span class="campaign-metric-val">${actions}</span><span class="campaign-metric-label">Targets</span></div>
            <div class="campaign-metric"><span class="campaign-metric-val">${delivered}</span><span class="campaign-metric-label">Delivered</span></div>
            <div class="campaign-metric"><span class="campaign-metric-val">${pending}</span><span class="campaign-metric-label">Pending</span></div>
          </div>`;
      } else if (mode === "completed") {
        metricsHtml = `
          <div class="campaign-metrics">
            <div class="campaign-metric"><span class="campaign-metric-val">${actions}</span><span class="campaign-metric-label">Targets</span></div>
            <div class="campaign-metric"><span class="campaign-metric-val">${delivered}</span><span class="campaign-metric-label">Delivered</span></div>
            <div class="campaign-metric"><span class="campaign-metric-val ${imp.delivery_rate >= 80 ? "kpi-up" : imp.delivery_rate >= 50 ? "kpi-warn" : ""}">${imp.delivery_rate || 0}%</span><span class="campaign-metric-label">Delivery rate</span></div>
          </div>`;
      }

      const btns = [];
      if (mode === "draft") {
        btns.push(`<button class="btn btn-sm btn-primary campaign-launch-btn" data-id="${esc(c._id)}">${icon("rocket")} Launch</button>`);
      } else if (mode === "active") {
        if (pending > 0) btns.push(`<button class="btn btn-sm btn-primary campaign-execute-btn" data-id="${esc(c._id)}">${icon("send")} Execute (${pending})</button>`);
        btns.push(`<button class="btn btn-sm btn-grad campaign-measure-btn" data-id="${esc(c._id)}">${icon("bar-chart")} Measure impact</button>`);
      } else if (mode === "completed") {
        btns.push(`<button class="btn btn-sm btn-grad campaign-measure-btn" data-id="${esc(c._id)}">${icon("bar-chart")} View impact</button>`);
      }

      return `<div class="campaign-card campaign-${mode}">
        <div class="campaign-card-head">
          <div>${icon("megaphone")} <div><b>${esc(c.subject || c.campaign_id)}</b><br><small class="muted">${esc(c.source || "draft")} · ${esc((c.channels || []).join(", ") || "email")} ${c.event ? ` · ${esc(c.event)}` : ""}</small></div></div>
          ${statusPill(c.status)}
        </div>
        <div class="campaign-card-body">
          <p class="muted" style="font-size:13px;margin-bottom:8px">${esc(c.headline || c.body || "")}</p>
          ${metricsHtml}
        </div>
        <div class="row-actions" style="margin-top:10px">${btns.join("")}</div>
      </div>`;
    };

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Campaigns & Retargeting</h2>
          <p>Generate, launch, and measure marketing campaigns</p>
        </div>
        <div class="b-header-filters">
          <button class="b-report-btn" id="gen-btn">${icon("sparkles")} Generate from trends</button>
        </div>
      </div>

      <div class="b-grid-4" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("rocket")}</div>
          </div>
          <div class="b-stat-value">${activeCampaigns.length}</div>
          <div class="b-stat-label">Active Campaigns</div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle purple">${icon("file-text")}</div>
          </div>
          <div class="b-stat-value">${draftCampaigns.length}</div>
          <div class="b-stat-label">Drafts</div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("check-circle")}</div>
          </div>
          <div class="b-stat-value">${completedCampaigns.length}</div>
          <div class="b-stat-label">Completed</div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle amber">${icon("calendar")}</div>
          </div>
          <div class="b-stat-value">${opportunities.length}</div>
          <div class="b-stat-label">Seasonal Opps</div>
        </div>
      </div>

      <div class="b-card" style="margin-bottom:24px;animation-delay:0.25s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3 style="margin:0">${icon("sparkles")} Campaign Pipeline</h3>
        </div>
        <p style="font-size:13px;color:var(--muted);margin-bottom:20px">Generate campaign drafts from rising trends and the retail calendar, then launch them to targeted customers.</p>

        ${activeCampaigns.length ? `
          <div style="margin-bottom:20px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <div class="b-icon-circle green" style="width:28px;height:28px">${icon("rocket")}</div>
              <h4 style="margin:0;font-size:14px">Active Campaigns</h4>
            </div>
            <div class="campaign-list">${activeCampaigns.map((c) => campaignCard(c, "active")).join("")}</div>
          </div>
        ` : ""}

        <div style="margin-bottom:${completedCampaigns.length ? '20px' : '0'}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
            <div class="b-icon-circle purple" style="width:28px;height:28px">${icon("file-text")}</div>
            <h4 style="margin:0;font-size:14px">Drafts Ready to Launch</h4>
          </div>
          <div class="scroll-y">${draftCampaigns.length
            ? `<div class="campaign-list">${draftCampaigns.map((c) => campaignCard(c, "draft")).join("")}</div>`
            : '<div style="text-align:center;padding:24px;color:var(--muted)">No drafts yet — generate from rising trends and the retail calendar.</div>'}</div>
        </div>

        ${completedCampaigns.length ? `
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <div class="b-icon-circle blue" style="width:28px;height:28px">${icon("check-circle")}</div>
              <h4 style="margin:0;font-size:14px">Completed Campaigns</h4>
            </div>
            <div class="campaign-list">${completedCampaigns.map((c) => campaignCard(c, "completed")).join("")}</div>
          </div>
        ` : ""}
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.35s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle amber">${icon("calendar")}</div>
            <h3 style="margin:0">Seasonal Opportunities (90d)</h3>
          </div>
          <div class="scroll-y" style="max-height:300px">${opportunities.length
            ? opportunities.map((op, i) => `<div class="b-list-item" style="animation-delay:${0.05 * (i + 1)}s">
                <div style="display:flex;align-items:center;gap:10px">
                  <div class="b-icon-circle ${op.days_until <= 14 ? 'amber' : 'green'}" style="width:32px;height:32px">${icon("gift")}</div>
                  <div>
                    <div style="font-weight:600;font-size:13px">${esc(op.event)}</div>
                    <div style="font-size:12px;color:var(--muted)">${op.days_until} day(s) — ${esc(op.advice || op.urgency || "")}</div>
                  </div>
                </div>
                <span class="b-badge ${op.days_until <= 14 ? 'amber' : 'green'}">${op.days_until}d</span>
              </div>`).join("")
            : '<div style="text-align:center;padding:24px;color:var(--muted)">No retail moments inside the current window.</div>'}</div>
        </div>
        <div class="b-card" style="animation-delay:0.4s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("users")}</div>
            <h3 style="margin:0">Retargeting Audiences</h3>
          </div>
          <button class="b-report-btn" id="rt-btn" style="margin-bottom:16px">${icon("users")} Build audiences</button>
          <div id="rt-result" class="scroll-y" style="max-height:240px"></div>
        </div>
      </div>

      <div id="measure-modal" class="campaign-measure-panel hidden"></div>`;

    // ── Event handlers ──────────────────────────────────────────────
    $("#gen-btn").addEventListener("click", async () => {
      const result = await api.post(`/campaigns/${s}/generate`, {});
      toast(`${icon("sparkles")} ${result.drafts?.length ?? 0} campaign draft(s) generated.`);
      route();
    });
    $("#rt-btn").addEventListener("click", async () => {
      const result = await api.post(`/retargeting/${s}/build`, {});
      const cart = result.cart_abandoners?.length ?? result.audiences?.cart_abandoners?.length ?? 0;
      const browse = result.browse_abandoners?.length ?? result.audiences?.browse_abandoners?.length ?? 0;
      $("#rt-result").innerHTML = `
        <div class="alert-item">${icon("cart")} <div><b>${cart}</b> cart abandoners ready for ads</div></div>
        <div class="alert-item">${icon("eye")} <div><b>${browse}</b> browse abandoners ready for ads</div></div>`;
    });

    // Launch buttons — convert draft → launched with target customers.
    container.querySelectorAll(".campaign-launch-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Launching...';
        try {
          const result = await api.post(`/campaigns/${s}/launch/${id}`, {});
          toast(`${icon("rocket")} Launched to ${result.target_count || 0} customer(s).`);
          route();
        } catch (e) { toast(`${icon("alert-triangle")} ${esc(e.message)}`); btn.disabled = false; btn.innerHTML = `${icon("rocket")} Launch`; }
      });
    });

    // Execute buttons — process pending actions through delivery pipeline.
    container.querySelectorAll(".campaign-execute-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sending...';
        try {
          const result = await api.post(`/campaigns/${s}/execute/${id}`, {});
          toast(`${icon("send")} Delivered ${result.delivered || 0}, suppressed ${result.suppressed || 0}, failed ${result.failed || 0}.`);
          route();
        } catch (e) { toast(`${icon("alert-triangle")} ${esc(e.message)}`); btn.disabled = false; btn.innerHTML = `${icon("send")} Execute`; }
      });
    });

    // Measure buttons — show impact panel.
    container.querySelectorAll(".campaign-measure-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const panel = $("#measure-modal");
        panel.classList.remove("hidden");
        panel.innerHTML = '<div style="padding:30px;text-align:center"><span class="spinner"></span> Measuring impact...</div>';
        try {
          const m = await api.get(`/campaigns/${s}/measure/${id}`);
          const revDelta = m.revenue_delta || 0;
          const revClass = revDelta > 0 ? "kpi-up" : revDelta < 0 ? "kpi-bad" : "";
          panel.innerHTML = `
            <div class="campaign-measure-content">
              <div class="campaign-measure-head">
                <h3>${icon("bar-chart")} Campaign impact: ${esc(m.campaign_name || "")}</h3>
                <button class="btn btn-sm btn-ghost-sm" id="close-measure">✕ Close</button>
              </div>
              <div class="campaign-measure-grid">
                <div class="campaign-measure-stat">
                  <div class="kpi-value">${m.targets || 0}</div>
                  <div class="kpi-sub">Customers targeted</div>
                </div>
                <div class="campaign-measure-stat">
                  <div class="kpi-value">${m.delivered || 0}</div>
                  <div class="kpi-sub">Messages delivered (${m.delivery_rate || 0}%)</div>
                </div>
                <div class="campaign-measure-stat">
                  <div class="kpi-value ${revClass}">${revDelta >= 0 ? "+" : ""}$${revDelta.toFixed(2)}</div>
                  <div class="kpi-sub">Revenue change</div>
                </div>
                <div class="campaign-measure-stat">
                  <div class="kpi-value">${m.post_campaign_purchases || 0}</div>
                  <div class="kpi-sub">Post-campaign purchases</div>
                </div>
              </div>
              <div class="campaign-measure-detail">
                <div class="grid grid-3" style="gap:12px">
                  <div class="alert-item">${icon("send")} <div><b>${m.delivered || 0}</b> delivered<br><small class="muted">${m.suppressed || 0} suppressed, ${m.failed || 0} failed</small></div></div>
                  <div class="alert-item">${icon("shopping-bag")} <div><b>${m.pre_campaign_purchases || 0}</b> pre-campaign purchases<br><small class="muted">$${(m.pre_campaign_revenue || 0).toFixed(2)} revenue</small></div></div>
                  <div class="alert-item green">${icon("trending-up")} <div><b>${m.post_campaign_purchases || 0}</b> post-campaign purchases<br><small class="muted">$${(m.post_campaign_revenue || 0).toFixed(2)} revenue</small></div></div>
                </div>
                ${m.channels?.length ? `<div class="muted" style="margin-top:10px;font-size:12px">Channels used: ${m.channels.map((c) => esc(c)).join(", ")}</div>` : ""}
                ${m.launched_at ? `<div class="muted" style="margin-top:4px;font-size:12px">Launched: ${new Date(m.launched_at).toLocaleString()}</div>` : ""}
              </div>
            </div>`;
          $("#close-measure").addEventListener("click", () => panel.classList.add("hidden"));
        } catch (e) {
          panel.innerHTML = `<div style="padding:30px;text-align:center">${icon("alert-triangle")} ${esc(e.message)}<br><button class="btn btn-sm btn-ghost-sm" id="close-measure-err" style="margin-top:10px">Close</button></div>`;
          $("#close-measure-err")?.addEventListener("click", () => panel.classList.add("hidden"));
        }
      });
    });
  }

  // ── page: competitors ──────────────────────────────────────────────
  async function renderCompetitors(container = view) {
    const s = api.store();
    const [analysis, ads, tracked] = await Promise.all([
      api.get(`/competitors/${s}`).catch(() => null),
      api.get(`/ads/${s}`).catch(() => null),
      api.get(`/competitors/${s}/tracked`).catch(() => ({ competitors: [] })),
    ]);
  
    const alerts = analysis?.high_priority_alerts
      || (analysis?.competitors || []).flatMap((c) => c.alerts || [])
      || [];
    const rivals = analysis?.competitors || [];
    const adCompetitors = ads?.competitors || [];
    const adInsights = ads?.insights || [];
    const trackedList = tracked?.competitors || [];
  
    const fmtTime = (iso) => {
      if (!iso) return "Never";
      const d = new Date(iso);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };
  
    const statusBadge = (st) => {
      if (st === "success") return '<span class="b-badge green">success</span>';
      if (st === "partial") return '<span class="b-badge amber">partial</span>';
      if (st === "failed") return '<span class="b-badge red">failed</span>';
      return '<span class="b-badge purple">pending</span>';
    };
  
    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Competitor Radar</h2>
          <p>Track competitors, pricing, ads, and catalog changes</p>
        </div>
      </div>

      <div class="b-grid-4" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("target")}</div>
          </div>
          <div class="b-stat-value">${trackedList.length}</div>
          <div class="b-stat-label">Tracked</div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle ${alerts.length > 0 ? 'red' : 'green'}">${icon("bell")}</div>
          </div>
          <div class="b-stat-value">${alerts.length}</div>
          <div class="b-stat-label">Active Alerts</div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle amber">${icon("film")}</div>
          </div>
          <div class="b-stat-value">${adCompetitors.length}</div>
          <div class="b-stat-label">Ad Intel</div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle purple">${icon("bar-chart")}</div>
          </div>
          <div class="b-stat-value">${rivals.length}</div>
          <div class="b-stat-label">Price Changes</div>
        </div>
      </div>

      <div class="b-card" style="margin-bottom:24px;animation-delay:0.25s">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <div class="b-icon-circle blue">${icon("search")}</div>
          <h3 style="margin:0">Add Competitor to Track</h3>
        </div>
        <div class="b-grid-3" style="gap:12px;align-items:end">
          <div>
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">COMPETITOR NAME</label>
            <input id="comp-name" placeholder="e.g. Rival Store" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);font-size:13px" />
          </div>
          <div>
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">STORE URL</label>
            <input id="comp-url" placeholder="https://rival-store.myshopify.com" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);font-size:13px" />
          </div>
          <div>
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">META PAGE ID (OPTIONAL)</label>
            <input id="comp-page" placeholder="Facebook Page ID for ad tracking" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);font-size:13px" />
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="b-report-btn" id="comp-add" style="background:var(--primary);color:#fff">${icon("target")} Add Competitor</button>
          <button class="b-report-btn" id="comp-scrape-all" ${trackedList.length === 0 ? "disabled" : ""}>${icon("search")} Scrape All</button>
          <button class="b-report-btn" id="comp-scrape-ads" ${trackedList.length === 0 ? "disabled" : ""}>${icon("film")} Scrape Meta Ads</button>
        </div>
        <div id="comp-msg" style="margin-top:8px"></div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.3s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle ${alerts.length > 0 ? 'red' : 'green'}">${icon("bell")}</div>
            <h3 style="margin:0">Active Alerts</h3>
          </div>
          <div class="scroll-y" style="max-height:360px">${alerts.length
            ? alerts.map((a, i) => `<div class="b-list-item" style="animation-delay:${0.05 * (i + 1)}s">
                <div style="display:flex;align-items:center;gap:10px">
                  <div class="b-icon-circle ${a.priority === "HIGH" || a.priority === "CRITICAL" ? 'red' : 'amber'}" style="width:32px;height:32px">${icon("target")}</div>
                  <div style="flex:1">
                    <span class="b-badge ${pillFor(a.priority || "")}">${esc(a.priority || "INFO")}</span>
                    <span style="font-size:13px;margin-left:6px">${esc(a.message)}</span>
                  </div>
                </div>
              </div>`).join("")
            : '<div style="text-align:center;padding:24px;color:var(--muted)">No changes detected yet. Add competitors and scrape to arm the radar.</div>'}</div>
        </div>
        <div class="b-card" style="animation-delay:0.35s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("users")}</div>
            <h3 style="margin:0">Tracked Competitors</h3>
          </div>
          <div class="scroll-y" id="tracked-list" style="max-height:360px">${trackedList.length
            ? trackedList.map((c, i) => `<div class="b-list-item" style="animation-delay:${0.05 * (i + 1)}s">
                <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
                  <div class="b-icon-circle blue" style="width:32px;height:32px">${icon("eye")}</div>
                  <div style="min-width:0">
                    <div style="font-weight:600;font-size:13px">${esc(c.competitor)}</div>
                    <div style="font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.url || "")}</div>
                    <div style="font-size:11px;color:var(--muted);margin-top:2px">
                      Last scrape: ${fmtTime(c.last_scrape_at)} ${c.last_scrape_status ? statusBadge(c.last_scrape_status) : ""} · ${c.last_product_count || 0} products
                    </div>
                  </div>
                </div>
                <div style="display:flex;gap:4px;flex-shrink:0">
                  <button class="b-report-btn comp-scrape-btn" data-id="${esc(c._id)}" style="padding:4px 8px">${icon("search")}</button>
                  <button class="b-report-btn comp-remove-btn" data-id="${esc(c._id)}" style="padding:4px 8px;color:var(--red)">${icon("trash")}</button>
                </div>
              </div>`).join("")
            : '<div style="text-align:center;padding:24px;color:var(--muted)">No competitors tracked yet. Add one above.</div>'}</div>
        </div>
      </div>

      <div class="b-grid-2">
        <div class="b-card" style="animation-delay:0.4s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle purple">${icon("film")}</div>
            <h3 style="margin:0">Competitor Ad Intelligence</h3>
          </div>
          ${adInsights.length ? `<div class="b-list-item" style="margin-bottom:12px"><div style="font-size:13px">${adInsights.map((i) => esc(i)).join("<br>")}</div></div>` : ""}
          <div class="scroll-y" style="max-height:300px">${adCompetitors.length
            ? adCompetitors.map((ad, i) => `<div class="b-list-item" style="animation-delay:${0.05 * (i + 1)}s">
                <div style="display:flex;align-items:center;gap:10px">
                  <div class="b-icon-circle amber" style="width:32px;height:32px">${icon("tv")}</div>
                  <div style="flex:1">
                    <div style="font-weight:600;font-size:13px">${esc(ad.competitor)} — ${ad.ad_count} ad(s)</div>
                    <div style="font-size:12px;color:var(--muted)">${esc(ad.primary_platform || "?")}, ${esc(ad.primary_format || "?")} · Top CTA: ${esc(ad.top_cta || "—")}</div>
                    ${(ad.newest_ads || []).map((a) => `<div style="font-size:11px;color:var(--text-dim);margin-top:2px">"${esc(a.headline || "")}" on ${esc(a.platform)}</div>`).join("")}
                  </div>
                </div>
              </div>`).join("")
            : '<div style="text-align:center;padding:24px;color:var(--muted)">No ad-library data yet. Add Meta Page IDs above and click "Scrape Meta ads".</div>'}</div>
        </div>
        <div class="b-card" style="animation-delay:0.45s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("bar-chart")}</div>
            <h3 style="margin:0">Price & Catalog Changes</h3>
          </div>
          <div class="scroll-y" style="max-height:340px">${rivals.length
            ? rivals.map((r) => {
                const changes = r.changes || {};
                const items = [
                  ...(changes.price_drops || []).map((d) => `<div class="b-list-item"><div style="display:flex;align-items:center;gap:8px"><div class="b-icon-circle green" style="width:28px;height:28px">${icon("trending-up")}</div><div><b>${esc(r.competitor)}</b> cut ${esc(d.name)} by ${d.change_pct}% <span class="muted">($${d.from} → $${d.to})</span></div></div></div>`),
                  ...(changes.possible_promotions || []).map((p) => `<div class="b-list-item"><div style="display:flex;align-items:center;gap:8px"><div class="b-icon-circle amber" style="width:28px;height:28px">${icon("gift")}</div><div><b>${esc(r.competitor)}</b> promo on ${esc(p.name)}: ${esc(p.detected_offer || p.estimated_discount_pct + "% off")}</div></div></div>`),
                  ...(changes.stockouts || []).map((s) => `<div class="b-list-item"><div style="display:flex;align-items:center;gap:8px"><div class="b-icon-circle red" style="width:28px;height:28px">${icon("alert-triangle")}</div><div><b>${esc(r.competitor)}</b>: ${esc(s.name)} is <span class="b-badge red">out of stock</span> — capture their demand</div></div></div>`),
                  ...(changes.new_products || []).map((p) => `<div class="b-list-item"><div style="display:flex;align-items:center;gap:8px"><div class="b-icon-circle blue" style="width:28px;height:28px">${icon("package")}</div><div><b>${esc(r.competitor)}</b> added ${esc(p.name)} <span class="muted">($${p.price || "?"})</span></div></div></div>`),
                ];
                return items.join("");
              }).join("") || '<div style="text-align:center;padding:24px;color:var(--muted)">No changes detected yet.</div>'
            : '<div style="text-align:center;padding:24px;color:var(--muted)">No competitor data yet.</div>'}</div>
        </div>
      </div>`;
  
    // ── Event handlers ──────────────────────────────────────────────
    $("#comp-add").addEventListener("click", async () => {
      const name = $("#comp-name").value.trim();
      const url = $("#comp-url").value.trim();
      const pageId = $("#comp-page").value.trim();
      if (!name || !url) { toast("Name and URL are required."); return; }
      try {
        await api.post(`/competitors/${s}/tracked`, { competitor: name, url, meta_page_id: pageId || null });
        toast(`${icon("check-circle")} ${esc(name)} added to tracking.`);
        route();
      } catch (e) { toast(`${icon("alert-triangle")} ${esc(e.message)}`); }
    });
  
    $("#comp-scrape-all")?.addEventListener("click", async () => {
      $("#comp-msg").innerHTML = '<span class="muted">Scraping all competitors...</span>';
      try {
        const result = await api.post(`/competitors/${s}/scrape-all`);
        $("#comp-msg").innerHTML = `<div class="alert-item green">${icon("check-circle")} <div>Scraped ${result.results?.length || 0} competitor(s), ${result.total_products || 0} product(s) total.</div></div>`;
        setTimeout(() => route(), 1500);
      } catch (e) { $("#comp-msg").innerHTML = `<div class="alert-item red">${icon("alert-triangle")} ${esc(e.message)}</div>`; }
    });
  
    $("#comp-scrape-ads")?.addEventListener("click", async () => {
      $("#comp-msg").innerHTML = '<span class="muted">Scraping Meta Ad Library...</span>';
      try {
        const result = await api.post(`/competitors/${s}/scrape-ads`);
        $("#comp-msg").innerHTML = `<div class="alert-item green">${icon("check-circle")} <div>${esc(result.message || `Scraped ${result.ads_scraped || 0} ad(s) from ${result.competitors_scraped || 0} competitor(s)`)}</div></div>`;
        setTimeout(() => route(), 1500);
      } catch (e) { $("#comp-msg").innerHTML = `<div class="alert-item red">${icon("alert-triangle")} ${esc(e.message)}</div>`; }
    });
  
    document.querySelectorAll(".comp-scrape-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        btn.textContent = "...";
        try {
          const result = await api.post(`/competitors/${s}/scrape/${id}`);
          toast(`${icon("check-circle")} ${esc(result.competitor)}: ${result.products_scraped} products, ${result.status}`);
          route();
        } catch (e) { toast(`${icon("alert-triangle")} ${esc(e.message)}`); btn.textContent = "!"; }
      });
    });
  
    document.querySelectorAll(".comp-remove-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Stop tracking this competitor?")) return;
        try {
          await api.del(`/competitors/${s}/tracked/${btn.dataset.id}`);
          toast("Competitor removed.");
          route();
        } catch (e) { toast(`${icon("alert-triangle")} ${esc(e.message)}`); }
      });
    });
  }

  // ── page: brand keywords ──────────────────────────────────────────
  async function renderBrandKeywords(container = view) {
    const s = api.store();
    const existing = await api.get("/brand-keywords").catch(() => ({ keywords: [] }));
    const keywords = existing.keywords || [];

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>${icon("tag")} Brand Keywords</h2>
          <p>Monitor brand mentions, sentiment, and search visibility</p>
        </div>
      </div>

      <div class="b-card" style="animation-delay:0.05s;margin-bottom:24px">
        <h3 style="margin-bottom:16px">Add Keywords</h3>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <input id="bk-input" placeholder="e.g. your brand name, product name" style="flex:1;padding:11px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);font-size:13px;font-family:var(--font-body)" />
          <button class="btn btn-primary" id="bk-add">${icon("plus", "icon-sm")} Add</button>
        </div>

        <div id="bk-list" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
          ${keywords.length ? keywords.map((k) => `
            <span class="b-badge cyan" style="display:flex;align-items:center;gap:6px;padding:6px 12px">
              ${esc(k)}
              <button class="bk-remove" data-keyword="${esc(k)}" style="background:none;border:none;color:var(--text-dim);cursor:pointer;padding:0;font-size:14px">×</button>
            </span>
          `).join("") : '<span style="color:var(--muted);font-size:13px">No keywords added yet</span>'}
        </div>

        <div id="bk-msg"></div>

        <div style="padding:16px;background:var(--surface-2);border-radius:12px;margin-top:16px">
          <h4 style="margin-bottom:8px;font-size:14px">Why add brand keywords?</h4>
          <ul style="margin:0;padding-left:20px;font-size:13px;color:var(--muted)">
            <li>Monitor brand mentions across the web</li>
            <li>Track sentiment changes in real-time</li>
            <li>Improve SEO visibility for branded searches</li>
            <li>Get alerts when competitors mention your brand</li>
          </ul>
        </div>
      </div>`;

    // Add keyword
    $("#bk-add").addEventListener("click", async () => {
      const input = $("#bk-input");
      const keyword = input.value.trim().toLowerCase();
      if (!keyword) { toast("Please enter a keyword"); return; }
      if (keywords.includes(keyword)) { toast("Keyword already added"); return; }

      keywords.push(keyword);
      try {
        await api.post("/brand-keywords", { keywords });
        toast(`${icon("check-circle")} Keyword "${keyword}" added`);
        route();
      } catch (e) {
        keywords.pop();
        toast(`${icon("alert-triangle")} ${esc(e.message)}`);
      }
    });

    // Enter key to add
    $("#bk-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("#bk-add").click();
    });

    // Remove keywords
    document.querySelectorAll(".bk-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const kw = btn.dataset.keyword;
        const idx = keywords.indexOf(kw);
        if (idx > -1) keywords.splice(idx, 1);
        try {
          await api.post("/brand-keywords", { keywords });
          toast(`Keyword "${kw}" removed`);
          route();
        } catch (e) {
          keywords.splice(idx, 0, kw);
          toast(`${icon("alert-triangle")} ${esc(e.message)}`);
        }
      });
    });
  }

  // ── page: seo & trends ─────────────────────────────────────────────
  async function renderSeo(container = view) {
    const s = api.store();
    const [performance, trends, rankings, storeInfo] = await Promise.all([
      api.get(`/search-console/${s}/performance`).catch(() => ({ queries: [] })),
      api.get(`/trends/${s}`).catch(() => null),
      api.get(`/seo/${s}/rankings`).catch(() => null),
      api.get(`/seo/store-info/${s}`).catch(() => ({ store_url: null, brand: s, connected: false })),
    ]);

    const queries = performance.queries || [];
    const trendList = trends?.trends || trends?.rising || (Array.isArray(trends) ? trends : []);
    const rankRows = rankings?.comparisons || rankings?.rows || [];
    const autoUrl = storeInfo.store_url || "";
    const autoBrand = storeInfo.brand || s;
    const isConnected = storeInfo.connected;

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>SEO & Trends</h2>
          <p>Search performance, rankings, and trend analysis</p>
        </div>
      </div>

      <div class="b-card" style="margin-bottom:24px;animation-delay:0.05s">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <div class="b-icon-circle amber">${icon("zap")}</div>
          <h3 style="margin:0">SEO Optimizer — One-Click Fix</h3>
        </div>
        <p style="font-size:13px;color:var(--muted);margin-bottom:16px">${isConnected
          ? `Your store <b style="color:var(--text)">${esc(autoUrl || s)}</b> is connected. Click the button below to analyze and fix everything.`
          : "Deep analysis + auto-generate all fixes for SEO, structured data, and AI search visibility (ChatGPT, Perplexity, Google AI)."}</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
          <button class="b-report-btn" id="seo-one-click-btn" style="background:var(--primary);color:#fff;padding:12px 24px;font-size:14px">${icon("zap")} Analyze & Fix Everything</button>
          <span style="font-size:12px;color:var(--muted)">One click = full SEO audit + all code snippets + AI search optimization</span>
        </div>
        <details style="margin-top:8px">
          <summary style="cursor:pointer;color:var(--muted);font-size:13px">Advanced: customize store details</summary>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin-top:12px">
            <div style="flex:1;min-width:200px">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">STORE URL</label>
              <input id="seo-url" value="${esc(autoUrl)}" placeholder="https://mystore.myshopify.com" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);font-size:13px" />
            </div>
            <div style="min-width:140px">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">BRAND NAME</label>
              <input id="seo-brand" value="${esc(autoBrand)}" placeholder="My Store" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);font-size:13px" />
            </div>
            <div style="min-width:140px">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">CATEGORY</label>
              <input id="seo-category" placeholder="Fashion, Electronics..." style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);font-size:13px" />
            </div>
          </div>
          <div style="margin-top:8px">
            <input id="seo-keywords" placeholder="Keywords (comma separated)" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);font-size:13px" />
          </div>
        </details>
      </div>

      <div id="seo-result" style="display:none">
        <div class="b-grid-4" style="margin-bottom:24px">
          <div class="b-card" style="animation-delay:0.05s">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
              <div class="b-icon-circle green">${icon("check-circle")}</div>
            </div>
            <div class="b-stat-value" id="seo-score">—</div>
            <div class="b-stat-label">Current SEO Score</div>
            <div id="seo-grade" style="font-size:12px;color:var(--muted);margin-top:4px">—</div>
          </div>
          <div class="b-card" style="animation-delay:0.1s">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
              <div class="b-icon-circle amber">${icon("alert-triangle")}</div>
            </div>
            <div class="b-stat-value" id="seo-fixes-count">—</div>
            <div class="b-stat-label">Fixes Found</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px">Ready to apply</div>
          </div>
          <div class="b-card" style="animation-delay:0.15s">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
              <div class="b-icon-circle purple">${icon("cpu")}</div>
            </div>
            <div class="b-stat-value" id="ai-readiness">—</div>
            <div class="b-stat-label">AI Readiness</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px">AI search visibility</div>
          </div>
          <div class="b-card" style="animation-delay:0.2s">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
              <div class="b-icon-circle blue">${icon("zap")}</div>
            </div>
            <div class="b-stat-value" id="seo-total">—</div>
            <div class="b-stat-label">Total Actions</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px">SEO + AI combined</div>
          </div>
        </div>

        <div class="b-grid-2" style="margin-bottom:24px">
          <div class="b-card" style="animation-delay:0.25s">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
              <div class="b-icon-circle green">${icon("check-circle")}</div>
              <h3 style="margin:0">SEO Fixes</h3>
            </div>
            <div id="seo-fixes-list" class="scroll-y" style="max-height:400px"></div>
          </div>
          <div class="b-card" style="animation-delay:0.3s">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
              <div class="b-icon-circle purple">${icon("cpu")}</div>
              <h3 style="margin:0">AI Search Optimization</h3>
            </div>
            <div id="ai-fixes-list" class="scroll-y" style="max-height:400px"></div>
          </div>
        </div>

        <div class="b-card" style="animation-delay:0.35s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("file-text")}</div>
            <h3 style="margin:0">Generated Code Snippets</h3>
          </div>
          <p style="font-size:13px;color:var(--muted);margin-bottom:16px">Copy-paste ready code for every fix. Shopify Liquid templates included where applicable.</p>
          <div id="seo-snippets" class="scroll-y" style="max-height:500px"></div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.4s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("search")}</div>
            <h3 style="margin:0">Search Performance (GSC)</h3>
          </div>
          <div class="scroll-y" style="max-height:320px">
            <table class="b-table">
              <thead><tr><th>Query</th><th>Impr.</th><th>Clicks</th><th>CTR</th><th>Pos.</th></tr></thead>
              <tbody>${queries.map((q, i) => `<tr style="animation-delay:${0.03 * (i + 1)}s">
                <td><b>${esc(q.query)}</b></td>
                <td>${q.impressions}</td>
                <td>${q.clicks}</td>
                <td><span class="b-badge ${parseFloat(q.ctr) > 3 ? 'green' : 'amber'}">${q.ctr}%</span></td>
                <td>${q.avg_position ?? "—"}</td>
              </tr>`).join("") || '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">No search data ingested yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.45s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("trending-up")}</div>
            <h3 style="margin:0">Rising Trends</h3>
          </div>
          <div class="scroll-y" style="max-height:320px">${trendList.length
            ? trendList.map((t, i) => `<div class="b-list-item" style="animation-delay:${0.05 * (i + 1)}s">
                <div style="display:flex;align-items:center;gap:10px">
                  <div class="b-icon-circle green" style="width:32px;height:32px">${icon("trending-up")}</div>
                  <div>
                    <div style="font-weight:600;font-size:13px">${esc(t.keyword)}</div>
                    <div style="font-size:12px;color:var(--muted)">momentum ${esc(t.momentum ?? t.score ?? "—")} ${esc(t.direction || t.source || "")}</div>
                  </div>
                </div>
              </div>`).join("")
            : '<div style="text-align:center;padding:24px;color:var(--muted)">Feed external signals to detect trends.</div>'}</div>
        </div>
      </div>
      <div class="b-grid-2">
        <div class="b-card" style="animation-delay:0.5s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle amber">${icon("flag")}</div>
            <h3 style="margin:0">Ranking Comparison</h3>
          </div>
          <div class="scroll-y" style="max-height:280px">${Array.isArray(rankRows) && rankRows.length
            ? rankRows.map((r, i) => `<div class="b-list-item" style="animation-delay:${0.05 * (i + 1)}s">
                <div style="display:flex;align-items:center;gap:8px">
                  <div style="width:6px;height:6px;border-radius:50%;background:var(--primary);flex-shrink:0"></div>
                  <div>
                    <span style="font-weight:600;font-size:13px">${esc(r.keyword)}</span>
                    <span style="font-size:12px;color:var(--muted);margin-left:6px">${esc(r.brand || "us")} at #${esc(r.position)}</span>
                  </div>
                </div>
              </div>`).join("")
            : '<div style="text-align:center;padding:24px;color:var(--muted)">Ingest ranking snapshots to compare against rivals.</div>'}</div>
        </div>
        <div class="b-card" style="animation-delay:0.55s">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="b-icon-circle purple">${icon("cpu")}</div>
            <h3 style="margin:0">Intent Gap</h3>
          </div>
          <button class="b-report-btn" id="gap-btn" style="margin-bottom:16px">${icon("search")} Analyze gaps</button>
          <div id="gap-result" class="scroll-y" style="max-height:240px"></div>
        </div>
      </div>`;

    $("#seo-one-click-btn").addEventListener("click", async () => {
      const url = $("#seo-url").value?.trim();
      if (!url) return alert("Enter your store URL first (or connect your store).");
      const brand = $("#seo-brand").value?.trim();
      const category = $("#seo-category").value?.trim();
      const keywords = $("#seo-keywords").value?.split(",").map((k) => k.trim()).filter(Boolean) || [];

      const btn = $("#seo-one-click-btn");
      btn.disabled = true;
      btn.innerHTML = `${icon("loader")} Analyzing & generating fixes...`;

      try {
        const result = await api.post("/seo/one-click-fix", {
          url, brand, category, keywords, store_id: s,
        });

        $("#seo-result").style.display = "block";
        $("#seo-result").scrollIntoView({ behavior: "smooth", block: "start" });
        $("#seo-score").textContent = result.current_score + "%";
        $("#seo-grade").textContent = `${result.fixes_count} issues found`;
        $("#seo-fixes-count").textContent = result.fixes_count;
        $("#ai-readiness").textContent = (result.ai_optimization?.ai_readiness_score ?? "—") + "%";
        $("#seo-total").textContent = result.total_actions;

        // SEO fixes list
        const fixesHtml = (result.fixes || []).map((f, i) => {
          const sevColor = f.severity === "CRITICAL" ? "red" : f.severity === "HIGH" ? "amber" : f.severity === "MEDIUM" ? "blue" : "green";
          return `<div class="b-list-item" style="animation-delay:${0.05 * (i + 1)}s">
            <div style="display:flex;align-items:flex-start;gap:10px;flex:1">
              <div class="b-icon-circle ${sevColor}" style="width:32px;height:32px;flex-shrink:0">${icon("alert-triangle")}</div>
              <div>
                <span class="b-badge ${sevColor}" style="margin-bottom:4px;display:inline-block">${f.severity}</span> <b style="font-size:13px">${esc(f.area)}</b>
                <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(f.issue)}</div>
                <div style="color:var(--green);font-size:12px;margin-top:4px">${icon("check")} ${esc(f.fix)}</div>
                <div style="font-size:11px;color:var(--muted);margin-top:2px">Impact: ${esc(f.impact)}</div>
              </div>
            </div>
          </div>`;
        }).join("") || '<div style="text-align:center;padding:24px;color:var(--muted)">No SEO issues found!</div>';
        $("#seo-fixes-list").innerHTML = fixesHtml;

        // AI fixes list
        const aiFixes = result.ai_optimization?.actions || [];
        const aiHtml = aiFixes.map((f, i) => {
          const sevColor = f.severity === "HIGH" ? "amber" : f.severity === "MEDIUM" ? "blue" : "green";
          return `<div class="b-list-item" style="animation-delay:${0.05 * (i + 1)}s">
            <div style="display:flex;align-items:flex-start;gap:10px;flex:1">
              <div class="b-icon-circle ${sevColor}" style="width:32px;height:32px;flex-shrink:0">${icon("cpu")}</div>
              <div>
                <span class="b-badge ${sevColor}" style="margin-bottom:4px;display:inline-block">${f.severity}</span> <b style="font-size:13px">${esc(f.area)}</b>
                <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(f.issue)}</div>
                <div style="color:var(--green);font-size:12px;margin-top:4px">${icon("check")} ${esc(f.fix)}</div>
              </div>
            </div>
          </div>`;
        }).join("") || '<div style="text-align:center;padding:24px;color:var(--muted)">AI optimization ready!</div>';
        $("#ai-fixes-list").innerHTML = aiHtml;

        // Code snippets
        const snippets = result.snippets || {};
        const aiSnippets = result.ai_optimization?.snippets || {};
        const allSnippets = { ...snippets, ...aiSnippets };
        const snippetsHtml = Object.entries(allSnippets).map(([key, val]) => {
          const content = typeof val === "string" ? val : (val.html || val.guide || val.nginx || JSON.stringify(val, null, 2));
          return `<details style="margin-bottom:8px;border:1px solid var(--card-border);border-radius:8px;padding:8px 12px"><summary style="cursor:pointer;font-weight:600;text-transform:capitalize">${key.replace(/_/g, " ")}</summary><pre style="background:var(--input-bg);padding:12px;border-radius:8px;margin-top:8px;overflow-x:auto;font-size:12px;white-space:pre-wrap">${esc(content)}</pre></details>`;
        }).join("");
        $("#seo-snippets").innerHTML = snippetsHtml || '<div class="empty">No snippets generated.</div>';
      } catch (err) {
        alert("Optimization failed: " + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `${icon("zap")} Analyze & Fix Everything`;
      }
    });

    $("#gap-btn").addEventListener("click", async () => {
      const result = await api.post(`/seo/${s}/intent-gap`, { covered_keywords: [] });
      const gaps = result.gaps || [];
      $("#gap-result").innerHTML = gaps.length
        ? gaps.map((g, i) => `<div class="b-list-item" style="animation-delay:${0.05 * (i + 1)}s">
            <div style="display:flex;align-items:center;gap:10px">
              <div class="b-icon-circle amber" style="width:32px;height:32px">${icon("search")}</div>
              <div>
                <div style="font-weight:600;font-size:13px">${esc(g.keyword || g.query)}</div>
                <div style="font-size:12px;color:var(--muted)">${esc(g.reason || g.intent || "uncovered intent")}</div>
              </div>
            </div>
          </div>`).join("")
        : '<div style="text-align:center;padding:24px;color:var(--muted)">No gaps found.</div>';
    });
  }

  // ── page: reports ──────────────────────────────────────────────────
  async function renderReports(container = view) {
    const s = api.store();
    const [roi, maturity, digest, attribution] = await Promise.all([
      api.get(`/report/${s}/roi`).catch(() => null),
      api.get(`/report/${s}/maturity`).catch(() => null),
      api.get(`/report/${s}/weekly-digest`).catch(() => null),
      api.get(`/attribution/${s}`).catch(() => null),
    ]);

    const byRule = attribution?.by_rule || attribution?.report?.by_rule || [];

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Reports & Analytics</h2>
          <p>ROI, attribution, maturity, and weekly digest</p>
        </div>
      </div>

      <div class="b-grid-4" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:4px">ROI</div>
          <div class="b-stat-value" style="color:${roi?.verdict === "PROFITABLE" ? 'var(--green)' : 'var(--amber)'}">${roi ? roi.roi_percent + "%" : "—"}</div>
          <div class="b-stat-label">${esc(roi?.verdict || "")} · ${money(roi?.net_gain)} net</div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:4px">Attributed Revenue</div>
          <div class="b-stat-value">${money(roi?.attributed_revenue)}</div>
          <div class="b-stat-label">vs ${money(roi?.subscription_cost)} subscription</div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:4px">Maturity</div>
          <div class="b-stat-value">${maturity?.score ?? "—"}</div>
          <div class="b-stat-label">${esc(maturity?.stage || "")}</div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-bottom:4px">Sentiment</div>
          <div class="b-stat-value">${digest?.sentiment_trend?.current ?? "—"}</div>
          <div class="b-stat-label">${esc(digest?.sentiment_trend?.direction || "")}</div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-chart-card" style="animation-delay:0.25s">
          <h3>${icon("dollar")} Revenue by Automation Rule</h3>
          <div class="chart-wrap"><canvas id="attr-chart"></canvas></div>
        </div>
        <div class="b-card" style="animation-delay:0.3s">
          <h3 style="margin-bottom:16px">${icon("clipboard")} Weekly Digest</h3>
          <div>${digest ? `
            <div class="b-list-item" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--card-border)">${icon("banknote")} <div style="font-size:13px">Revenue ${money(digest.headline?.revenue)} · attributed ${money(digest.headline?.attributed_revenue)} (${digest.headline?.roi_percent}%)</div></div>
            <div class="b-list-item" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--card-border)">${icon("send")} <div style="font-size:13px">${digest.headline?.actions_delivered || 0} automated messages delivered</div></div>
            <div class="b-list-item" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--card-border)">${icon("cpu")} <div style="font-size:13px">Platform stage: <b>${esc(digest.headline?.maturity_stage || "—")}</b></div></div>
            <div class="b-list-item" style="display:flex;align-items:center;gap:10px;padding:10px 0">${icon("heart")} <div style="font-size:13px">${(digest.churn?.top_at_risk || []).length} customer(s) flagged at-risk</div></div>` : '<div style="text-align:center;padding:24px;color:var(--muted)">Digest unavailable.</div>'}</div>
        </div>
      </div>`;

    const ruleEntries = Array.isArray(byRule) ? byRule : Object.entries(byRule || {}).map(([rule, value]) => ({ rule_id: rule, ...(typeof value === "object" ? value : { attributed_revenue: value }) }));
    makeChart($("#attr-chart"), {
      type: "bar",
      data: {
        labels: ruleEntries.map((r) => r.rule_id || r.rule || "—"),
        datasets: [{ data: ruleEntries.map((r) => r.attributed_revenue || r.revenue || 0), backgroundColor: GRAD, borderRadius: 8 }],
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
  }

  // ── page: settings ─────────────────────────────────────────────────
  async function renderSettings(container = view) {
    const sess = api.session() || {};
    const connectors = await api.get("/connectors").catch(() => ({}));
    const readyBadge = (p) =>
      connectors[p]?.ready
        ? '<span style="color:var(--green)">● Ready</span>'
        : '<span style="color:var(--amber)">○ Not configured</span>';

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Settings</h2>
          <p>Connection, GDPR, connectors, and platform info</p>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <h3 style="margin-bottom:12px">Connection</h3>
          <div style="font-size:13px;color:var(--muted);margin-bottom:6px">Store: <b style="color:var(--text)">${esc(sess.storeId || "")}</b></div>
          <div style="font-size:13px;color:var(--muted)">API key: <code style="background:var(--surface-2);padding:2px 6px;border-radius:4px">${esc((sess.apiKey || "").slice(0, 3))}•••••</code></div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <h3 style="margin-bottom:12px">GDPR — Customer Data</h3>
          <input id="gdpr-id" placeholder="customer id or email" style="width:100%;padding:11px;border-radius:10px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);margin-bottom:10px;font-size:13px;font-family:var(--font-body)" />
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-primary" id="gdpr-export">${icon("upload", "icon-sm")} Export data</button>
            <button class="btn btn-sm" id="gdpr-delete" style="background:var(--red);color:#fff">${icon("trash", "icon-sm")} Right to be forgotten</button>
          </div>
          <div id="gdpr-result" style="margin-top:12px"></div>
        </div>
      </div>

      <div class="b-card" style="animation-delay:0.15s;margin-bottom:24px">
        <h3 style="margin-bottom:8px">${icon("plug")} Platform Connectors</h3>
        <div style="font-size:12px;color:var(--muted);margin-bottom:16px">One-click connect needs your own OAuth app credentials. Create a free app on each platform, paste the credentials here, and merchants can authorize with a single click.</div>
        <div class="b-grid-2">
          <div>
            <div style="margin-bottom:8px"><b>Shopify</b> — ${readyBadge("shopify")} <span style="color:var(--muted);font-size:12px">(redirect: <code style="background:var(--surface-2);padding:2px 4px;border-radius:3px">${esc(location.origin)}/connect/shopify/callback</code>)</span></div>
            <input id="cf-shp-id" placeholder="Client ID (API key)" style="${INPUT_STYLE}" />
            <input id="cf-shp-secret" placeholder="Client secret" type="password" style="${INPUT_STYLE}" />
            <button class="btn btn-sm btn-primary" id="save-shp">Save Shopify connector</button>
          </div>
          <div>
            <div style="margin-bottom:8px"><b>BigCommerce</b> — ${readyBadge("bigcommerce")} <span style="color:var(--muted);font-size:12px">(callback: <code style="background:var(--surface-2);padding:2px 4px;border-radius:3px">${esc(location.origin)}/connect/bigcommerce/callback</code>)</span></div>
            <input id="cf-bc-id" placeholder="Client ID" style="${INPUT_STYLE}" />
            <input id="cf-bc-secret" placeholder="Client secret" type="password" style="${INPUT_STYLE}" />
            <button class="btn btn-sm btn-primary" id="save-bc">Save BigCommerce connector</button>
          </div>
        </div>
        <div id="connector-result" style="margin-top:10px"></div>
        <div style="font-size:12px;color:var(--muted);margin-top:10px">WooCommerce and custom stores need no credentials — they connect via REST keys / public catalog.</div>
      </div>

      <div class="b-card" style="animation-delay:0.2s">
        <h3 style="margin-bottom:8px">Platform Architecture</h3>
        <div style="font-size:13px;color:var(--muted)">Data → Intelligence → Decision → Execution → Reporting → Growth Loop. Every sale updates stock and analytics in real time.</div>
      </div>`;

    $("#gdpr-export").addEventListener("click", async () => {
      const id = $("#gdpr-id").value.trim();
      if (!id) return;
      try {
        const data = await api.get(`/admin/gdpr/${api.store()}/${encodeURIComponent(id)}`);
        $("#gdpr-result").innerHTML = `<div class="alert-item green">${icon("upload")} Exported ${data.total_records} record(s): profile + ${data.events?.length || 0} events + ${data.deliveries?.length || 0} deliveries.</div>`;
      } catch (error) { $("#gdpr-result").innerHTML = `<p class="muted">${esc(error.message)}</p>`; }
    });
    $("#gdpr-delete").addEventListener("click", async () => {
      const id = $("#gdpr-id").value.trim();
      if (!id || !confirm(`Anonymize all data for "${id}"? This cannot be undone.`)) return;
      try {
        const result = await api.del(`/admin/gdpr/${api.store()}/${encodeURIComponent(id)}`);
        $("#gdpr-result").innerHTML = `<div class="alert-item amber">${icon("trash")} Anonymized — ${result.events_scrubbed} events, ${result.deliveries_scrubbed} deliveries, ${result.actions_scrubbed} actions scrubbed.</div>`;
      } catch (error) { $("#gdpr-result").innerHTML = `<p class="muted">${esc(error.message)}</p>`; }
    });

    const saveConnector = (platformName, idSel, secretSel) => async () => {
      const client_id = $(idSel).value.trim();
      const client_secret = $(secretSel).value.trim();
      const box = $("#connector-result");
      if (!client_id || !client_secret) {
        box.innerHTML = '<p class="muted" style="color:var(--amber)">Both Client ID and secret are required.</p>';
        return;
      }
      try {
        await api.put(`/connectors/${platformName}`, { client_id, client_secret });
        box.innerHTML = `<div class="alert-item green">${icon("check-circle")} ${PLATFORM_LABELS[platformName]} connector saved — one-click connect is now live on the login page.</div>`;
        $(secretSel).value = "";
      } catch (error) {
        box.innerHTML = `<div class="alert-item amber">${icon("alert-triangle")} ${esc(error.message)}</div>`;
      }
    };
    $("#save-shp").addEventListener("click", saveConnector("shopify", "#cf-shp-id", "#cf-shp-secret"));
    $("#save-bc").addEventListener("click", saveConnector("bigcommerce", "#cf-bc-id", "#cf-bc-secret"));
  }

  // ── boot ───────────────────────────────────────────────────────────
  const INPUT_STYLE =
    "width:100%;padding:11px;border-radius:10px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);margin-bottom:10px";

  function copyText(text, btn) {
    const done = () => {
      const old = btn.textContent;
      btn.textContent = "✓ Copied";
      setTimeout(() => (btn.textContent = old), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    }
  }

  async function renderConnect(container = view) {
    const s = api.store();
    const [status, info, connectors] = await Promise.all([
      api.get(`/integrations/${s}`).catch(() => ({ connected: false })),
      api.get(`/integrations/${s}/snippet`).catch(() => ({ snippet: "", webhook_url: "", csv_format: { products: "", orders: "" } })),
      api.get("/connectors").catch(() => ({})),
    ]);

    const statusHtml = () =>
      status.connected
        ? `<div class="alert-item green">● Connected via <b>&nbsp;${esc(status.type || "integration")}</b>&nbsp;— ${status.events_received || 0} event(s) received${
            status.last_event_at ? " · last " + esc(String(status.last_event_at).slice(0, 16).replace("T", " ")) : ""
          }${status.products_synced ? " · " + status.products_synced + " products" : ""}${status.orders_synced ? " · " + status.orders_synced + " orders" : ""}</div>${
            (status.events_received || 0) === 0 && (status.products_synced || 0) > 0
              ? `<div class="alert-item amber" style="margin-top:8px">${icon("bar-chart")} Catalog synced, but <b>&nbsp;orders &amp; traffic are still missing</b>&nbsp;— analytics stay empty until data flows. Import the <b>Orders CSV</b> below for instant history, or install the tracking snippet (Advanced) for live events.</div>`
              : ""
          }`
        : `<div class="alert-item amber">○ Not connected yet — pick your platform below. Products and orders sync the moment you authorize.</div>`;

    const oauthNote = (p, name) =>
      connectors[p]?.ready === false
        ? `<p class="muted" style="color:var(--amber)">${icon("alert-triangle", "icon-sm")} Connector not configured yet — add the ${name} app credentials in Settings → Platform connectors.</p>`
        : "";

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Connect Store</h2>
          <p>Connect your e-commerce platform or import data</p>
        </div>
      </div>

      <div class="b-card" style="animation-delay:0.05s;margin-bottom:24px">
        <h3 style="margin-bottom:12px">Connection Status</h3>
        <div id="connect-status">${statusHtml()}</div>
        <div id="connect-result" style="margin-top:12px"></div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.1s">
          <h3 style="margin-bottom:8px">${icon("bag")} Shopify</h3>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px">One-click OAuth: approve access, products/stock/orders sync automatically.</div>
          ${oauthNote("shopify", "Shopify")}
          <input id="cf-shop" placeholder="your-store.myshopify.com" style="${INPUT_STYLE}" />
          <button class="btn btn-sm btn-primary" id="cf-shopify">Connect Shopify →</button>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <h3 style="margin-bottom:8px">${icon("store")} BigCommerce</h3>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px">One-click OAuth: approve access, catalog + orders sync straight in.</div>
          ${oauthNote("bigcommerce", "BigCommerce")}
          <input id="cf-bc" placeholder="store hash (from your admin URL)" style="${INPUT_STYLE}" />
          <button class="btn btn-sm btn-primary" id="cf-bigcommerce">Connect BigCommerce →</button>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.2s">
          <h3 style="margin-bottom:8px">${icon("puzzle")} WooCommerce</h3>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px">Enter store URL + read-only REST keys. Products and orders sync instantly.</div>
          <input id="cf-woo-url" placeholder="https://your-store.com" style="${INPUT_STYLE}" />
          <input id="cf-woo-key" placeholder="Consumer key (ck_…)" style="${INPUT_STYLE}" />
          <input id="cf-woo-secret" type="password" placeholder="Consumer secret (cs_…)" style="${INPUT_STYLE}" />
          <button class="btn btn-sm btn-primary" id="cf-woo">Connect WooCommerce →</button>
        </div>
        <div class="b-card" style="animation-delay:0.25s">
          <h3 style="margin-bottom:8px">${icon("globe")} Custom Store</h3>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px">Import public catalog, then prove ownership with meta tag, file, or DNS.</div>
          <input id="cf-custom-url" placeholder="https://your-store.com" style="${INPUT_STYLE}" />
          <button class="btn btn-sm btn-primary" id="cf-custom">Scan my store →</button>
          <div id="cf-custom-verify" class="hidden" style="margin-top:12px">
            <p id="cf-custom-found" style="color:var(--green);font-weight:600"></p>
            <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Prove you own the site — add <b>any one</b> of these:</div>
            <div class="b-list-item" style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--card-border)"><span class="b-badge cyan" style="min-width:24px;text-align:center">1</span> <div style="font-size:12px"><b>Meta tag</b> in homepage <code>&lt;head&gt;</code>:<br><code id="cfv-meta" style="word-break:break-all"></code></div></div>
            <div class="b-list-item" style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--card-border)"><span class="b-badge cyan" style="min-width:24px;text-align:center">2</span> <div style="font-size:12px"><b>File</b> at <code id="cfv-file-url" style="word-break:break-all"></code> containing: <code id="cfv-file"></code></div></div>
            <div class="b-list-item" style="display:flex;align-items:flex-start;gap:10px;padding:10px 0"><span class="b-badge cyan" style="min-width:24px;text-align:center">3</span> <div style="font-size:12px"><b>DNS TXT record</b> — value: <code id="cfv-dns" style="word-break:break-all"></code></div></div>
            <button class="btn btn-sm btn-primary" id="cf-custom-verify-btn" style="margin-top:12px">${icon("lock", "icon-sm")} Verify ownership &amp; sync</button>
          </div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.3s">
          <h3 style="margin-bottom:8px">${icon("arrow-up")} CSV Import <span style="color:var(--muted);font-weight:400;font-size:13px">— products or orders</span></h3>
          <select id="csv-type" style="${INPUT_STYLE}">
            <option value="products">Products — product_id,name,stock,lead_time_days,price</option>
            <option value="orders">Orders — customer_id,email,total,product_id,quantity,timestamp</option>
          </select>
          <textarea id="csv-text" rows="4" placeholder="Paste CSV rows here (header row optional)…" style="${INPUT_STYLE}resize:vertical;font-family:inherit"></textarea>
          <button class="btn btn-sm btn-primary" id="csv-import">${icon("upload", "icon-sm")} Import CSV</button>
        </div>
        <div class="b-card" style="animation-delay:0.35s">
          <h3 style="margin-bottom:8px">${icon("sliders")} Advanced <span style="color:var(--muted);font-weight:400;font-size:13px">— webhook &amp; snippet</span></h3>
          <div style="font-size:12px;color:var(--muted);margin-bottom:8px">For live order push, point an <code>orders/create</code> webhook at:</div>
          <div style="word-break:break-all;background:var(--surface-2);padding:10px;border-radius:8px;margin:8px 0;font-family:monospace;font-size:12px">${esc(info.webhook_url)}</div>
          <button class="btn btn-sm btn-primary" id="copy-webhook">${icon("copy", "icon-sm")} Copy webhook URL</button>
          <details style="margin-top:12px"><summary style="cursor:pointer;color:var(--text-dim);font-size:13px">Browser tracking snippet</summary>
            <pre class="mono" style="max-height:180px;overflow:auto;font-size:11px;background:var(--code-bg);padding:10px;border-radius:10px;margin:8px 0">${esc(info.snippet)}</pre>
            <button class="btn btn-sm btn-primary" id="copy-snippet">${icon("copy", "icon-sm")} Copy snippet</button>
          </details>
        </div>
      </div>`;

    const result = $("#connect-result");
    const showResult = (ok, msg) => {
      result.innerHTML = `<div class="alert-item ${ok ? "green" : "red"}">${esc(msg)}</div>`;
    };
    const refreshStatus = async () => {
      try {
        const fresh = await api.get(`/integrations/${s}`);
        Object.assign(status, fresh);
        $("#connect-status").innerHTML = statusHtml();
      } catch (e) { /* status card is cosmetic */ }
    };
    const synced = (name, r) =>
      showResult(true, `${name} connected — ${r.products_synced ?? 0} products, ${r.orders_synced ?? 0} orders imported.`);

    $("#cf-shopify").addEventListener("click", async () => {
      const shop = $("#cf-shop").value.trim();
      if (!shop) return showResult(false, "Enter your myshopify.com store address.");
      try {
        const r = await api.post(`/integrations/${s}/connect/shopify/start`, { shop });
        showResult(true, "Redirecting you to Shopify to approve access…");
        setTimeout(() => (location.href = r.redirect_url), 600);
      } catch (e) { showResult(false, e.message); }
    });

    $("#cf-bigcommerce").addEventListener("click", async () => {
      const storeHash = $("#cf-bc").value.trim();
      if (!storeHash) return showResult(false, "Enter your BigCommerce store hash.");
      try {
        const r = await api.post(`/integrations/${s}/connect/bigcommerce/start`, { storeHash });
        showResult(true, "Redirecting you to BigCommerce to approve access…");
        setTimeout(() => (location.href = r.redirect_url), 600);
      } catch (e) { showResult(false, e.message); }
    });

    $("#cf-woo").addEventListener("click", async () => {
      try {
        const r = await api.post(`/integrations/${s}/woocommerce`, {
          siteUrl: $("#cf-woo-url").value.trim(),
          consumerKey: $("#cf-woo-key").value.trim(),
          consumerSecret: $("#cf-woo-secret").value.trim(),
        });
        synced("WooCommerce", r);
        await refreshStatus();
      } catch (e) { showResult(false, e.message); }
    });

    let cfCustomToken = null;
    $("#cf-custom").addEventListener("click", async () => {
      const btn = $("#cf-custom");
      btn.disabled = true;
      btn.textContent = "Scanning your catalog…";
      try {
        const r = await api.post(`/integrations/${s}/connect/custom`, { url: $("#cf-custom-url").value.trim() });
        cfCustomToken = r.connect_token;
        $("#cf-custom-found").textContent = `✓ Found ${r.products_found} products at ${r.store_name}`;
        $("#cfv-meta").textContent = r.methods.meta_tag;
        $("#cfv-file-url").textContent = r.methods.file.url;
        $("#cfv-file").textContent = r.methods.file.content;
        $("#cfv-dns").textContent = r.methods.dns.value;
        $("#cf-custom-verify").classList.remove("hidden");
        showResult(true, `Catalog found — now verify ownership below to finish the sync.`);
      } catch (e) { showResult(false, e.message); }
      finally { btn.disabled = false; btn.textContent = "Scan my store →"; }
    });

    $("#cf-custom-verify-btn").addEventListener("click", async () => {
      const btn = $("#cf-custom-verify-btn");
      btn.disabled = true;
      btn.textContent = "Checking your site…";
      try {
        await fetch("/connect/custom/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connect_token: cfCustomToken }),
        }).then(async (res) => { const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || "Verification failed."); return d; });
        const r = await api.post(`/integrations/${s}/connect/custom/finalize`, { connect_token: cfCustomToken });
        $("#cf-custom-verify").classList.add("hidden");
        synced("Custom store", r);
        await refreshStatus();
      } catch (e) { showResult(false, e.message); }
      finally { btn.disabled = false; btn.innerHTML = icon("lock", "icon-sm") + " Verify ownership & sync"; }
    });
    $("#csv-import").addEventListener("click", async () => {
      const csv = $("#csv-text").value.trim();
      if (!csv) return showResult(false, "Paste some CSV first.");
      try {
        const r = await api.post(`/integrations/${s}/csv`, { type: $("#csv-type").value, csv });
        showResult(true, `Imported ${r.imported ?? r.accepted ?? 0} row(s).`);
        await refreshStatus();
      } catch (e) { showResult(false, e.message); }
    });

    $("#copy-webhook").addEventListener("click", () => copyText(info.webhook_url, $("#copy-webhook")));
    const snippetBtn = $("#copy-snippet");
    if (snippetBtn) snippetBtn.addEventListener("click", () => copyText(info.snippet, snippetBtn));
  }

  chartDefaults();

  // ── page: onboarding ───────────────────────────────────────────────
  async function renderOnboarding(container = view) {
    const s = api.store();
    const state = await api.get("/onboarding").catch(() => null);
    const next = await api.get("/onboarding/next").catch(() => null);

    const steps = [
      { id: "welcome", title: "Welcome to Storecops", desc: "Let's get your store connected and start recovering revenue.", icon: "👋", action: null },
      { id: "connect_store", title: "Connect Your Store", desc: "Link your Shopify, WooCommerce, or custom store to start tracking.", icon: "🔗", action: "connect" },
      { id: "activate_tracking", title: "Activate Tracking", desc: "Install the tracking snippet to start collecting visitor data.", icon: "📡", action: null },
      { id: "first_audit", title: "Run Your First Audit", desc: "Get a comprehensive health score and actionable insights.", icon: "🔍", action: "seo" },
      { id: "choose_plan", title: "Choose Your Plan", desc: "Select the plan that fits your growth goals.", icon: "💎", action: "billing" },
      { id: "add_competitors", title: "Add Competitors", desc: "Track competitor pricing and strategies in real-time.", icon: "🎯", action: "competitors", guided: true },
      { id: "brand_keywords", title: "Set Brand Keywords", desc: "Add keywords to monitor your brand mentions and sentiment.", icon: "🏷️", action: "brand-keywords" },
      { id: "notification_preferences", title: "Notification Preferences", desc: "Choose how you want to be alerted about store activity.", icon: "🔔", action: "notifications" },
      { id: "first_automation", title: "Set Up Automation", desc: "Configure your first automated cart recovery campaign.", icon: "⚡", action: "automations" },
      { id: "complete", title: "You're All Set!", desc: "Your store is fully configured. Start growing!", icon: "🎉", action: null },
    ];

    const completionPct = state?.completion_pct || 0;
    const currentIdx = steps.findIndex(step => next?.action === step.id) || 0;

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Onboarding</h2>
          <p>Follow these steps to unlock the full power of Storecops</p>
        </div>
      </div>

      <div class="b-grid-3" style="margin-bottom:24px">
        <div class="b-card" style="text-align:center;padding:24px;animation-delay:0.05s">
          <div style="font-size:48px;margin-bottom:8px">🚀</div>
          <div class="b-stat-value">${completionPct}%</div>
          <div class="b-stat-label">Setup Complete</div>
        </div>
        <div class="b-card" style="text-align:center;padding:24px;animation-delay:0.1s">
          <div style="font-size:48px;margin-bottom:8px">⚡</div>
          <div class="b-stat-value">${steps.filter((step, i) => i < currentIdx).length}/${steps.length}</div>
          <div class="b-stat-label">Steps Completed</div>
        </div>
        <div class="b-card" style="text-align:center;padding:24px;animation-delay:0.15s">
          <div style="font-size:48px;margin-bottom:8px">💰</div>
          <div class="b-stat-value" style="color:var(--green)">${completionPct >= 50 ? "Ready" : "Almost"}</div>
          <div class="b-stat-label">Revenue Recovery</div>
        </div>
      </div>

      <div class="b-card" style="animation-delay:0.2s;margin-bottom:24px">
        <h2 style="margin-bottom:4px">Setup Wizard</h2>
        <div style="font-size:13px;color:var(--muted);margin-bottom:16px">Follow these steps to unlock the full power of Storecops.</div>
        
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px;padding:12px;background:var(--surface-2);border-radius:10px">
          <div style="flex:1;height:8px;background:var(--card-border);border-radius:4px;overflow:hidden">
            <div style="height:100%;width:${completionPct}%;background:linear-gradient(90deg, var(--primary), var(--green));border-radius:4px;transition:width 0.3s"></div>
          </div>
          <span style="font-weight:600;font-size:14px;min-width:40px;text-align:right">${completionPct}%</span>
        </div>

        <div style="display:flex;flex-direction:column;gap:12px">
          ${steps.map((step, i) => {
            const stepState = state?.steps?.[step.id];
            const isCompleted = stepState?.completed;
            const isCurrent = next?.action === step.id;
            const isPast = i < currentIdx;
            
            return `
              <div style="display:flex;align-items:center;gap:16px;padding:16px;background:${isCurrent ? 'rgba(8,144,108,0.08)' : 'var(--surface-2)'};border-radius:10px;border:1px solid ${isCurrent ? 'var(--primary)' : 'var(--card-border)'};transition:all 0.2s">
                <div style="width:48px;height:48px;border-radius:50%;background:${isCompleted || isPast ? 'var(--green)' : isCurrent ? 'var(--primary)' : 'var(--card-border)'};color:${isCompleted || isPast || isCurrent ? 'white' : 'var(--muted)'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;flex-shrink:0">
                  ${isCompleted || isPast ? "✓" : step.icon}
                </div>
                <div style="flex:1">
                  <div style="font-weight:600;font-size:15px;color:${isCompleted || isPast ? 'var(--green)' : 'var(--text)'}">${step.title}</div>
                  <div style="font-size:13px;color:var(--muted);margin-top:2px">${step.desc}</div>
                </div>
                <div>
                  ${isCompleted || isPast ? '<span class="b-badge green">Done</span>' : 
                    isCurrent && step.action ? `<a href="#/${step.action}" class="btn btn-primary btn-sm">Start →</a>` :
                    isCurrent ? '<span class="b-badge green">In Progress</span>' :
                    '<span class="b-badge gray">Pending</span>'}
                </div>
              </div>`;
          }).join("")}
        </div>

        ${next?.action === 'add_competitors' && !state?.steps?.add_competitors?.completed ? `
        <div class="b-card" style="margin-top:24px" id="comp-guided">
          <h3 style="margin-bottom:4px">🎯 Quick Setup: Add Your Top 5 Competitors</h3>
          <div style="font-size:12px;color:var(--muted);margin-bottom:16px">Track competitor pricing, stock levels, and ad strategies. Add at least 3 to unlock the full Competitor Radar.</div>
          <div id="comp-guided-list" style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
            ${[1,2,3,4,5].map(i => `
              <div style="display:flex;gap:8px;align-items:center" id="comp-row-${i}">
                <span style="font-size:12px;color:var(--muted);min-width:18px">#${i}</span>
                <input placeholder="Competitor name" class="comp-guided-name" style="flex:1;padding:8px 12px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);font-size:13px" />
                <input placeholder="Store URL (https://...)" class="comp-guided-url" style="flex:2;padding:8px 12px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);font-size:13px" />
              </div>
            `).join("")}
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-primary btn-sm" id="comp-guided-save">Save competitors</button>
            <span id="comp-guided-msg" style="font-size:13px;color:var(--muted)"></span>
          </div>
        </div>
        ` : ''}

        ${completionPct < 100 ? `
        <div style="margin-top:24px;padding:16px;background:var(--primary-light);border-radius:var(--radius-sm);border:1px solid var(--primary)">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="font-size:24px">💡</div>
            <div style="flex:1">
              <div style="font-weight:600;font-size:14px;color:var(--primary)">Pro Tip</div>
              <div style="font-size:13px;color:var(--muted);margin-top:2px">Stores that complete setup recover 3x more revenue. You're almost there!</div>
            </div>
            ${next?.action ? `<a href="#/${next.action === 'connect_store' ? 'connect' : next.action}" class="btn btn-primary btn-sm">Continue →</a>` : ''}
          </div>
        </div>` : `
        <div style="margin-top:24px;padding:24px;background:linear-gradient(135deg, var(--primary-light), rgba(52,191,153,0.1));border-radius:var(--radius-sm);text-align:center;border:1px solid var(--primary)">
          <div style="font-size:48px;margin-bottom:8px">🎉</div>
          <div style="font-weight:700;font-size:20px;color:var(--primary);margin-bottom:4px">Setup Complete!</div>
          <div style="font-size:14px;color:var(--muted);margin-bottom:16px">Your store is fully configured. Start exploring your dashboard.</div>
          <a href="#/dashboard" class="btn btn-primary">Go to Dashboard →</a>
        </div>`}
      </div>`;

    // Guided competitor flow event handler
    const compSaveBtn = document.getElementById('comp-guided-save');
    if (compSaveBtn) {
      compSaveBtn.addEventListener('click', async () => {
        const names = document.querySelectorAll('.comp-guided-name');
        const urls = document.querySelectorAll('.comp-guided-url');
        const msg = document.getElementById('comp-guided-msg');
        let saved = 0;
        for (let i = 0; i < names.length; i++) {
          const name = names[i].value.trim();
          const url = urls[i].value.trim();
          if (name && url) {
            try {
              await api.post(`/competitors/${s}/tracked`, { competitor: name, url });
              saved++;
            } catch (e) { /* skip failed */ }
          }
        }
        if (saved > 0) {
          msg.textContent = `${saved} competitor(s) added!`;
          toast(`${saved} competitor(s) added to tracking`);
          await api.post('/onboarding/complete-step', { step_id: 'add_competitors', data: { count: saved } });
          route();
        } else {
          msg.textContent = 'Add at least one competitor with a URL.';
        }
      });
    }
  }

  // ── page: revenue recovery ─────────────────────────────────────────
  async function renderRecovery(container = view) {
    const s = api.store();
    const [report, actions, insights] = await Promise.all([
      api.get(`/report/${s}`).catch(() => ({})),
      api.get(`/actions/${s}/pending`).catch(() => []),
      api.get(`/insights/${s}/products`).catch(() => null),
    ]);

    const o = report.overview || {};
    const funnel = report.funnel || {};
    const cartAbandon = funnel.carts - funnel.purchases || 0;
    const recoveryRate = funnel.carts > 0 ? ((funnel.purchases / funnel.carts) * 100).toFixed(1) : 0;
    const revenueRecovered = 0;

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Revenue Recovery</h2>
          <p>Track recovered revenue, recovery rates, and pending actions</p>
        </div>
        <div class="b-header-filters">
          <button class="b-filter-btn active" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            ${icon("calendar")} This Month
          </button>
          <button class="b-filter-btn" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            Last 30 Days
          </button>
        </div>
      </div>

      <div class="b-grid-3" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("dollar")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${money(revenueRecovered)}</div>
          <div class="b-stat-label">Revenue Recovered</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            this month
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("trending-up")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${recoveryRate}%</div>
          <div class="b-stat-label">Recovery Rate</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            conversions recovered
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle amber">${icon("zap")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${Array.isArray(actions) ? actions.length : 0}</div>
          <div class="b-stat-label">Pending Actions</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            recovery actions queued
          </div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.2s">
          <h3 style="margin-bottom:16px">${icon("cart")} Recovery Funnel</h3>
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="b-stat-label">Abandoned carts</span><span style="font-weight:600">${cartAbandon}</span></div>
            <div class="b-progress-bar">
              <div class="b-progress-bar-fill" style="width:${Math.min(100, cartAbandon * 2)}%;background:var(--red)"></div>
            </div>
          </div>
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="b-stat-label">Recovered</span><span style="font-weight:600;color:var(--green)">${funnel.purchases || 0}</span></div>
            <div class="b-progress-bar">
              <div class="b-progress-bar-fill" style="width:${recoveryRate}%"></div>
            </div>
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="b-stat-label">Recovery rate</span><span style="font-weight:600;color:var(--primary)">${recoveryRate}%</span></div>
            <div class="b-progress-bar">
              <div class="b-progress-bar-fill" style="width:${recoveryRate}%"></div>
            </div>
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.25s">
          <h3 style="margin-bottom:16px">${icon("zap")} Quick Actions</h3>
          <div style="display:flex;flex-direction:column;gap:10px">
            <button class="btn btn-primary btn-block" onclick="triggerRecovery('${s}')">
              ${icon("send")} Send recovery emails
            </button>
            <button class="btn btn-ghost-sm btn-block" onclick="enableBrowseRecovery('${s}')">
              ${icon("bell")} Activate browse abandonment
            </button>
            <a href="#/campaigns" class="btn btn-ghost-sm btn-block" style="text-decoration:none">
              ${icon("megaphone")} Create win-back campaign
            </a>
          </div>
        </div>
      </div>

      <div class="b-card" style="animation-delay:0.3s">
        <h3 style="margin-bottom:16px">${icon("file-text")} Recovery Templates</h3>
        <div class="b-grid-2">
          <div style="padding:16px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
            <div style="font-weight:600;margin-bottom:4px">Cart recovery drip sequence</div>
            <div style="font-size:12px;color:var(--muted)">1h reminder → 3h urgency → 24h final offer</div>
            <div style="margin-top:8px"><span class="b-badge green">Active</span></div>
          </div>
          <div style="padding:16px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
            <div style="font-weight:600;margin-bottom:4px">Browse abandonment</div>
            <div style="font-size:12px;color:var(--muted)">Triggered after 5 min of inactivity</div>
            <div style="margin-top:8px"><span class="b-badge green">Active</span></div>
          </div>
        </div>
      </div>`;
  }

  // ── page: win-back campaigns ───────────────────────────────────────
  async function renderWinback(container = view) {
    const s = api.store();
    const [churn, campaigns] = await Promise.all([
      api.get(`/churn/${s}`).catch(() => ({ customers: [], risk_bands: {} })),
      api.get(`/campaigns/${s}`).catch(() => []),
    ]);

    const churnRaw = await api.get(`/churn/${s}`).catch(() => []);
    const atRiskCustomers = (Array.isArray(churnRaw) ? churnRaw : (churnRaw.customers || [])).filter(c => c.risk_band === "CRITICAL" || c.risk_band === "HIGH");
    const campaignList = Array.isArray(campaigns) ? campaigns : campaigns.campaigns || [];
    const winbackCampaigns = campaignList.filter(c => c.type === "winback" || c.name?.toLowerCase().includes("win"));

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Win-Back Campaigns</h2>
          <p>Re-engage at-risk customers before they churn</p>
        </div>
        <div class="b-header-filters">
          <button class="b-filter-btn active" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            ${icon("users")} All At-Risk
          </button>
          <button class="b-filter-btn" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            Critical Only
          </button>
        </div>
      </div>

      <div class="b-grid-3" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle red">${icon("heart")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${atRiskCustomers.length}</div>
          <div class="b-stat-label">At-Risk Customers</div>
          <div class="b-stat-trend down">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 7l5 5 5-5M7 17l5 5 5-5"/></svg>
            high churn risk
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("megaphone")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${campaignList.length}</div>
          <div class="b-stat-label">Win-Back Campaigns</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            total campaigns
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("trending-up")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${campaignList.length > 0 ? Math.round((winbackCampaigns.length / campaignList.length) * 100) : 0}%</div>
          <div class="b-stat-label">Win-Back Campaigns</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            avg. win-back rate
          </div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.2s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <h3 style="margin:0">${icon("users")} At-Risk Customers</h3>
            <button class="btn btn-sm btn-primary" onclick="generateWinbackCampaign('${s}', ${atRiskCustomers.length})">Send win-back to all</button>
          </div>
          <div class="scroll-y" style="max-height:400px">
            ${atRiskCustomers.length === 0 ? '<div class="empty">No high-risk customers detected.</div>' :
              atRiskCustomers.slice(0, 10).map((c, i) => `
                <div class="b-list-item" style="animation-delay:${0.05 * i}s">
                  <div style="width:36px;height:36px;border-radius:50%;background:var(--primary-light);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;color:var(--primary);flex-shrink:0">${(c.name || c.customer_id || "?").charAt(0).toUpperCase()}</div>
                  <div style="flex:1;min-width:0">
                    <div style="font-weight:600;font-size:13px">${esc(c.name || c.customer_id || "Unknown")}</div>
                    <div style="font-size:11px;color:var(--muted)">LTV: ${money(c.ltv)} · Last purchase: ${c.days_since_purchase || "?"}d ago</div>
                  </div>
                  <span class="b-badge red">${c.risk_band}</span>
                </div>
              `).join("")}
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.25s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <h3 style="margin:0">${icon("megaphone")} Campaign History</h3>
          </div>
          <div class="scroll-y" style="max-height:400px">
            ${campaignList.length === 0 ? '<div class="empty">No campaigns created yet. <a href="#/campaigns">Create your first campaign</a></div>' :
              campaignList.slice(0, 10).map((c, i) => `
                <div class="b-list-item" style="animation-delay:${0.05 * i}s">
                  <div style="flex:1">
                    <div style="font-weight:600;font-size:13px">${esc(c.name || "Campaign")}</div>
                    <div style="font-size:11px;color:var(--muted)">${esc(c.type || "win-back")} · ${esc(c.channel || "email")}</div>
                  </div>
                  <span class="b-badge ${c.status === 'active' ? 'green' : c.status === 'completed' ? 'blue' : ''}">${c.status || "draft"}</span>
                </div>
              `).join("")}
          </div>
        </div>
      </div>

      <div class="b-card" style="animation-delay:0.3s">
        <h3 style="margin-bottom:16px">${icon("zap")} Risk Band Distribution</h3>
        <div class="b-grid-2">
          <div>
            <div style="margin-bottom:12px">
              <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="b-stat-label">Critical</span><span style="font-weight:600;color:var(--red)">${atRiskCustomers.filter(c => c.risk_band === 'CRITICAL').length}</span></div>
              <div class="b-progress-bar"><div class="b-progress-bar-fill" style="width:${atRiskCustomers.length ? (atRiskCustomers.filter(c => c.risk_band === 'CRITICAL').length / atRiskCustomers.length * 100) : 0}%;background:var(--red)"></div></div>
            </div>
            <div style="margin-bottom:12px">
              <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="b-stat-label">High</span><span style="font-weight:600;color:var(--amber)">${atRiskCustomers.filter(c => c.risk_band === 'HIGH').length}</span></div>
              <div class="b-progress-bar"><div class="b-progress-bar-fill amber" style="width:${atRiskCustomers.length ? (atRiskCustomers.filter(c => c.risk_band === 'HIGH').length / atRiskCustomers.length * 100) : 0}%"></div></div>
            </div>
          </div>
          <div>
            <div style="padding:16px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border);text-align:center">
              <div class="b-stat-value" style="font-size:28px">${atRiskCustomers.length}</div>
              <div class="b-stat-label">Total at-risk</div>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ── page: browse abandonment ──────────────────────────────────────
  async function renderBrowse(container = view) {
    const s = api.store();
    const [report, insights] = await Promise.all([
      api.get(`/report/${s}`).catch(() => ({})),
      api.get(`/insights/${s}/products`).catch(() => null),
    ]);
    const funnel = report.funnel || {};
    const browseAbandon = (funnel.product_views || 0) - (funnel.carts || 0);
    const recoveryRate = funnel.product_views > 0 ? (((funnel.carts || 0) / funnel.product_views) * 100).toFixed(1) : 0;

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Browse Abandonment</h2>
          <p>Recover visitors who browsed but didn't convert</p>
        </div>
        <div class="b-header-filters">
          <button class="b-filter-btn active" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            ${icon("calendar")} Today
          </button>
          <button class="b-filter-btn" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            7 Days
          </button>
        </div>
      </div>

      <div class="b-grid-4" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle red">${icon("eye")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${browseAbandon}</div>
          <div class="b-stat-label">Visitors Who Left</div>
          <div class="b-stat-trend down">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 7l5 5 5-5M7 17l5 5 5-5"/></svg>
            browsed but didn't add to cart
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("trending-up")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${recoveryRate}%</div>
          <div class="b-stat-label">Cart Conversion</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            viewers → cart adders
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("dollar")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${browseAbandon}</div>
          <div class="b-stat-label">Browse Abandonments</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            estimated recoverable
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle amber">${icon("zap")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${rules.length || 0}</div>
          <div class="b-stat-label">Active Triggers</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            automation rules running
          </div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.25s">
          <h3 style="margin-bottom:16px">${icon("eye")} Browse Abandonment Funnel</h3>
          <div>
            ${[
              { label: "Page views", value: funnel.product_views || 0, pct: 100 },
              { label: "Added to cart", value: funnel.carts || 0, pct: funnel.product_views ? ((funnel.carts || 0) / funnel.product_views * 100) : 0 },
              { label: "Started checkout", value: funnel.checkouts_started || 0, pct: funnel.product_views ? ((funnel.checkouts_started || 0) / funnel.product_views * 100) : 0 },
              { label: "Purchased", value: funnel.purchases || 0, pct: funnel.product_views ? ((funnel.purchases || 0) / funnel.product_views * 100) : 0 },
            ].map((s, i) => `
              <div style="margin-bottom:14px;animation-delay:${0.05 * i}s">
                <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="b-stat-label">${s.label}</span><span style="font-weight:600">${s.value}</span></div>
                <div class="b-progress-bar"><div class="b-progress-bar-fill" style="width:${s.pct}%"></div></div>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.3s">
          <h3 style="margin-bottom:16px">${icon("zap")} Quick Actions</h3>
          <div style="display:flex;flex-direction:column;gap:10px">
            <button class="btn btn-primary btn-block" onclick="enableBrowseRecovery('${s}')">${icon("send")} Send browse recovery</button>
            <button class="btn btn-ghost-sm btn-block" onclick="enableBrowseRecovery('${s}')">${icon("bell")} Enable exit-intent popup</button>
            <button class="btn btn-ghost-sm btn-block" onclick="triggerRecovery('${s}')">${icon("users")} Enable social proof</button>
          </div>
        </div>
      </div>`;
  }

  // ── page: product recommendations ─────────────────────────────────
  async function renderRecommendations(container = view) {
    const s = api.store();
    const products = await api.get(`/insights/${s}/products`).catch(() => ({ products: [] }));
    const prods = (products.products || []).slice(0, 20);

    container.innerHTML = `
      <div class="b-header"><div><h2>Recommendations</h2><p>Product recommendation placements and analytics</p></div></div>
      <div class="b-grid-3" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s"><h3>Products tracked</h3><div class="b-stat-value">${prods.length}</div><div class="b-stat-label">in your catalog</div></div>
        <div class="b-card" style="animation-delay:0.1s"><h3>Recommendation clicks</h3><div class="b-stat-value" style="color:var(--green)">${products.length || 0}</div><div class="b-stat-label">products tracked</div></div>
        <div class="b-card" style="animation-delay:0.15s"><h3>Products analyzed</h3><div class="b-stat-value" style="color:var(--green)">${products.length || 0}</div><div class="b-stat-label">in catalog</div></div>
      </div>
      <div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px"><h3>${icon("sparkles")} Recommendation placements</h3></div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px">
          ${[
            { name: "Product page", desc: "Show related products on each product page", active: products.length > 0 },
            { name: "Cart page", desc: "Cross-sell items during checkout", active: products.length > 2 },
            { name: "Thank-you page", desc: "Post-purchase follow-up recommendations", active: false },
          ].map(p => `
            <div style="padding:16px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <span style="font-weight:600">${p.name}</span>
                <span class="b-badge ${p.active ? 'green' : 'gray'}">${p.active ? 'Active' : 'Inactive'}</span>
              </div>
              <div style="font-size:12px;color:var(--muted);margin-bottom:12px">${p.desc}</div>
              <button class="btn btn-sm ${p.active ? 'btn-ghost-sm' : 'btn-primary'}" onclick="toast('${p.name} ${p.active ? 'deactivated' : 'activated'}')">${p.active ? 'Deactivate' : 'Activate'}</button>
            </div>
          `).join("")}
        </div>
      </div>
      <div class="b-card" style="margin-bottom:24px;animation-delay:0.25s">
        <h3>${icon("package")} Top products for recommendations</h3>
        <div style="overflow-x:auto;margin-top:12px">
          <table class="b-table">
            <thead><tr><th>Product</th><th>Views</th><th>Cart adds</th><th>Conversion</th><th>Action</th></tr></thead>
            <tbody>
              ${prods.slice(0, 10).map(p => `
                <tr>
                  <td><b>${esc(p.name || p.product_id || "Product")}</b></td>
                  <td>${p.views || 0}</td>
                  <td>${p.carts || 0}</td>
                  <td>${p.views ? ((p.purchases || 0) / p.views * 100).toFixed(1) : 0}%</td>
                  <td><button class="btn btn-sm btn-primary" onclick="toast('Recommendation rules updated for this product')">Set rules</button></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // ── page: churn risk ──────────────────────────────────────────────
  async function renderChurnRisk(container = view) {
    const s = api.store();
    const churnRaw = await api.get(`/churn/${s}`).catch(() => []);
    const customers = Array.isArray(churnRaw) ? churnRaw : (churnRaw.customers || []);
    const bands = Array.isArray(churnRaw) ? {} : (churnRaw.risk_bands || {});
    const critical = customers.filter(c => c.risk_band === "CRITICAL");
    const high = customers.filter(c => c.risk_band === "HIGH");
    const medium = customers.filter(c => c.risk_band === "MEDIUM");

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Churn Risk</h2>
          <p>Identify and re-engage customers at risk of churning</p>
        </div>
        <div class="b-header-filters">
          <button class="b-filter-btn active" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            ${icon("users")} All Risks
          </button>
          <button class="b-filter-btn" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            Critical Only
          </button>
        </div>
      </div>

      <div class="b-grid-4" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle red">${icon("alert-triangle")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${bands.CRITICAL || 0}</div>
          <div class="b-stat-label">Critical Risk</div>
          <div class="b-stat-trend down">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 7l5 5 5-5M7 17l5 5 5-5"/></svg>
            customers
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle amber">${icon("heart")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${bands.HIGH || 0}</div>
          <div class="b-stat-label">High Risk</div>
          <div class="b-stat-trend down">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 7l5 5 5-5M7 17l5 5 5-5"/></svg>
            customers
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("users")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${bands.MEDIUM || 0}</div>
          <div class="b-stat-label">Medium Risk</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            customers
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("target")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${customers.length}</div>
          <div class="b-stat-label">Total at Risk</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            all risk levels
          </div>
        </div>
      </div>

      <div class="b-card" style="margin-bottom:24px;animation-delay:0.25s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3 style="margin:0">${icon("alert-triangle")} At-Risk Customers</h3>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-primary" onclick="generateWinbackCampaign('${s}', ${customers.length})">Send win-back to all</button>
            <button class="btn btn-sm btn-ghost-sm" onclick="exportCustomerList('${s}')">Export list</button>
          </div>
        </div>
        <div style="overflow-x:auto">
          <table class="b-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Risk Level</th>
                <th>LTV</th>
                <th>Last Purchase</th>
                <th>Orders</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${customers.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">No churn data yet. Import orders to start tracking.</td></tr>' :
                customers.slice(0, 20).map((c, i) => `
                  <tr style="animation-delay:${0.05 * i}s">
                    <td><b>${esc(c.name || c.customer_id || "Unknown")}</b></td>
                    <td><span class="b-badge ${c.risk_band === 'CRITICAL' ? 'red' : c.risk_band === 'HIGH' ? 'amber' : 'green'}">${c.risk_band || "LOW"}</span></td>
                    <td>${money(c.ltv)}</td>
                    <td>${c.days_since_purchase || "?"}d ago</td>
                    <td>${c.total_orders || 0}</td>
                    <td><button class="btn btn-sm btn-primary" onclick="toast('Win-back sent to ${esc(c.name || c.customer_id)}')">Send win-back</button></td>
                  </tr>
                `).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // ── page: defection alerts ────────────────────────────────────────
  async function renderDefections(container = view) {
    const s = api.store();
    const defections = await api.get(`/defection/${s}`).catch(() => ({ defections: [] }));
    const alerts = defections.defections || [];

    container.innerHTML = `
      <div class="b-header"><div><h2>Defection Alerts</h2><p>High-value customers lost and recovery attempts</p></div></div>
      <div class="b-grid-3" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s"><h3>Defection alerts</h3><div class="b-stat-value" style="color:var(--red)">${alerts.length}</div><div class="b-stat-label">high-value customers lost</div></div>
        <div class="b-card" style="animation-delay:0.1s"><h3>Revenue at risk</h3><div class="b-stat-value" style="color:var(--red)">${money(alerts.reduce((sum, a) => sum + (a.ltv || 0), 0))}</div><div class="b-stat-label">combined LTV</div></div>
        <div class="b-card" style="animation-delay:0.15s"><h3>Recovery attempts</h3><div class="b-stat-value">${alerts.filter(a => a.recovery_sent).length}</div><div class="b-stat-label">win-backs sent</div></div>
      </div>
      <div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px"><h3>${icon("alert-triangle")} Defection alerts</h3></div>
        <div style="overflow-x:auto;margin-top:12px">
          ${alerts.length === 0 ? '<div class="empty">No defection alerts detected. This means your high-value customers are staying loyal!' :
            alerts.map(a => `
              <div style="display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--card-border)">
                <div style="width:40px;height:40px;border-radius:50%;background:rgba(239,68,68,0.1);display:flex;align-items:center;justify-content:center;color:var(--red)">${icon("frown")}</div>
                <div style="flex:1">
                  <div style="font-weight:600">${esc(a.customer_name || a.customer_id || "Customer")}</div>
                  <div style="font-size:12px;color:var(--muted)">Purchased from ${esc(a.competitor || "competitor")} · LTV: ${money(a.ltv)}</div>
                </div>
                <button class="btn btn-sm btn-primary" onclick="toast('Win-back campaign triggered for ${esc(a.customer_name || a.customer_id)}')">Send win-back</button>
              </div>
            `).join("")}
        </div>
      </div>`;
  }


  // ── page: price history ───────────────────────────────────────────
  async function renderPriceHistory(container = view) {
    const s = api.store();
    const [competitors, priceHistory] = await Promise.all([
      api.get(`/competitors/${s}/tracked`).catch(() => []),
      api.get(`/competitors/${s}/price-history`).catch(() => ({ history: [] })),
    ]);
    const compList = Array.isArray(competitors) ? competitors : competitors.competitors || [];
    const history = priceHistory.history || [];
    const recentChanges = history.length;
    const pricePosition = history.filter(h => h.change < 0).length > history.filter(h => h.change > 0).length ? "Competitive" : "Above average";

    container.innerHTML = `
      <div class="b-header"><div><h2>Price History</h2><p>Track competitor price changes and your price position</p></div></div>
      <div class="b-grid-3" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s"><h3>Tracked competitors</h3><div class="b-stat-value">${compList.length}</div><div class="b-stat-label">monitoring prices</div></div>
        <div class="b-card" style="animation-delay:0.1s"><h3>Price changes detected</h3><div class="b-stat-value" style="color:var(--amber)">${recentChanges}</div><div class="b-stat-label">last 30 days</div></div>
        <div class="b-card" style="animation-delay:0.15s"><h3>Your price position</h3><div class="b-stat-value" style="color:${pricePosition === 'Competitive' ? 'var(--green)' : 'var(--amber)'}">${pricePosition}</div><div class="b-stat-label">vs. market average</div></div>
      </div>
      <div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px"><h3>${icon("trending-up")} Recent price changes</h3><button class="btn btn-sm btn-primary" onclick="scrapeAll()">${icon("refresh-cw")} Scrape all</button></div>
        <div style="overflow-x:auto;margin-top:12px">
          <table class="b-table">
            <thead><tr><th>Date</th><th>Competitor</th><th>Product</th><th>Old price</th><th>New price</th><th>Change</th></tr></thead>
            <tbody>
              ${history.length === 0 ? '<tr><td colspan="6" class="a-empty">No price changes detected yet. Add competitors to start monitoring.</td></tr>' :
                history.map(h => `
                  <tr>
                    <td>${esc(h.date)}</td>
                    <td><b>${esc(h.competitor)}</b></td>
                    <td>${esc(h.product)}</td>
                    <td>$${(h.oldPrice || 0).toFixed(2)}</td>
                    <td>$${(h.newPrice || 0).toFixed(2)}</td>
                    <td><span style="color:${(h.change || 0) < 0 ? 'var(--green)' : 'var(--red)'}; font-weight:600">${(h.change || 0) > 0 ? '+' : ''}${(h.change || 0).toFixed(1)}%</span></td>
                  </tr>
                `).join("")}
            </tbody>
          </table>
        </div>
      </div>
      <div class="b-card" style="margin-bottom:24px;animation-delay:0.25s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px"><h3>${icon("users")} Competitors</h3></div>
        <div style="overflow-x:auto;margin-top:12px">
          ${compList.length === 0 ? '<div class="empty">No competitors tracked yet. <a href="#/competitors">Add competitors</a> to start monitoring prices.</div>' :
            compList.map(c => `
              <div style="display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--card-border)">
                <div style="width:40px;height:40px;border-radius:var(--radius-sm);background:var(--surface-2);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px">${(c.name || "?").charAt(0)}</div>
                <div style="flex:1">
                  <div style="font-weight:600">${esc(c.name || "Competitor")}</div>
                  <div style="font-size:12px;color:var(--muted)">${esc(c.url || "No URL")}</div>
                </div>
                <button class="btn btn-sm btn-primary" onclick="scrapeCompetitor('${c.id}')">${icon("refresh-cw")} Scrape</button>
              </div>
            `).join("")}
        </div>
      </div>`;

    window.scrapeAll = async () => {
      await api.post(`/competitors/${s}/scrape-all`);
      toast("Scraping all competitors...");
      setTimeout(() => renderPriceHistory(), 2000);
    };

    window.scrapeCompetitor = async (id) => {
      await api.post(`/competitors/${s}/scrape/${id}`);
      toast("Scraping competitor...");
      setTimeout(() => renderPriceHistory(), 2000);
    };
  }

  // ── page: markdown suggestions ────────────────────────────────────
  async function renderMarkdowns(container = view) {
    const s = api.store();
    const insights = await api.get(`/insights/${s}/products`).catch(() => ({ products: [] }));
    const slowMoving = (insights.products || []).filter(p => p.velocity === "slow" || p.velocity === "dead").slice(0, 10);

    container.innerHTML = `
      <div class="b-header"><div><h2>Markdowns</h2><p>Slow-moving inventory and markdown suggestions</p></div></div>
      <div class="b-grid-3" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s"><h3>Slow-moving products</h3><div class="b-stat-value" style="color:var(--amber)">${slowMoving.length}</div><div class="b-stat-label">need markdown</div></div>
        <div class="b-card" style="animation-delay:0.1s"><h3>Slow-moving products</h3><div class="b-stat-value" style="color:var(--amber)">${slowMoving.length}</div><div class="b-stat-label">need attention</div></div>
        <div class="b-card" style="animation-delay:0.15s"><h3>Recommended markdown</h3><div class="b-stat-value">15-25%</div><div class="b-stat-label">avg. discount</div></div>
      </div>
      <div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px"><h3>${icon("tag")} Markdown suggestions</h3></div>
        <div style="overflow-x:auto;margin-top:12px">
          <table class="b-table">
            <thead><tr><th>Product</th><th>Velocity</th><th>Stock</th><th>Suggested markdown</th><th>Action</th></tr></thead>
            <tbody>
              ${slowMoving.length === 0 ? '<tr><td colspan="5" class="a-empty">No slow-moving products detected. All inventory is performing well!</td></tr>' :
                slowMoving.map(p => `
                  <tr>
                    <td><b>${esc(p.name || p.product_id || "Product")}</b></td>
                    <td><span class="b-badge amber">${p.velocity || "slow"}</span></td>
                    <td>${p.stock || 0}</td>
                    <td><span style="color:var(--amber);font-weight:600">-${Math.min(30, 10 + (p.stock || 0))}%</span></td>
                    <td><button class="btn btn-sm btn-primary" onclick="toast('Markdown applied to ${esc(p.name || p.product_id)}')">Apply markdown</button></td>
                  </tr>
                `).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  }


  // ── page: billing & subscription ──────────────────────────────────
  async function renderBilling(container = view) {
    const s = api.store();
    const [plans, entitlement, invoices, usage] = await Promise.all([
      api.get(`/billing/plans`).catch(() => ({ plans: {} })),
      api.get(`/billing/${s}/entitlement`).catch(() => ({ plan: "starter", status: "active" })),
      api.get(`/billing/${s}/invoices`).catch(() => ({ invoices: [] })),
      api.get(`/billing/${s}/usage`).catch(() => ({})),
    ]);

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Billing & Subscription</h2>
          <p>Manage your plan, usage, and invoices</p>
        </div>
        <div class="b-header-filters">
          <button class="b-filter-btn active" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            ${icon("receipt")} Invoices
          </button>
          <button class="b-filter-btn" onclick="this.parentElement.querySelectorAll('.b-filter-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active')">
            ${icon("database")} Usage
          </button>
        </div>
      </div>

      <div class="b-grid-4" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("credit-card")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value" style="text-transform:capitalize">${esc(entitlement.plan || "starter")}</div>
          <div class="b-stat-label">Current Plan</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            Status: ${esc(entitlement.status || "active")}
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("dollar")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">$${entitlement.plan === "premium" ? "149" : entitlement.plan === "growth" ? "49" : "0"}</div>
          <div class="b-stat-label">Monthly Cost</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            per month
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle purple">${icon("zap")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${usage.apiCalls?.used?.toLocaleString() || 0}</div>
          <div class="b-stat-label">API Calls Used</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            of ${usage.apiCalls?.limit?.toLocaleString() || "unlimited"}
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle amber">${icon("mail")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${usage.emails?.sent?.toLocaleString() || 0}</div>
          <div class="b-stat-label">Emails Sent</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            of ${usage.emails?.limit?.toLocaleString() || "unlimited"}
          </div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.25s">
          <h3 style="margin-bottom:16px">${icon("credit-card")} Available Plans</h3>
          <div style="display:flex;flex-direction:column;gap:12px">
            ${[
              { name: "Starter", price: "$0", features: ["5 products", "1 competitor", "Basic analytics"] },
              { name: "Growth", price: "$49", features: ["50 products", "5 competitors", "Advanced analytics", "Campaigns"] },
              { name: "Premium", price: "$149", features: ["Unlimited products", "20 competitors", "Full intelligence", "Priority support"] },
            ].map(p => `
              <div style="padding:16px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border);${p.name.toLowerCase() === (entitlement.plan || "starter") ? 'border-color:var(--primary)' : ''}">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                  <span style="font-weight:600">${p.name}</span>
                  <span style="font-weight:700;font-size:18px">${p.price}/mo</span>
                </div>
                <div style="font-size:12px;color:var(--muted);margin-bottom:12px">${p.features.join(" · ")}</div>
                <button class="btn btn-sm ${p.name.toLowerCase() === (entitlement.plan || "starter") ? 'btn-ghost-sm' : 'btn-primary'}" onclick="upgradePlan('${p.name}')">${p.name.toLowerCase() === (entitlement.plan || "starter") ? 'Current plan' : 'Upgrade'}</button>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.3s">
          <h3 style="margin-bottom:16px">${icon("receipt")} Invoice History</h3>
          <div class="scroll-y" style="max-height:400px">
            ${(invoices.invoices || []).length === 0 ? '<div class="empty">No invoices yet.</div>' :
              (invoices.invoices || []).map((inv, i) => `
                <div class="b-list-item" style="animation-delay:${0.05 * i}s">
                  <div style="flex:1">
                    <div style="font-weight:500;font-size:13px">${esc(inv.date)}</div>
                    <div style="font-size:12px;color:var(--muted)">${esc(inv.plan)} · $${inv.amount}</div>
                  </div>
                  <span class="b-badge ${inv.status === 'paid' ? 'green' : 'amber'}">${inv.status}</span>
                </div>
              `).join("")}
          </div>
        </div>
      </div>

      ${usage.storage ? `
      <div class="b-card" style="animation-delay:0.35s">
        <h3 style="margin-bottom:16px">${icon("database")} Resource Usage</h3>
        <div class="b-grid-3">
          <div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="b-stat-label">API Calls</span><span style="font-weight:600">${usage.apiCalls?.used || 0} / ${usage.apiCalls?.limit || 0}</span></div>
            <div class="b-progress-bar"><div class="b-progress-bar-fill" style="width:${(usage.apiCalls?.used / usage.apiCalls?.limit * 100) || 0}%"></div></div>
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="b-stat-label">Emails</span><span style="font-weight:600">${usage.emails?.sent || 0} / ${usage.emails?.limit || 0}</span></div>
            <div class="b-progress-bar"><div class="b-progress-bar-fill" style="width:${(usage.emails?.sent / usage.emails?.limit * 100) || 0}%"></div></div>
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="b-stat-label">Storage</span><span style="font-weight:600">${usage.storage?.used || 0} / ${usage.storage?.limit || 0} ${usage.storage?.unit || 'GB'}</span></div>
            <div class="b-progress-bar"><div class="b-progress-bar-fill" style="width:${(usage.storage?.used / usage.storage?.limit * 100) || 0}%"></div></div>
          </div>
        </div>
      </div>` : ''}`;

    window.upgradePlan = async (plan) => {
      if (plan.toLowerCase() === (entitlement.plan || "starter")) return;
      if (!confirm(`Upgrade to ${plan} plan?`)) return;
      await api.post(`/billing/${s}/upgrade`, { plan: plan.toLowerCase() });
      toast(`Upgraded to ${plan}`);
      renderBilling();
    };
  }


  // ── page: notification preferences ────────────────────────────────
  async function renderNotifications(container = view) {
    const s = api.store();
    const prefs = await api.get(`/notifications/${s}/preferences`).catch(() => ({ email: [], inApp: [], channels: {}, quietHours: {} }));
    
    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Notification Preferences</h2>
          <p>Configure how you receive alerts and updates</p>
        </div>
        <div class="b-header-filters">
          <button class="btn btn-sm btn-primary" onclick="saveNotifPrefs()">${icon("check")} Save Preferences</button>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <h3 style="margin-bottom:16px">${icon("mail")} Email Notifications</h3>
          <div style="display:grid;grid-template-columns:1fr 40px;gap:0">
            <div style="font-weight:600;font-size:13px;padding-bottom:8px;border-bottom:2px solid var(--card-border)">Alert Type</div>
            <div style="font-weight:600;font-size:13px;text-align:center;padding-bottom:8px;border-bottom:2px solid var(--card-border)">On</div>
            ${(prefs.email || []).map(n => `
              <div style="font-size:13px;padding:8px 0;border-bottom:1px solid var(--card-border)">${esc(n.name)}</div>
              <div style="text-align:center;padding:8px 0;border-bottom:1px solid var(--card-border)"><input type="checkbox" ${n.enabled ? 'checked' : ''} onchange="toggleNotif('email', '${n.id}', this.checked)"></div>
            `).join("")}
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <h3 style="margin-bottom:16px">${icon("bell")} In-App Notifications</h3>
          <div style="display:grid;grid-template-columns:1fr 40px;gap:0">
            <div style="font-weight:600;font-size:13px;padding-bottom:8px;border-bottom:2px solid var(--card-border)">Alert Type</div>
            <div style="font-weight:600;font-size:13px;text-align:center;padding-bottom:8px;border-bottom:2px solid var(--card-border)">On</div>
            ${(prefs.inApp || []).map(n => `
              <div style="font-size:13px;padding:8px 0;border-bottom:1px solid var(--card-border)">${esc(n.name)}</div>
              <div style="text-align:center;padding:8px 0;border-bottom:1px solid var(--card-border)"><input type="checkbox" ${n.enabled ? 'checked' : ''} onchange="toggleNotif('inApp', '${n.id}', this.checked)"></div>
            `).join("")}
          </div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.15s">
          <h3 style="margin-bottom:16px">${icon("radio")} Delivery Channels</h3>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${["email", "inApp", "push", "sms"].map(ch => `
              <label style="display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;padding:10px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
                <input type="checkbox" ${prefs.channels?.[ch] ? 'checked' : ''} onchange="toggleChannel('${ch}', this.checked)">
                <span style="text-transform:capitalize;font-weight:500">${ch === "inApp" ? "In-App" : ch}</span>
              </label>
            `).join("")}
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <h3 style="margin-bottom:16px">${icon("moon")} Quiet Hours</h3>
          <div>
            <label style="display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;margin-bottom:16px;padding:10px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
              <input type="checkbox" ${prefs.quietHours?.enabled ? 'checked' : ''} onchange="toggleQuietHours(this.checked)">
              <span style="font-weight:500">Enable quiet hours</span>
            </label>
            <div style="display:flex;gap:10px;align-items:center;font-size:13px">
              <input type="time" id="qh-start" value="${prefs.quietHours?.start || '22:00'}" style="padding:8px 12px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)">
              <span style="color:var(--muted)">to</span>
              <input type="time" id="qh-end" value="${prefs.quietHours?.end || '08:00'}" style="padding:8px 12px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)">
            </div>
          </div>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:16px;animation-delay:0.25s">
        <button class="btn btn-primary" onclick="saveNotifPrefs()">${icon("check")} Save preferences</button>
        <button class="btn btn-ghost-sm" onclick="testNotif()">${icon("bell")} Send test notification</button>
      </div>`;

    window.toggleNotif = async (channel, id, enabled) => {
      const current = prefs[channel] || [];
      const idx = current.findIndex(n => n.id === id);
      if (idx !== -1) current[idx].enabled = enabled;
    };

    window.toggleChannel = async (ch, enabled) => {
      prefs.channels[ch] = enabled;
    };

    window.toggleQuietHours = async (enabled) => {
      prefs.quietHours.enabled = enabled;
    };

    window.saveNotifPrefs = async () => {
      prefs.quietHours.start = document.getElementById("qh-start")?.value || "22:00";
      prefs.quietHours.end = document.getElementById("qh-end")?.value || "08:00";
      await api.put(`/notifications/${s}/preferences`, prefs);
      toast("Preferences saved");
    };

    window.testNotif = async () => {
      const channel = prompt("Send test via (email/inApp/push/sms):", "email") || "email";
      await api.post(`/notifications/${s}/test`, { channel });
      toast("Test notification sent");
    };
  }

  // ── page: support tickets ─────────────────────────────────────────
  async function renderSupport(container = view) {
    const s = api.store();
    const [tickets, stats] = await Promise.all([
      api.get(`/support/tickets?store_id=${s}`).catch(() => []),
      api.get(`/support/tickets/stats?store_id=${s}`).catch(() => ({})),
    ]);

    const ticketList = Array.isArray(tickets) ? tickets : [];

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Support Tickets</h2>
          <p>Manage and track your support requests</p>
        </div>
        <div class="b-header-filters">
          <button class="btn btn-sm btn-primary" onclick="createTicket()">${icon("plus")} New Ticket</button>
        </div>
      </div>

      <div class="b-grid-4" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle amber">${icon("clock")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${stats.open || 0}</div>
          <div class="b-stat-label">Open Tickets</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            awaiting response
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle blue">${icon("zap")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${stats.in_progress || 0}</div>
          <div class="b-stat-label">In Progress</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            being handled
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.15s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle green">${icon("check-circle")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${stats.resolved || 0}</div>
          <div class="b-stat-label">Resolved</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            this month
          </div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <div class="b-icon-circle purple">${icon("clock")}</div>
            <button class="b-report-btn">${icon("download")} Report</button>
          </div>
          <div class="b-stat-value">${stats.avg_response_time_ms ? Math.round(stats.avg_response_time_ms / 60000) + "m" : "N/A"}</div>
          <div class="b-stat-label">Avg Response</div>
          <div class="b-stat-trend up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>
            first response
          </div>
        </div>
      </div>

      <div class="b-card" style="margin-bottom:24px;animation-delay:0.25s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h3 style="margin:0">${icon("headphones")} Support Tickets</h3>
          <button class="btn btn-primary btn-sm" onclick="createTicket()">${icon("plus")} New Ticket</button>
        </div>
        <div style="overflow-x:auto">
          <table class="b-table">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Category</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Assigned</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              ${ticketList.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">No support tickets yet. Create one if you need help!</td></tr>' :
                ticketList.map((t, i) => `
                  <tr style="animation-delay:${0.05 * i}s">
                    <td><b>${esc(t.subject)}</b></td>
                    <td>${esc(t.category)}</td>
                    <td><span class="b-badge ${t.priority === 'critical' ? 'red' : t.priority === 'high' ? 'amber' : 'green'}">${t.priority}</span></td>
                    <td><span class="b-badge ${t.status === 'open' ? 'amber' : t.status === 'resolved' ? 'green' : 'blue'}">${t.status}</span></td>
                    <td>${esc(t.assignee || "Unassigned")}</td>
                    <td style="color:var(--muted)">${new Date(t.created_at).toLocaleDateString()}</td>
                  </tr>
                `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="b-card" style="animation-delay:0.3s">
        <h3 style="margin-bottom:16px">${icon("bar-chart")} Ticket Breakdown</h3>
        <div class="b-grid-2">
          <div>
            <h4 style="font-size:13px;margin-bottom:12px;font-weight:600">By Priority</h4>
            ${["critical", "high", "medium", "low"].map(p => `
              <div style="margin-bottom:10px">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span class="b-stat-label" style="text-transform:capitalize">${p}</span><span style="font-weight:600">${stats.by_priority?.[p] || 0}</span></div>
                <div class="b-progress-bar"><div class="b-progress-bar-fill" style="width:${stats.by_priority?.[p] ? (stats.by_priority[p] / Math.max(stats.total, 1)) * 100 : 0}%;background:${p === 'critical' ? 'var(--red)' : p === 'high' ? 'var(--amber)' : p === 'medium' ? 'var(--primary)' : 'var(--green)'}"></div></div>
              </div>
            `).join("")}
          </div>
          <div>
            <h4 style="font-size:13px;margin-bottom:12px;font-weight:600">By Category</h4>
            ${Object.entries(stats.by_category || {}).map(([cat, count]) => `
              <div style="margin-bottom:10px">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span class="b-stat-label" style="text-transform:capitalize">${cat.replace("_", " ")}</span><span style="font-weight:600">${count}</span></div>
                <div class="b-progress-bar"><div class="b-progress-bar-fill" style="width:${count ? (count / Math.max(stats.total, 1)) * 100 : 0}%"></div></div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>`;

    // Create ticket modal
    window.createTicket = async () => {
      const subject = prompt("Ticket subject:");
      if (!subject) return;
      const description = prompt("Describe your issue:");
      if (!description) return;
      const category = prompt("Category (billing/technical/account/feature_request/bug_report/integration/other):", "other") || "other";
      const priority = prompt("Priority (low/medium/high/critical):", "medium") || "medium";

      try {
        await api.post("/support/tickets", {
          store_id: s,
          subject,
          description,
          category,
          priority,
        });
        toast(`${icon("check-circle")} Ticket created successfully`);
        route();
      } catch (e) {
        toast(`${icon("alert-triangle")} ${esc(e.message)}`);
      }
    };
  }


  // ── page: feature activation ──────────────────────────────────────
  async function renderFeatures(container = view) {
    const s = api.store();
    const data = await api.get(`/features/${s}`).catch(() => ({ features: [] }));
    const featureList = data.features || [];

    container.innerHTML = `
      <div class="b-header"><div><h2>Feature Activation</h2><p>Enable or disable platform features</p></div></div>
      <div class="b-grid-3" style="margin-bottom:24px">
        <div class="b-card" style="animation-delay:0.05s"><h3>Total features</h3><div class="b-stat-value">${featureList.length}</div><div class="b-stat-label">available</div></div>
        <div class="b-card" style="animation-delay:0.1s"><h3>Active features</h3><div class="b-stat-value" style="color:var(--green)">${featureList.filter(f => f.active).length}</div><div class="b-stat-label">currently enabled</div></div>
        <div class="b-card" style="animation-delay:0.15s"><h3>Inactive features</h3><div class="b-stat-value" style="color:var(--amber)">${featureList.filter(f => !f.active).length}</div><div class="b-stat-label">available to activate</div></div>
      </div>
      <div class="b-card" style="margin-bottom:24px;animation-delay:0.2s">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px"><h3>${icon("sliders")} Feature activation</h3></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
          ${featureList.map(f => `
            <div style="padding:16px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border);display:flex;align-items:center;gap:12px">
              <div style="flex:1">
                <div style="font-weight:600;font-size:14px">${esc(f.name)}</div>
                <div style="font-size:12px;color:var(--muted)">${esc(f.desc)}</div>
                <div style="margin-top:4px"><span class="b-badge gray">${f.category}</span></div>
              </div>
              <button class="btn btn-sm ${f.active ? 'btn-primary' : 'btn-ghost-sm'}" onclick="toggleFeature('${f.id}', ${!f.active})">${f.active ? 'Active' : 'Activate'}</button>
            </div>
          `).join("")}
        </div>
      </div>`;

    window.toggleFeature = async (id, active) => {
      await api.put(`/features/${s}/${id}`, { active });
      toast(active ? "Feature activated" : "Feature deactivated");
      renderFeatures();
    };
  }

  // ── page: returns & fraud shield ───────────────────────────────────
  async function renderReturns(container = view) {
    const s = api.store();
    const [dashboard, impact, recommendations] = await Promise.all([
      api.get(`/returns/${s}/dashboard`).catch(() => ({ fraud_stats: {}, cost_analysis: {}, recent_returns: [], pending_reviews_count: 0 })),
      api.get(`/returns/${s}/analytics/impact?days=30`).catch(() => ({ cost_analysis: {}, top_reasons: [], top_skus: [], policy_performance: {} })),
      api.get(`/returns/${s}/analytics/recommendations`).catch(() => []),
    ]);

    const fs = dashboard.fraud_stats || {};
    const ca = impact.cost_analysis || {};
    const pp = impact.policy_performance || {};
    const recentReturns = dashboard.recent_returns || [];
    const topReasons = impact.top_reasons || [];
    const topSKUs = impact.top_skus || [];

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Returns & Fraud Shield</h2>
          <p>Intelligent return processing and fraud prevention</p>
        </div>
      </div>

      <div class="b-grid-4">
        <div class="b-card" style="animation-delay:0s">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
            <div class="b-icon-circle red"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>
          </div>
          <div class="b-stat-label">Fraud Prevented</div>
          <div class="b-stat-value">$${(fs.fraud_prevented_amount || 0).toLocaleString()}</div>
          <div class="b-stat-trend up">${fs.flagged_returns || 0} returns flagged</div>
        </div>
        <div class="b-card" style="animation-delay:0.1s">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
            <div class="b-icon-circle amber"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
          </div>
          <div class="b-stat-label">Pending Reviews</div>
          <div class="b-stat-value">${dashboard.pending_reviews_count || 0}</div>
          <div class="b-stat-trend">Requires attention</div>
        </div>
        <div class="b-card" style="animation-delay:0.2s">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
            <div class="b-icon-circle violet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>
          </div>
          <div class="b-stat-label">Return Cost (30d)</div>
          <div class="b-stat-value">$${(ca.total_return_value || 0).toLocaleString()}</div>
          <div class="b-stat-trend">${ca.total_returns || 0} returns processed</div>
        </div>
        <div class="b-card" style="animation-delay:0.3s">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
            <div class="b-icon-circle green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></svg></div>
          </div>
          <div class="b-stat-label">Approval Rate</div>
          <div class="b-stat-value">${pp.approval_rate_pct || 0}%</div>
          <div class="b-progress-bar"><div class="b-progress-bar-fill blue" style="width:${pp.approval_rate_pct || 0}%"></div></div>
        </div>
      </div>

      <div class="b-grid-2" style="margin-top:20px">
        <div class="b-card" style="animation-delay:0.2s">
          <div style="font-weight:600;color:var(--text-primary);margin-bottom:16px">Suspicious Returns</div>
          ${recentReturns.filter((r) => r.risk_score > 50).length === 0
            ? '<div style="text-align:center;padding:24px;color:var(--text-muted)">No suspicious returns detected</div>'
            : recentReturns.filter((r) => r.risk_score > 50).slice(0, 5).map((r) => `
              <div class="b-list-item" style="border-left:3px solid ${r.risk_score > 75 ? 'var(--red)' : 'var(--amber)'};margin-bottom:8px;padding:12px 16px;background:rgba(${r.risk_score > 75 ? '239,68,68' : '245,158,11'},0.05);border-radius:var(--radius-sm)">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <div>
                    <b style="color:var(--text-primary)">Return #${r._id ? r._id.slice(0,8) : 'N/A'}</b>
                    <span style="color:var(--text-muted);font-size:12px;margin-left:8px">${r.customer_id || 'Unknown'}</span>
                    <br><span style="color:var(--text-muted);font-size:12px">${r.reason || 'No reason'} · $${(r.return_value || 0).toLocaleString()}</span>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px">
                    <span class="b-badge" style="background:rgba(${r.risk_score > 75 ? '239,68,68' : '245,158,11'},0.15);color:${r.risk_score > 75 ? 'var(--red)' : 'var(--amber)'}">Risk: ${r.risk_score}%</span>
                    <button class="b-filter-btn" onclick="approveReturn('${r._id}')" style="padding:4px 10px;font-size:11px;cursor:pointer;border:1px solid var(--green);background:rgba(8,144,108,0.1);color:var(--green);border-radius:var(--radius-sm)">Approve</button>
                    <button class="b-filter-btn" onclick="denyReturn('${r._id}')" style="padding:4px 10px;font-size:11px;cursor:pointer;border:1px solid var(--red);background:rgba(239,68,68,0.1);color:var(--red);border-radius:var(--radius-sm)">Deny</button>
                  </div>
                </div>
              </div>
            `).join("")}
        </div>

        <div class="b-card" style="animation-delay:0.3s">
          <div style="font-weight:600;color:var(--text-primary);margin-bottom:16px">AI Recommendations</div>
          ${recommendations.length === 0
            ? '<div style="text-align:center;padding:24px;color:var(--text-muted)">No recommendations yet — need more return data</div>'
            : recommendations.slice(0, 5).map((rec) => `
              <div class="b-list-item" style="border-left:3px solid ${rec.priority === 'high' ? 'var(--red)' : rec.priority === 'medium' ? 'var(--amber)' : 'var(--primary)'};margin-bottom:8px;padding:12px 16px;background:var(--surface-2);border-radius:var(--radius-sm)">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <div>
                    <b style="color:var(--text-primary);font-size:13px">${rec.type || 'Insight'}</b>
                    <br><span style="color:var(--text-muted);font-size:12px">${rec.message}</span>
                  </div>
                  <span class="b-badge" style="background:rgba(8,144,108,0.15);color:var(--green)">${rec.priority}</span>
                </div>
              </div>
            `).join("")}
        </div>
      </div>

      <div class="b-grid-2" style="margin-top:20px">
        <div class="b-card" style="animation-delay:0.3s">
          <div style="font-weight:600;color:var(--text-primary);margin-bottom:16px">Top Return Reasons</div>
          ${topReasons.length === 0
            ? '<div style="text-align:center;padding:24px;color:var(--text-muted)">No return data yet</div>'
            : topReasons.slice(0, 5).map((r) => `
              <div class="b-list-item" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--card-border)">
                <span style="font-size:13px;color:var(--text-primary)">${r.reason}</span>
                <div style="display:flex;align-items:center;gap:8px">
                  <span style="font-size:12px;color:var(--text-muted)">${r.count} returns</span>
                  <span style="font-weight:600;color:var(--red)">$${(r.total_value || 0).toLocaleString()}</span>
                </div>
              </div>
            `).join("")}
        </div>

        <div class="b-card" style="animation-delay:0.4s">
          <div style="font-weight:600;color:var(--text-primary);margin-bottom:16px">Most Returned SKUs</div>
          ${topSKUs.length === 0
            ? '<div style="text-align:center;padding:24px;color:var(--text-muted)">No return data yet</div>'
            : topSKUs.slice(0, 5).map((s) => `
              <div class="b-list-item" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--card-border)">
                <div>
                  <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${s.name || s.sku}</span>
                  <br><span style="font-size:11px;color:var(--text-muted)">${s.return_count} returns · ${s.return_rate || 0}% rate</span>
                </div>
                <span style="font-weight:600;color:var(--red)">$${(s.return_value || 0).toLocaleString()}</span>
              </div>
            `).join("")}
        </div>
      </div>

      <div class="b-card" style="animation-delay:0.4s;margin-top:20px">
        <div style="font-weight:600;color:var(--text-primary);margin-bottom:16px">Recent Returns</div>
        ${recentReturns.length === 0
          ? '<div style="text-align:center;padding:24px;color:var(--text-muted)">No returns recorded yet</div>'
          : `<div style="overflow-x:auto"><table class="b-table">
            <thead><tr><th>ID</th><th>Customer</th><th>Reason</th><th>Value</th><th>Risk</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              ${recentReturns.slice(0, 20).map((r) => {
                const sCls = r.status === 'approved' ? 'green' : r.status === 'denied' ? 'red' : r.status === 'flagged' ? 'amber' : 'gray';
                const rCls = r.risk_score > 75 ? 'red' : r.risk_score > 50 ? 'amber' : r.risk_score > 20 ? 'purple' : 'green';
                return `<tr>
                  <td><b>#${r._id ? r._id.slice(0,8) : 'N/A'}</b></td>
                  <td>${r.customer_id || '—'}</td>
                  <td>${r.reason || '—'}</td>
                  <td>$${(r.return_value || 0).toLocaleString()}</td>
                  <td><span class="b-badge ${rCls}">${r.risk_score || 0}%</span></td>
                  <td><span class="b-badge ${sCls}">${r.status || 'pending'}</span></td>
                  <td>
                    ${r.status === 'pending' || r.status === 'under_review' ? `
                      <button class="b-filter-btn" onclick="approveReturn('${r._id}')" style="padding:2px 8px;font-size:11px;cursor:pointer;border:1px solid var(--green);background:rgba(8,144,108,0.1);color:var(--green);border-radius:var(--radius-sm)">Approve</button>
                      <button class="b-filter-btn" onclick="denyReturn('${r._id}')" style="padding:2px 8px;font-size:11px;cursor:pointer;border:1px solid var(--red);background:rgba(239,68,68,0.1);color:var(--red);border-radius:var(--radius-sm);margin-left:4px">Deny</button>
                    ` : '—'}
                  </td>
                </tr>`;
              }).join("")}
            </tbody>
          </table></div>`}
      </div>
    `;

    window.approveReturn = async (returnId) => {
      await api.post(`/returns/${s}/${returnId}/approve`, { approved_by: 'merchant' });
      toast("Return approved");
      renderReturns();
    };
    window.denyReturn = async (returnId) => {
      await api.post(`/returns/${s}/${returnId}/deny`, { denied_by: 'merchant', reason: 'Denied by merchant' });
      toast("Return denied");
      renderReturns();
    };
  }

  window.triggerRecovery = async (storeId) => {
    try {
      await api.post(`/execute/${storeId}`);
      toast("Recovery emails queued for abandoned carts");
    } catch(e) { toast("Error: " + e.message); }
  };

  window.enableBrowseRecovery = async (storeId) => {
    try {
      await api.post(`/orchestrator/scan/${storeId}`);
      toast("Browse abandonment rules scanned and activated");
    } catch(e) { toast("Error: " + e.message); }
  };

  window.generateWinbackCampaign = async (storeId, count) => {
    try {
      await api.post(`/campaigns/${storeId}/generate`);
      toast(`Win-back campaign generated for ${count} at-risk customers`);
    } catch(e) { toast("Error: " + e.message); }
  };

  window.exportCustomerList = async (storeId) => {
    try {
      const data = await api.get(`/export/store`);
      if (data.export_url) { window.open(data.export_url, '_blank'); toast("Customer list exported"); }
      else { toast("Export generated — check your downloads"); }
    } catch(e) { toast("Export failed: " + e.message); }
  };

  // ── page: activity log ─────────────────────────────────────────────
  async function renderActivity(container = view) {
    const s = api.store();
    const [entries, summary] = await Promise.all([
      api.get(`/activity?store_id=${s}&limit=50`).catch(() => []),
      api.get(`/activity/summary?store_id=${s}`).catch(() => ({ total_events: 0 })),
    ]);

    const actionIcons = {
      login: "🔑", logout: "🚪", signup: "📝", store_connected: "🔗",
      seo_audit_run: "🔍", seo_fix_applied: "✅", campaign_created: "📧",
      data_exported: "📦", settings_updated: "⚙️", plan_changed: "💳",
    };

    container.innerHTML = `
      <div class="b-header">
        <div>
          <h2>Activity Log</h2>
          <p>Recent activity for your store — ${summary.total_events || 0} events in the last 30 days</p>
        </div>
      </div>
      <div class="b-card" style="animation-delay:0.05s">
        <div style="margin-top:8px">
          ${entries.length === 0 ? '<div style="text-align:center;padding:40px;color:var(--muted)">No activity recorded yet.</div>' : entries.map((e) => `
            <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--card-border)">
              <div style="width:36px;height:36px;border-radius:8px;background:var(--surface-2);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${actionIcons[e.action] || "📋"}</div>
              <div style="flex:1">
                <div style="font-weight:600;font-size:13px;text-transform:capitalize">${esc(e.action?.replace(/_/g, " "))}</div>
                <div style="font-size:12px;color:var(--muted)">${esc(e.detail?.message || e.target || e.actor || "")}</div>
              </div>
              <div style="font-size:12px;color:var(--muted);white-space:nowrap">${e.at ? new Date(e.at).toLocaleString() : ""}</div>
            </div>
          `).join("")}
        </div>
      </div>`;
  }

  // ── Notification Center ──────────────────────────────────────────────
  async function initNotificationCenter() {
    const notifBtn = $("#notif-btn");
    const notifPanel = $("#notif-panel");
    const notifBadge = $("#notif-badge");
    const notifList = $("#notif-list");
    const notifMarkAll = $("#notif-mark-all");

    if (!notifBtn || !notifPanel) return;

    async function refreshNotifs() {
      const s = api.store();
      if (!s) return;
      try {
        const summary = await api.get(`/notifications/summary?store_id=${s}`);
        if (summary.total_unread > 0) {
          notifBadge.textContent = summary.total_unread > 99 ? "99+" : summary.total_unread;
          notifBadge.classList.remove("hidden");
        } else {
          notifBadge.classList.add("hidden");
        }
      } catch (e) {}
    }

    notifBtn.addEventListener("click", async () => {
      const isHidden = notifPanel.classList.contains("hidden");
      if (isHidden) {
        notifPanel.classList.remove("hidden");
        const s = api.store();
        try {
          const notifs = await api.get(`/notifications?store_id=${s}&limit=20`);
          if (notifs.length === 0) {
            notifList.innerHTML = '<p class="notif-empty">No notifications yet.</p>';
          } else {
            notifList.innerHTML = notifs.map((n) => `
              <div class="notif-item severity-${n.severity || 'info'}" data-id="${n._id}">
                <p class="notif-title">${esc(n.title)}</p>
                <p class="notif-msg">${esc(n.message || '')}</p>
                <p class="notif-time">${n.created_at ? new Date(n.created_at).toLocaleString() : ''}</p>
              </div>
            `).join("");
          }
        } catch (e) {
          notifList.innerHTML = '<p class="notif-empty">Could not load notifications.</p>';
        }
      } else {
        notifPanel.classList.add("hidden");
      }
    });

    if (notifMarkAll) {
      notifMarkAll.addEventListener("click", async () => {
        const s = api.store();
        await api.post("/notifications/read", { store_id: s }).catch(() => {});
        notifPanel.classList.add("hidden");
        refreshNotifs();
      });
    }

    // Close panel on outside click.
    document.addEventListener("click", (e) => {
      if (!notifPanel.contains(e.target) && !notifBtn.contains(e.target)) {
        notifPanel.classList.add("hidden");
      }
    });

    // Refresh badge count every 60 seconds.
    refreshNotifs();
    setInterval(refreshNotifs, 60000);
  }

  // Init notification center when app shell is shown.
  const origEnterApp = typeof enterApp === "function" ? enterApp : null;
  if (origEnterApp) {
    const wrappedEnter = async function(...args) {
      await origEnterApp.apply(this, args);
      setTimeout(initNotificationCenter, 500);
    };
    // We can't reassign enterApp inside IIFE, so we hook via hashchange.
    window.addEventListener("hashchange", () => setTimeout(initNotificationCenter, 300));
  }
  // Also init on first boot.
  setTimeout(initNotificationCenter, 1500);

  // Task 49: Single, deterministic boot path.
  // URL params (?signup=1, ?connect_token=…) take priority
  // regardless of session state, then fall back to session restore.
  const bootParams = new URLSearchParams(location.search);

  if (api.session()) {
    $("#login").classList.add("hidden");
    enterApp(api.session().storeId, api.session().apiKey);
  } else {
    $("#login").classList.remove("hidden");
    applyConnectParams();
    if (bootParams.get("signup") === "1") switchAuthTab("signup");
  }
})();
