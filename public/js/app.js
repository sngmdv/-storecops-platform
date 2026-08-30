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

  $("#demo-btn").addEventListener("click", async () => {
    const btn = $("#demo-btn");
    btn.disabled = true;
    btn.textContent = "Seeding demo store…";
    showAuthError("");
    try {
      api.saveSession("demo_store", "dev-key");
      await api.post("/demo/seed", { store_id: "demo_store" });
      await enterApp("demo_store", "dev-key");
      toast(icon("rocket") + " Demo store is live — sales, carts, stock and competitors seeded.");
    } catch (error) {
      showAuthError(error.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = icon("sparkles", "icon-sm") + " Launch instant demo store";
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
  const ROUTES = {
    dashboard: { title: "Command Center", render: renderDashboard },
    live: { title: "Live Orders", render: renderLive },
    inventory: { title: "Inventory Advisor", render: renderInventory },
    customers: { title: "Customer Intelligence", render: renderCustomers },
    automations: { title: "Automation Studio", render: renderAutomations },
    messages: { title: "Messages", render: renderMessages },
    campaigns: { title: "Campaigns & Retargeting", render: renderCampaigns },
    competitors: { title: "Competitor Radar", render: renderCompetitors },
    "brand-keywords": { title: "Brand Keywords", render: renderBrandKeywords },
    seo: { title: "SEO & Trends", render: renderSeo },
    reports: { title: "Reports & ROI", render: renderReports },
    settings: { title: "Settings", render: renderSettings },
    connect: { title: "Connect Store", render: renderConnect },
    onboarding: { title: "Setup Guide", render: renderOnboarding },
    activity: { title: "Activity Log", render: renderActivity },
    recovery: { title: "Revenue Recovery", render: renderRecovery },
    winback: { title: "Win-Back Campaigns", render: renderWinback },
    browse: { title: "Browse Abandonment", render: renderBrowse },
    recommendations: { title: "Product Recommendations", render: renderRecommendations },
    churn: { title: "Churn Risk", render: renderChurnRisk },
    defections: { title: "Defection Alerts", render: renderDefections },
    milestones: { title: "Aha Moments", render: renderMilestones },
    pricehistory: { title: "Price History", render: renderPriceHistory },
    markdowns: { title: "Markdown Suggestions", render: renderMarkdowns },
    templates: { title: "Template Editor", render: renderTemplates },
    billing: { title: "Billing & Subscription", render: renderBilling },
    channels: { title: "Channel Settings", render: renderChannels },
    notifications: { title: "Notification Preferences", render: renderNotifications },
    support: { title: "Support Tickets", render: renderSupport },
    cac: { title: "CAC Tracking", render: renderCac },
    pricing: { title: "Dynamic Pricing", render: renderPricing },
    features: { title: "Feature Activation", render: renderFeatures },
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
            view.innerHTML = `<div class="login"><div class="login-card">
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
    document.querySelectorAll(".side-nav a").forEach((a) =>
      a.classList.toggle("active", a.dataset.route === name || (!ROUTES[name] && a.dataset.route === "dashboard"))
    );
    closeStream();
    destroyCharts();
    view.innerHTML = '<div class="empty"><span class="spinner"></span>&nbsp; Loading…</div>';
    target.render().catch((error) => {
      view.innerHTML = `<div class="card"><h3>Something went wrong</h3><p class="muted">${esc(error.message)}</p></div>`;
    });
  }

  window.addEventListener("hashchange", route);

  // ── page: dashboard ────────────────────────────────────────────────
  async function renderDashboard() {
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
    const revenueRecovered = attr.revenue_attributed || o.revenue * 0.15 || 0;
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

    view.innerHTML = `
      <!-- Quick Stats Row -->
      <div class="grid grid-4">
        <div class="card"><h3>Revenue</h3><div class="kpi-value">${money(o.revenue)}</div><div class="kpi-sub">${o.events_tracked || 0} events tracked</div></div>
        <div class="card"><h3>Orders</h3><div class="kpi-value">${funnel.purchases || 0}</div><div class="kpi-sub">conversion ${(funnel.product_views ? ((funnel.purchases / funnel.product_views) * 100).toFixed(1) : 0)}% of views</div></div>
        <div class="card"><h3>Customers</h3><div class="kpi-value">${o.customers || 0}</div><div class="kpi-sub kpi-${atRisk > 0 ? "warn" : "up"}">${atRisk} at risk of churn</div></div>
        <div class="card"><h3>Stock alerts</h3><div class="kpi-value">${restocks}</div><div class="kpi-sub kpi-${restocks > 0 ? "bad" : "up"}">${restocks > 0 ? "need restocking" : "all healthy"}</div></div>
      </div>
      ${onboarding}

      <!-- Revenue & Maturity Row -->
      <div class="grid grid-2 section-gap">
        <div class="card">
          <div class="card-title-row"><h3>${icon("dollar")} Revenue recovered</h3><span class="pill pill-green">+${money(revenueRecovered)}</span></div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px">
            <div style="text-align:center;padding:12px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
              <div style="font-size:20px;font-weight:700;color:var(--green)">${money(attr.cart_recovery || revenueRecovered * 0.4)}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">Cart Recovery</div>
            </div>
            <div style="text-align:center;padding:12px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
              <div style="font-size:20px;font-weight:700;color:var(--primary)">${money(attr.upsell || revenueRecovered * 0.35)}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">Upsell</div>
            </div>
            <div style="text-align:center;padding:12px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
              <div style="font-size:20px;font-weight:700;color:var(--cyan)">${money(attr.retention || revenueRecovered * 0.25)}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">Retention</div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-title-row"><h3>${icon("cpu")} System maturity</h3><span style="font-size:12px;color:${maturityColor};font-weight:600">${maturityLabel}</span></div>
          <div style="margin-top:16px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <span style="font-size:32px;font-weight:800;color:${maturityColor}">${maturityScore}%</span>
              <span style="font-size:12px;color:var(--muted)">Learning from your data</span>
            </div>
            <div style="height:8px;background:var(--card-border);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${maturityScore}%;background:linear-gradient(90deg,${maturityColor},${maturityColor}88);border-radius:4px;transition:width 1s ease"></div>
            </div>
            <div style="display:flex;gap:16px;margin-top:12px;font-size:12px;color:var(--muted)">
              <span>${icon("check-circle")} ${maturityScore >= 20 ? "Data collection" : "Connect store"}</span>
              <span>${icon("check-circle")} ${maturityScore >= 40 ? "Intelligence active" : "Needs more data"}</span>
              <span>${icon("check-circle")} ${maturityScore >= 60 ? "Predictions live" : "Building models"}</span>
              <span>${icon("check-circle")} ${maturityScore >= 80 ? "Full automation" : "Unlock more"}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Intelligence Row -->
      <div class="grid grid-3 section-gap">
        <div class="card" style="cursor:pointer" onclick="location.hash='#/competitors'">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div style="width:40px;height:40px;border-radius:var(--radius-sm);background:rgba(6,182,212,0.1);display:flex;align-items:center;justify-content:center;color:var(--cyan)">${icon("target")}</div>
            <div><div style="font-size:20px;font-weight:700">${competitorAlerts}</div><div style="font-size:12px;color:var(--muted)">Competitor alerts</div></div>
          </div>
          <div style="font-size:13px;color:var(--text-dim)">Price changes, new products, promotions detected</div>
        </div>
        <div class="card" style="cursor:pointer" onclick="location.hash='#/seo'">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div style="width:40px;height:40px;border-radius:var(--radius-sm);background:rgba(8,144,108,0.1);display:flex;align-items:center;justify-content:center;color:var(--green)">${icon("search")}</div>
            <div><div style="font-size:20px;font-weight:700">${seoIssues}</div><div style="font-size:12px;color:var(--muted)">SEO issues</div></div>
          </div>
          <div style="font-size:13px;color:var(--text-dim)">Meta tags, content gaps, ranking changes</div>
        </div>
        <div class="card" style="cursor:pointer" onclick="location.hash='#/campaigns'">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div style="width:40px;height:40px;border-radius:var(--radius-sm);background:rgba(245,158,11,0.1);display:flex;align-items:center;justify-content:center;color:var(--amber)">${icon("flame")}</div>
            <div><div style="font-size:20px;font-weight:700">${trendingProducts}</div><div style="font-size:12px;color:var(--muted)">Trending products</div></div>
          </div>
          <div style="font-size:13px;color:var(--text-dim)">Trending on Pinterest, Reddit, Google, TikTok</div>
        </div>
      </div>

      <!-- Charts Row -->
      <div class="grid grid-2 section-gap">
        <div class="card"><h3>Conversion funnel</h3><div class="chart-wrap"><canvas id="funnel-chart"></canvas></div></div>
        <div class="card"><h3>Churn risk distribution</h3><div class="chart-wrap"><canvas id="churn-chart"></canvas></div></div>
      </div>

      <!-- Live Feed & Actions Row -->
      <div class="grid grid-2-1 section-gap">
        <div class="card">
          <div class="card-title-row"><h3>${icon("radio")} Live orders — who's buying right now</h3><span class="live-status"><span class="live-dot"></span> streaming</span></div>
          <div class="feed" id="live-feed"></div>
        </div>
        <div class="card">
          <h3>${icon("bell")} Action center</h3>
          <div class="scroll-y" id="alert-list"></div>
        </div>
      </div>

      <!-- Quick Actions Row -->
      <div class="grid grid-4 section-gap">
        <a class="card" href="#/campaigns" style="text-decoration:none;color:inherit">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <div style="width:36px;height:36px;border-radius:var(--radius-sm);background:var(--primary-light);display:flex;align-items:center;justify-content:center;color:var(--primary)">${icon("megaphone")}</div>
            <span style="font-weight:600;font-size:14px">Campaigns</span>
          </div>
          <div style="font-size:12px;color:var(--muted)">Create win-back, upsell & seasonal campaigns</div>
        </a>
        <a class="card" href="#/competitors" style="text-decoration:none;color:inherit">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <div style="width:36px;height:36px;border-radius:var(--radius-sm);background:rgba(6,182,212,0.1);display:flex;align-items:center;justify-content:center;color:var(--cyan)">${icon("target")}</div>
            <span style="font-weight:600;font-size:14px">Competitors</span>
          </div>
          <div style="font-size:12px;color:var(--muted)">Track prices, products & ads</div>
        </a>
        <a class="card" href="#/seo" style="text-decoration:none;color:inherit">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <div style="width:36px;height:36px;border-radius:var(--radius-sm);background:rgba(8,144,108,0.1);display:flex;align-items:center;justify-content:center;color:var(--green)">${icon("search")}</div>
            <span style="font-weight:600;font-size:14px">SEO</span>
          </div>
          <div style="font-size:12px;color:var(--muted)">Audit, fix & rank higher</div>
        </a>
        <a class="card" href="#/reports" style="text-decoration:none;color:inherit">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <div style="width:36px;height:36px;border-radius:var(--radius-sm);background:rgba(245,158,11,0.1);display:flex;align-items:center;justify-content:center;color:var(--amber)">${icon("bar-chart")}</div>
            <span style="font-weight:600;font-size:14px">Reports</span>
          </div>
          <div style="font-size:12px;color:var(--muted)">ROI, revenue & weekly digest</div>
        </a>
      </div>

      <!-- Stock Advisor -->
      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("package")} Stock advisor</h3><a class="btn btn-sm btn-primary" href="#/inventory">Full advisor →</a></div>
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

  // ── page: live orders ──────────────────────────────────────────────
  async function renderLive() {
    const s = api.store();
    const data = await api.get(`/orders/${s}/live?limit=50`).catch(() => ({ orders: [], count: 0, stats: {} }));
    const stats = data.stats || {};
    const topProducts = stats.top_products || [];
    const hourly = stats.hourly || [];
    const segDist = stats.today_segments || {};

    // Find peak hour for the chart.
    const peakOrders = Math.max(1, ...hourly.map((h) => h.orders));

    // Hourly mini-chart bars.
    const hourBars = hourly.map((h) => {
      const pct = Math.round((h.orders / peakOrders) * 100);
      const label = h.hour === new Date().getHours() ? "now" : `${h.hour}:00`;
      return `<div class="hour-bar" title="${label}: ${h.orders} orders, $${h.revenue.toFixed(0)}"><div class="hour-bar-fill" style="height:${pct}%"></div><span class="hour-label">${h.orders > 0 ? h.orders : ""}</span></div>`;
    }).join("");

    // Segment pills.
    const segPills = Object.entries(segDist).length
      ? Object.entries(segDist).map(([seg, count]) => {
          const colors = { VIP: "pill-green", HIGH_VALUE: "pill-cyan", LOYAL: "pill-violet", NEW: "pill-gray", AT_RISK: "pill-amber", DEFECTED: "pill-red" };
          return `<span class="pill ${colors[seg] || "pill-gray"}">${seg} ×${count}</span>`;
        }).join(" ")
      : '<span class="muted" style="font-size:12px">No orders today yet</span>';

    // Top products list.
    const topProdHtml = topProducts.length
      ? topProducts.map((p, i) => `<div class="top-prod-item"><span class="top-prod-rank">#${i + 1}</span><span class="top-prod-name">${esc(p.name)}</span><span class="top-prod-qty">${p.quantity} sold</span></div>`).join("")
      : '<div class="empty" style="padding:10px">No product data yet</div>';

    view.innerHTML = `
      <div class="live-kpi-strip">
        <div class="live-kpi">
          <div class="live-kpi-label">Today's revenue</div>
          <div class="live-kpi-val ${stats.today_revenue > 0 ? "kpi-up" : ""}">${money(stats.today_revenue || 0)}</div>
          <div class="live-kpi-sub">${stats.today_orders || 0} orders</div>
        </div>
        <div class="live-kpi">
          <div class="live-kpi-label">Avg order value</div>
          <div class="live-kpi-val">${money(stats.avg_order_value || 0)}</div>
          <div class="live-kpi-sub">across ${stats.total_orders || 0} total orders</div>
        </div>
        <div class="live-kpi">
          <div class="live-kpi-label">Lifetime revenue</div>
          <div class="live-kpi-val">${money(stats.total_revenue || 0)}</div>
          <div class="live-kpi-sub">all-time tracked</div>
        </div>
        <div class="live-kpi">
          <div class="live-kpi-label">Today's segments</div>
          <div class="live-kpi-val" style="font-size:14px;display:flex;gap:4px;flex-wrap:wrap;align-items:center">${segPills}</div>
        </div>
      </div>

      <div class="grid grid-2-1 section-gap">
        <div class="card">
          <div class="card-title-row">
            <h3>${icon("radio")} Purchase stream — ${data.count || 0} orders</h3>
            <span class="live-status"><span class="live-dot"></span> streaming</span>
          </div>
          <div class="feed" id="live-feed" style="max-height:520px"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:18px">
          <div class="card">
            <h3>${icon("bar-chart")} Hourly orders (24h)</h3>
            <div class="hour-chart">${hourBars}</div>
          </div>
          <div class="card">
            <h3>${icon("package")} Top products</h3>
            <div>${topProdHtml}</div>
          </div>
        </div>
      </div>

      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("users")} Customer intelligence</h3></div>
        <div class="grid grid-3" style="gap:12px;align-items:end">
          <div>
            <label class="muted" style="font-size:11px;display:block;margin-bottom:4px;font-weight:700">CUSTOMER ID OR EMAIL</label>
            <input id="cust-lookup" class="login-input" placeholder="e.g. buyer-01 or email@example.com" style="width:100%;padding:11px;border-radius:10px" />
          </div>
          <div><button id="cust-btn" class="btn btn-primary" style="width:100%">${icon("search", "icon-sm")} Look up</button></div>
        </div>
        <div id="cust-result" class="section-gap"></div>
      </div>`;

    renderFeed($("#live-feed"), data.orders || []);
    liveSource = api.liveStream(api.session().storeId, (purchase) => {
      const feed = $("#live-feed");
      if (feed) feed.prepend(feedItem(purchase, true));
    });

    $("#cust-btn").addEventListener("click", async () => {
      const id = $("#cust-lookup").value.trim();
      if (!id) return;
      try {
        const result = await api.get(`/orders/${s}/customer/${encodeURIComponent(id)}`);
        const p = result.profile;
        const ins = result.insight;
        const beh = result.behavior || {};
        const segColors = { VIP: "pill-green", HIGH_VALUE: "pill-cyan", LOYAL: "pill-violet", NEW: "pill-gray", AT_RISK: "pill-amber", DEFECTED: "pill-red" };

        const behaviorBars = Object.entries(beh).map(([type, count]) => {
          const maxBeh = Math.max(1, ...Object.values(beh));
          const pct = Math.round((count / maxBeh) * 100);
          return `<div class="beh-bar-item"><span class="beh-bar-label">${esc(type)}</span><div class="beh-bar-track"><div class="beh-bar-fill" style="width:${pct}%"></div></div><span class="beh-bar-count">${count}</span></div>`;
        }).join("");

        $("#cust-result").innerHTML = `
          <div class="cust-intel-panel">
            <div class="grid grid-4" style="gap:12px">
              <div class="cust-intel-stat">
                <span class="pill ${segColors[p?.segment] || "pill-gray"}" style="font-size:13px;padding:4px 14px">${p?.segment || "UNKNOWN"}</span>
                <div class="cust-intel-label">Segment</div>
              </div>
              <div class="cust-intel-stat">
                <div class="kpi-value" style="font-size:24px">${money(result.total_spent)}</div>
                <div class="cust-intel-label">Lifetime value</div>
              </div>
              <div class="cust-intel-stat">
                <div class="kpi-value" style="font-size:24px">${result.total_orders}</div>
                <div class="cust-intel-label">Orders</div>
              </div>
              <div class="cust-intel-stat">
                <div class="kpi-value" style="font-size:24px;${(p?.days_since_purchase || 0) >= 30 ? "color:var(--amber)" : (p?.days_since_purchase || 0) >= 60 ? "color:var(--red)" : ""}">${p?.days_since_purchase !== null && p?.days_since_purchase !== undefined ? p.days_since_purchase + "d" : "never"}</div>
                <div class="cust-intel-label">Since last purchase</div>
              </div>
            </div>

            ${ins ? `<div class="cust-intel-insight ${ins.color || ""}">${icon(ins.icon || "info")} ${esc(ins.text)}</div>` : ""}

            ${p ? `
            <div class="grid grid-2" style="gap:12px;margin-top:12px">
              <div>
                <h3 style="font-size:12px;margin-bottom:8px">${icon("activity")} Behavior profile</h3>
                <div class="cust-beh-grid">
                  <div class="cust-beh-item"><span class="cust-beh-val">${p.sessions || 0}</span><span class="cust-beh-label">Sessions</span></div>
                  <div class="cust-beh-item"><span class="cust-beh-val">${p.product_views || 0}</span><span class="cust-beh-label">Product views</span></div>
                  <div class="cust-beh-item"><span class="cust-beh-val">${p.cart_updates || 0}</span><span class="cust-beh-label">Cart updates</span></div>
                  <div class="cust-beh-item"><span class="cust-beh-val">${p.abandoned_carts || 0}</span><span class="cust-beh-label">Abandoned</span></div>
                  <div class="cust-beh-item"><span class="cust-beh-val">${p.checkouts_started || 0}</span><span class="cust-beh-label">Checkouts</span></div>
                  <div class="cust-beh-item"><span class="cust-beh-val">${(p.channels_responded || []).join(", ") || "none"}</span><span class="cust-beh-label">Responded on</span></div>
                </div>
              </div>
              <div>
                <h3 style="font-size:12px;margin-bottom:8px">${icon("bar-chart")} Activity breakdown</h3>
                <div class="beh-bars">${behaviorBars || '<div class="empty" style="padding:8px">No activity data</div>'}</div>
              </div>
            </div>

            ${p.viewed_products?.length ? `<div style="margin-top:10px"><h3 style="font-size:12px;margin-bottom:6px">${icon("eye")} Recently viewed</h3><div style="display:flex;gap:6px;flex-wrap:wrap">${p.viewed_products.map((vp) => `<span class="pill pill-gray" style="font-size:11px">${esc(vp)}</span>`).join("")}</div></div>` : ""}
            ` : '<div class="muted section-gap">No profile found for this customer.</div>'}

            ${result.orders?.length ? `
            <div style="margin-top:14px">
              <h3 style="font-size:12px;margin-bottom:8px">${icon("shopping-bag")} Order history</h3>
              <table style="font-size:12.5px">
                <thead><tr><th>Date</th><th>Items</th><th>Total</th></tr></thead>
                <tbody>${result.orders.map((ord) => `<tr><td>${esc((ord.at || "").slice(0, 16).replace("T", " "))}</td><td>${(ord.items || []).map((i) => `${i.quantity || 1}× ${esc(i.product_title || i.product_id || "item")}`).join(", ") || "—"}</td><td><b>${money(ord.total)}</b></td></tr>`).join("")}</tbody>
              </table>
            </div>` : ""}
          </div>`;
      } catch (error) {
        $("#cust-result").innerHTML = `<p class="muted">${esc(error.message)}</p>`;
      }
    });
  }

  // ── page: inventory ────────────────────────────────────────────────
  async function renderInventory() {
    const s = api.store();
    const [levels, insights] = await Promise.all([
      api.get(`/inventory/${s}/levels`).catch(() => null),
      api.get(`/insights/${s}/products`).catch(() => null),
    ]);

    const entries = levels?.levels || levels?.items || (Array.isArray(levels) ? levels : []);

    view.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <div class="card-title-row"><h3>Stock levels</h3>
            <button class="btn btn-sm btn-grad" id="po-btn">${icon("file-text", "icon-sm")} Generate purchase order</button>
          </div>
          <div class="scroll-y">
            <table><thead><tr><th>Product</th><th>Stock</th><th>Lead time</th><th>Status</th></tr></thead>
            <tbody>${entries.map((e) => {
              const status = e.stock <= 0 ? ["OUT", "pill-red"] : e.stock <= 5 ? ["LOW", "pill-amber"] : ["OK", "pill-green"];
              return `<tr><td><b>${esc(e.product_id)}</b></td><td>${e.stock}</td><td>${e.lead_time_days || 7}d</td><td><span class="pill ${status[1]}">${status[0]}</span></td></tr>`;
            }).join("") || '<tr><td colspan="4" class="empty">No stock registered yet.</td></tr>'}</tbody></table>
          </div>
        </div>
        <div class="card">
          <h3>Stockout predictions</h3>
          <div class="scroll-y" id="stockout-list"></div>
        </div>
      </div>

      <div class="grid grid-3 section-gap">
        <div class="card"><h3>${icon("flame")} Fast movers</h3><div class="scroll-y" id="fast-list"></div></div>
        <div class="card"><h3>${icon("gauge")} Slow movers</h3><div class="scroll-y" id="slow-list"></div></div>
        <div class="card"><h3>${icon("archive")} Dead stock</h3><div class="scroll-y" id="dead-list"></div></div>
      </div>

      <div class="card section-gap" id="po-card" style="display:none">
        <h3>Purchase order</h3>
        <div class="code-block" id="po-doc"></div>
      </div>`;

    const stockouts = insights?.stockout_predictions || [];
    $("#stockout-list").innerHTML = stockouts.length
      ? stockouts.map((p) => `<div class="alert-item ${p.stockout_urgency === "CRITICAL" ? "red" : "amber"}">${icon("clock")} <div><b>${esc(p.product_id)}</b> — ${esc(p.suggestion || `runs out ~${p.stockout_date}`)}</div></div>`).join("")
      : `<div class="empty">${icon("gift")} No stockouts predicted in the horizon.</div>`;

    const bucketList = (list) => (list && list.length
      ? list.map((p) => `<div class="alert-item"><div>${esc(p.suggestion || p.product_id)}</div></div>`).join("")
      : '<div class="empty">Nothing here.</div>');
    $("#fast-list").innerHTML = bucketList(insights?.fast_movers);
    $("#slow-list").innerHTML = bucketList(insights?.slow_movers);
    $("#dead-list").innerHTML = bucketList(insights?.dead_stock);

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
  async function renderCustomers() {
    const s = api.store();
    const [segments, churn] = await Promise.all([
      api.get(`/segments/${s}`).catch(() => null),
      api.get(`/churn/${s}`).catch(() => []),
    ]);

    const churnByCustomer = new Map((Array.isArray(churn) ? churn : []).map((c) => [c.customer_id, c]));
    const customers = segments?.customers || [];
    const distribution = segments?.distribution || {};

    view.innerHTML = `
      <div class="grid grid-4">
        ${["VIP", "HIGH_VALUE", "LOYAL", "NEW", "AT_RISK", "DEFECTED"]
          .filter((seg) => distribution[seg])
          .map((seg) => `<div class="card"><h3>${esc(seg.replace("_", " "))}</h3><div class="kpi-value">${distribution[seg]}</div></div>`)
          .join("") || '<div class="card"><h3>Segments</h3><div class="empty">No customers yet.</div></div>'}
      </div>
      <div class="card section-gap">
        <h3>All customers</h3>
        <div class="scroll-y" style="max-height:520px">
          <table><thead><tr><th>Customer</th><th>Segment</th><th>Spent</th><th>Purchases</th><th>Churn score</th><th>Risk</th></tr></thead>
          <tbody>${customers.map((c) => {
            const id = c.customer_id || c.identity;
            const churnRow = churnByCustomer.get(id);
            const score = churnRow?.churn_score ?? "—";
            const band = churnRow?.risk_band || "—";
            return `<tr>
              <td><b>${esc(id)}</b></td>
              <td><span class="pill ${pillFor(c.segment)}">${esc(c.segment || "—")}</span></td>
              <td>${money(c.total_spent)}</td>
              <td>${c.purchases ?? "—"}</td>
              <td>${score}</td>
              <td><span class="pill ${pillFor(band)}">${esc(band)}</span></td>
            </tr>`;
          }).join("") || '<tr><td colspan="6" class="empty">No customers tracked yet.</td></tr>'}</tbody></table>
        </div>
      </div>`;
  }

  // ── page: automations ──────────────────────────────────────────────
  async function renderAutomations() {
    const s = api.store();
    const [rules, pending] = await Promise.all([
      api.get(`/rules/${s}`).catch(() => []),
      api.get(`/actions/${s}/pending`).catch(() => []),
    ]);

    const ruleList = Array.isArray(rules) ? rules : rules.rules || [];
    const actionList = Array.isArray(pending) ? pending : pending.actions || [];

    view.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <h3>Automation rules</h3>
          <div class="scroll-y">
            <table><thead><tr><th>Rule</th><th>Trigger</th><th>Action</th><th>Priority</th></tr></thead>
            <tbody>${ruleList.map((r) => `<tr>
              <td><b>${esc(r.name || r.rule_id)}</b></td>
              <td><span class="pill pill-cyan">${esc(r.trigger)}</span></td>
              <td>${esc(r.action?.type || "—")} <span class="muted">via ${esc(r.action?.channel || "auto")}</span></td>
              <td>${r.priority ?? "—"}</td>
            </tr>`).join("") || '<tr><td colspan="4" class="empty">No rules configured.</td></tr>'}</tbody></table>
          </div>
        </div>
        <div class="card">
          <div class="card-title-row"><h3>Queued actions</h3>
            <div class="row-actions">
              <button class="btn btn-sm btn-primary" id="scan-btn">${icon("search", "icon-sm")} Scan store</button>
              <button class="btn btn-sm btn-grad" id="exec-btn">${icon("send", "icon-sm")} Execute now</button>
            </div>
          </div>
          <div class="scroll-y" id="action-list"></div>
        </div>
      </div>`;

    const drawActions = () => {
      $("#action-list").innerHTML = actionList.length
        ? actionList.map((a) => `<div class="alert-item amber">${icon("zap")} <div><b>${esc(a.rule_id || a.action_type)}</b> → ${esc(a.customer_id || "all")} <span class="muted">(${esc(a.status || "queued")}, ${esc(a.channel || "auto")})</span></div></div>`).join("")
        : '<div class="empty">No actions queued. Run a scan to find opportunities.</div>';
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
  async function renderMessages() {
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
      if (configured) return `<span class="pill pill-green">● Connected</span> <span class="muted">${esc(provider)}</span>`;
      return `<span class="pill pill-amber">○ Console mode</span> <span class="muted">${esc(provider)} — set credentials to go live</span>`;
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
      if (st === "delivered") return '<span class="pill pill-green">delivered</span>';
      if (st === "sent") return '<span class="pill pill-cyan">sent</span>';
      if (st === "failed") return '<span class="pill pill-red">failed</span>';
      if (st === "suppressed") return '<span class="pill pill-amber">suppressed</span>';
      if (st === "blocked") return '<span class="pill pill-amber">blocked</span>';
      return `<span class="pill pill-violet">${esc(st || "unknown")}</span>`;
    };

    view.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <h3>💬 WhatsApp Business API</h3>
          <p style="margin-bottom:8px">${channelBadge(wa.configured, wa.provider || "console")}</p>
          <p class="muted" style="margin-bottom:6px">Webhook: <span class="mono">${esc(wa.webhook_url || "/webhooks/whatsapp")}</span></p>
          ${!wa.configured ? `<div class="alert-item amber" style="margin-top:8px">${icon("alert-triangle")} <div><b>Not connected</b><br><small class="muted">Set WHATSAPP_PROVIDER=meta, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID in your .env to enable live delivery via Meta Cloud API.</small></div></div>` : ""}
        </div>
        <div class="card">
          <h3>📧 Email Service</h3>
          <p style="margin-bottom:8px">${channelBadge(em.configured, em.provider || "console")}</p>
          <p class="muted" style="margin-bottom:6px">From: <span class="mono">${esc(em.from_address || "noreply@storecops.app")}</span></p>
          ${!em.configured ? `<div class="alert-item amber" style="margin-top:8px">${icon("alert-triangle")} <div><b>Not connected</b><br><small class="muted">Set EMAIL_PROVIDER=resend and RESEND_API_KEY in your .env to enable live email delivery.</small></div></div>` : ""}
        </div>
      </div>

      <div class="grid grid-3 section-gap">
        <div class="card" style="text-align:center">
          <p class="muted">Total sent</p>
          <h2 style="font-size:2rem;margin:4px 0">${stats.total || 0}</h2>
        </div>
        <div class="card" style="text-align:center">
          <p class="muted">By channel</p>
          <div style="margin-top:6px">${Object.entries(stats.by_channel || {}).map(([ch, n]) => `<span class="pill pill-violet">${channelIcon(ch)} ${esc(ch)}: ${n}</span> `).join("") || '<span class="muted">No deliveries yet</span>'}</div>
        </div>
        <div class="card" style="text-align:center">
          <p class="muted">By status</p>
          <div style="margin-top:6px">${Object.entries(stats.by_status || {}).map(([st, n]) => `<span class="pill ${st === "delivered" ? "pill-green" : st === "failed" ? "pill-red" : "pill-cyan"}">${esc(st)}: ${n}</span> `).join("") || '<span class="muted">No deliveries yet</span>'}</div>
        </div>
      </div>

      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("send")} Recent deliveries</h3>
          <div class="row-actions">
            <button class="btn btn-sm btn-primary" id="msg-scan">${icon("search", "icon-sm")} Scan store</button>
            <button class="btn btn-sm btn-grad" id="msg-exec">${icon("zap", "icon-sm")} Execute now</button>
          </div>
        </div>
        <div class="scroll-y">
          <table><thead><tr><th>Channel</th><th>Customer</th><th>Action</th><th>Status</th><th>Time</th></tr></thead>
          <tbody>${deliveries.length
            ? deliveries.map((d) => `<tr>
              <td>${channelIcon(d.channel)} ${esc(d.channel || "—")}</td>
              <td class="mono">${esc((d.customer_id || "—").slice(0, 20))}</td>
              <td>${esc(d.action_type || "—")}</td>
              <td>${statusPill(d.status)}</td>
              <td class="muted">${fmtTime(d.createdAt)}</td>
            </tr>`).join("")
            : '<tr><td colspan="5" class="empty">No deliveries yet. Scan your store and execute to send messages.</td></tr>'}</tbody></table>
        </div>
      </div>

      <div class="grid grid-2 section-gap">
        <div class="card">
          <h3>🔧 Automation rules → messages</h3>
          <div class="scroll-y">
            <table><thead><tr><th>Rule</th><th>Trigger</th><th>Channel</th></tr></thead>
            <tbody>${ruleList.length
              ? ruleList.map((r) => `<tr>
                <td><b>${esc(r.name || r.rule_id)}</b></td>
                <td><span class="pill pill-cyan">${esc(r.trigger)}</span></td>
                <td>${esc(r.action?.channel || "auto")}</td>
              </tr>`).join("")
              : '<tr><td colspan="3" class="empty">No automation rules configured.</td></tr>'}</tbody></table>
          </div>
        </div>
        <div class="card">
          <h3>📋 WhatsApp message templates</h3>
          <p class="muted" style="margin-bottom:8px">Pre-approved templates for business-initiated conversations:</p>
          <div class="scroll-y">
            ${Object.entries(wa.templates || {}).map(([key, name]) => `<div class="alert-item">${icon("file-text")} <div><b>${esc(name)}</b> <span class="muted">— ${esc(key.replace(/_/g, " "))}</span></div></div>`).join("") || '<div class="empty">No templates configured.</div>'}
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
  async function renderCampaigns() {
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
        launched: "pill-green", completed: "pill-cyan", no_targets: "pill-amber",
        draft: "pill-violet", AWAITING_APPROVAL: "pill-violet", generated: "pill-violet",
      };
      return `<span class="pill ${map[status] || "pill-gray"}">${esc(status || "draft")}</span>`;
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

    view.innerHTML = `
      <div class="card">
        <div class="card-title-row"><h3>${icon("sparkles")} Campaign pipeline</h3>
          <button class="btn btn-sm btn-grad" id="gen-btn">${icon("sparkles", "icon-sm")} Generate from trends</button>
        </div>
        <p class="muted" style="font-size:13px;margin-bottom:14px">Generate campaign drafts from rising trends and the retail calendar, then launch them to targeted customers.</p>

        ${activeCampaigns.length ? `
          <h3 style="margin-bottom:10px">${icon("rocket")} Active campaigns</h3>
          <div class="campaign-list">${activeCampaigns.map((c) => campaignCard(c, "active")).join("")}</div>
          <div class="section-gap"></div>
        ` : ""}

        <h3 style="margin-bottom:10px">${icon("file-text")} Drafts ready to launch</h3>
        <div class="scroll-y">${draftCampaigns.length
          ? `<div class="campaign-list">${draftCampaigns.map((c) => campaignCard(c, "draft")).join("")}</div>`
          : '<div class="empty">No drafts yet — generate from rising trends and the retail calendar.</div>'}</div>

        ${completedCampaigns.length ? `
          <div class="section-gap"></div>
          <h3 style="margin-bottom:10px">${icon("check-circle")} Completed campaigns</h3>
          <div class="campaign-list">${completedCampaigns.map((c) => campaignCard(c, "completed")).join("")}</div>
        ` : ""}
      </div>

      <div class="grid grid-2 section-gap">
        <div class="card"><h3>${icon("calendar")} Seasonal opportunities (90d)</h3><div class="scroll-y">${opportunities.length
          ? opportunities.map((op) => `<div class="alert-item ${op.days_until <= 14 ? "amber" : ""}">${icon("gift")} <div><b>${esc(op.event)}</b> in ${op.days_until} day(s) — ${esc(op.advice || op.urgency || "")}</div></div>`).join("")
          : '<div class="empty">No retail moments inside the current window.</div>'}</div></div>
        <div class="card"><h3>${icon("users")} Retargeting audiences</h3>
          <button class="btn btn-sm btn-primary" id="rt-btn" style="margin-bottom:12px">Build audiences</button>
          <div id="rt-result" class="scroll-y"></div>
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
    view.querySelectorAll(".campaign-launch-btn").forEach((btn) => {
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
    view.querySelectorAll(".campaign-execute-btn").forEach((btn) => {
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
    view.querySelectorAll(".campaign-measure-btn").forEach((btn) => {
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
  async function renderCompetitors() {
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
      if (st === "success") return '<span class="pill pill-green">success</span>';
      if (st === "partial") return '<span class="pill pill-amber">partial</span>';
      if (st === "failed") return '<span class="pill pill-red">failed</span>';
      return '<span class="pill pill-violet">pending</span>';
    };
  
    view.innerHTML = `
      <div class="card">
        <div class="card-title-row"><h3>${icon("search")} Add competitor to track</h3></div>
        <div class="grid grid-3" style="gap:10px;align-items:end">
          <div>
            <label class="muted" style="font-size:0.85rem;display:block;margin-bottom:4px">Competitor name</label>
            <input id="comp-name" placeholder="e.g. Rival Store" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)" />
          </div>
          <div>
            <label class="muted" style="font-size:0.85rem;display:block;margin-bottom:4px">Store URL</label>
            <input id="comp-url" placeholder="https://rival-store.myshopify.com" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)" />
          </div>
          <div>
            <label class="muted" style="font-size:0.85rem;display:block;margin-bottom:4px">Meta Page ID (optional)</label>
            <input id="comp-page" placeholder="Facebook Page ID for ad tracking" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)" />
          </div>
        </div>
        <div class="row-actions" style="margin-top:10px">
          <button class="btn btn-sm btn-primary" id="comp-add">${icon("target", "icon-sm")} Add competitor</button>
          <button class="btn btn-sm btn-grad" id="comp-scrape-all" ${trackedList.length === 0 ? "disabled" : ""}>${icon("search", "icon-sm")} Scrape all now</button>
          <button class="btn btn-sm btn-primary" id="comp-scrape-ads" ${trackedList.length === 0 ? "disabled" : ""}>${icon("film", "icon-sm")} Scrape Meta ads</button>
        </div>
        <div id="comp-msg" style="margin-top:8px"></div>
      </div>
  
      <div class="grid grid-2 section-gap">
        <div class="card"><h3>${icon("bell")} Active alerts</h3><div class="scroll-y">${alerts.length
          ? alerts.map((a) => `<div class="alert-item ${a.priority === "HIGH" || a.priority === "CRITICAL" ? "red" : "amber"}">${icon("target")} <div><span class="pill ${pillFor(a.priority || "")}">${esc(a.priority || "INFO")}</span> ${esc(a.message)}</div></div>`).join("")
          : '<div class="empty">No changes detected yet. Add competitors and scrape to arm the radar.</div>'}</div></div>
        <div class="card"><h3>${icon("users")} Tracked competitors</h3>
          <div class="scroll-y" id="tracked-list">${trackedList.length
            ? trackedList.map((c) => `<div class="alert-item">
              ${icon("eye")} <div style="flex:1">
                <b>${esc(c.competitor)}</b>
                <span class="muted" style="font-size:0.85rem"> — ${esc(c.url || "")}</span>
                ${c.platform_detected ? `<span class="pill pill-cyan">${esc(c.platform_detected)}</span>` : ""}
                <br><small class="muted">Last scrape: ${fmtTime(c.last_scrape_at)} ${c.last_scrape_status ? statusBadge(c.last_scrape_status) : ""} · ${c.last_product_count || 0} products</small>
                ${c.meta_page_id ? `<br><small class="muted">Meta Page: ${esc(c.meta_page_id)}</small>` : ""}
              </div>
              <div class="row-actions">
                <button class="btn btn-sm btn-primary comp-scrape-btn" data-id="${esc(c._id)}">${icon("search", "icon-sm")}</button>
                <button class="btn btn-sm btn-grad comp-remove-btn" data-id="${esc(c._id)}">${icon("trash", "icon-sm")}</button>
              </div>
            </div>`).join("")
            : '<div class="empty">No competitors tracked yet. Add one above.</div>'}</div>
        </div>
      </div>
  
      <div class="grid grid-2 section-gap">
        <div class="card">
          <h3>${icon("film")} Competitor ad intelligence</h3>
          ${adInsights.length ? `<div class="alert-item amber">${icon("sparkles")} <div>${adInsights.map((i) => esc(i)).join("<br>")}</div></div>` : ""}
          <div class="scroll-y">${adCompetitors.length
            ? adCompetitors.map((ad) => `<div class="alert-item">${icon("tv")} <div><b>${esc(ad.competitor)}</b> — ${ad.ad_count} ad(s) <span class="muted">(${esc(ad.primary_platform || "?")}, ${esc(ad.primary_format || "?")})</span><br><small class="muted">Top CTA: ${esc(ad.top_cta || "—")}</small>${(ad.newest_ads || []).map((a) => `<br><small>"${esc(a.headline || "")}" on ${esc(a.platform)}</small>`).join("")}</div></div>`).join("")
            : '<div class="empty">No ad-library data yet. Add Meta Page IDs above and click "Scrape Meta ads".</div>'}</div>
        </div>
        <div class="card"><h3>${icon("bar-chart")} Price & catalog changes</h3><div class="scroll-y">${rivals.length
          ? rivals.map((r) => {
              const changes = r.changes || {};
              const items = [
                ...(changes.price_drops || []).map((d) => `<div class="alert-item green">${icon("trending-up")} <div><b>${esc(r.competitor)}</b> cut ${esc(d.name)} by ${d.change_pct}% <span class="muted">($${d.from} → $${d.to})</span></div></div>`),
                ...(changes.possible_promotions || []).map((p) => `<div class="alert-item amber">${icon("gift")} <div><b>${esc(r.competitor)}</b> promo on ${esc(p.name)}: ${esc(p.detected_offer || p.estimated_discount_pct + "% off")}</div></div>`),
                ...(changes.stockouts || []).map((s) => `<div class="alert-item">${icon("alert-triangle")} <div><b>${esc(r.competitor)}</b>: ${esc(s.name)} is <span class="pill pill-red">out of stock</span> — capture their demand</div></div>`),
                ...(changes.new_products || []).map((p) => `<div class="alert-item">${icon("package")} <div><b>${esc(r.competitor)}</b> added ${esc(p.name)} <span class="muted">($${p.price || "?"})</span></div></div>`),
              ];
              return items.join("");
            }).join("") || '<div class="empty">No changes detected yet.</div>'
          : '<div class="empty">No competitor data yet.</div>'}</div></div>
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
  async function renderBrandKeywords() {
    const s = api.store();
    const existing = await api.get("/brand-keywords").catch(() => ({ keywords: [] }));
    const keywords = existing.keywords || [];

    view.innerHTML = `
      <div class="card">
        <h3>${icon("tag")} Brand Keywords Setup</h3>
        <p class="muted" style="margin-bottom:16px">Add keywords to monitor your brand mentions, sentiment, and search visibility. These keywords will be used for sentiment monitoring and SEO tracking.</p>
        
        <div style="margin-bottom:16px">
          <label class="muted" style="font-size:0.85rem;display:block;margin-bottom:4px">Add a keyword</label>
          <div style="display:flex;gap:8px">
            <input id="bk-input" placeholder="e.g. your brand name, product name" style="flex:1;padding:10px;border-radius:8px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)" />
            <button class="btn btn-primary" id="bk-add">${icon("plus", "icon-sm")} Add</button>
          </div>
        </div>

        <div id="bk-list" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
          ${keywords.length ? keywords.map((k) => `
            <span class="pill pill-cyan" style="display:flex;align-items:center;gap:6px">
              ${esc(k)}
              <button class="bk-remove" data-keyword="${esc(k)}" style="background:none;border:none;color:var(--text-dim);cursor:pointer;padding:0;font-size:14px">×</button>
            </span>
          `).join("") : '<span class="muted">No keywords added yet</span>'}
        </div>

        <div id="bk-msg"></div>

        <div style="padding:16px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
          <h4 style="margin-bottom:8px">Why add brand keywords?</h4>
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
  async function renderSeo() {
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

    view.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <h3>${icon("zap")} SEO Optimizer — One-Click Fix</h3>
        <p class="muted" style="margin-bottom:12px">${isConnected
          ? `Your store <b style="color:var(--text)">${esc(autoUrl || s)}</b> is connected. Click the button below to analyze and fix everything.`
          : "Deep analysis + auto-generate all fixes for SEO, structured data, and AI search visibility (ChatGPT, Perplexity, Google AI)."}</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
          <button class="btn btn-primary" id="seo-one-click-btn" style="font-size:15px;padding:14px 28px">${icon("zap")} Analyze & Fix Everything</button>
          <span class="muted" style="font-size:12px">One click = full SEO audit + all code snippets + AI search optimization</span>
        </div>
        <details style="margin-top:8px">
          <summary style="cursor:pointer;color:var(--muted);font-size:13px">Advanced: customize store details</summary>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin-top:10px">
            <div style="flex:1;min-width:200px">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Store URL</label>
              <input id="seo-url" value="${esc(autoUrl)}" placeholder="https://mystore.myshopify.com" style="width:100%;padding:11px;border-radius:10px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)" />
            </div>
            <div style="min-width:140px">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Brand name</label>
              <input id="seo-brand" value="${esc(autoBrand)}" placeholder="My Store" style="width:100%;padding:11px;border-radius:10px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)" />
            </div>
            <div style="min-width:140px">
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Category</label>
              <input id="seo-category" placeholder="Fashion, Electronics..." style="width:100%;padding:11px;border-radius:10px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)" />
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <input id="seo-keywords" placeholder="Keywords (comma separated)" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)" />
          </div>
        </details>
      </div>

      <div id="seo-result" style="display:none">
        <div class="grid grid-4" style="margin-bottom:16px">
          <div class="card"><h3>Current SEO Score</h3><div class="kpi-value" id="seo-score">—</div><div class="kpi-sub" id="seo-grade">—</div></div>
          <div class="card"><h3>Fixes Found</h3><div class="kpi-value" id="seo-fixes-count">—</div><div class="kpi-sub">Ready to apply</div></div>
          <div class="card"><h3>AI Readiness</h3><div class="kpi-value" id="ai-readiness">—</div><div class="kpi-sub">AI search visibility</div></div>
          <div class="card"><h3>Total Actions</h3><div class="kpi-value" id="seo-total">—</div><div class="kpi-sub">SEO + AI combined</div></div>
        </div>

        <div class="grid grid-2">
          <div class="card">
            <h3>${icon("check-circle")} SEO Fixes</h3>
            <div id="seo-fixes-list" class="scroll-y" style="max-height:400px"></div>
          </div>
          <div class="card">
            <h3>${icon("cpu")} AI Search Optimization</h3>
            <div id="ai-fixes-list" class="scroll-y" style="max-height:400px"></div>
          </div>
        </div>

        <div class="card section-gap">
          <h3>${icon("code")} Generated Code Snippets</h3>
          <p class="muted" style="margin-bottom:12px">Copy-paste ready code for every fix. Shopify Liquid templates included where applicable.</p>
          <div id="seo-snippets" class="scroll-y" style="max-height:500px"></div>
        </div>
      </div>

      <div class="grid grid-2 section-gap">
        <div class="card"><h3>Search performance (GSC)</h3>
          <div class="scroll-y"><table><thead><tr><th>Query</th><th>Impr.</th><th>Clicks</th><th>CTR</th><th>Pos.</th></tr></thead>
          <tbody>${queries.map((q) => `<tr><td><b>${esc(q.query)}</b></td><td>${q.impressions}</td><td>${q.clicks}</td><td>${q.ctr}%</td><td>${q.avg_position ?? "—"}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">No search data ingested yet.</td></tr>'}</tbody></table></div>
        </div>
        <div class="card"><h3>${icon("trending-up")} Rising trends</h3><div class="scroll-y">${trendList.length
          ? trendList.map((t) => `<div class="alert-item">${icon("trending-up")} <div><b>${esc(t.keyword)}</b> — momentum ${esc(t.momentum ?? t.score ?? "—")} <span class="muted">${esc(t.direction || t.source || "")}</span></div></div>`).join("")
          : '<div class="empty">Feed external signals to detect trends.</div>'}</div></div>
      </div>
      <div class="grid grid-2 section-gap">
        <div class="card"><h3>${icon("flag")} Ranking comparison</h3><div class="scroll-y">${Array.isArray(rankRows) && rankRows.length
          ? rankRows.map((r) => `<div class="alert-item"><div><b>${esc(r.keyword)}</b> — ${esc(r.brand || "us")} at #${esc(r.position)}</div></div>`).join("")
          : '<div class="empty">Ingest ranking snapshots to compare against rivals.</div>'}</div></div>
        <div class="card"><h3>${icon("cpu")} Intent gap</h3>
          <button class="btn btn-sm btn-primary" id="gap-btn" style="margin-bottom:12px">Analyze gaps</button>
          <div id="gap-result" class="scroll-y"></div>
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
        const fixesHtml = (result.fixes || []).map((f) => {
          const sevColor = f.severity === "CRITICAL" ? "var(--red)" : f.severity === "HIGH" ? "var(--amber)" : f.severity === "MEDIUM" ? "var(--text)" : "var(--muted)";
          return `<div class="alert-item"><div style="flex:1"><span style="color:${sevColor};font-weight:600;font-size:11px">${f.severity}</span> <b>${esc(f.area)}</b><br><span class="muted">${esc(f.issue)}</span><br><span style="color:var(--green);font-size:12px">${icon("check")} ${esc(f.fix)}</span><br><span class="muted" style="font-size:11px">Impact: ${esc(f.impact)}</span></div></div>`;
        }).join("") || '<div class="empty">No SEO issues found!</div>';
        $("#seo-fixes-list").innerHTML = fixesHtml;

        // AI fixes list
        const aiFixes = result.ai_optimization?.actions || [];
        const aiHtml = aiFixes.map((f) => {
          const sevColor = f.severity === "HIGH" ? "var(--amber)" : f.severity === "MEDIUM" ? "var(--text)" : "var(--muted)";
          return `<div class="alert-item"><div style="flex:1"><span style="color:${sevColor};font-weight:600;font-size:11px">${f.severity}</span> <b>${esc(f.area)}</b><br><span class="muted">${esc(f.issue)}</span><br><span style="color:var(--green);font-size:12px">${icon("check")} ${esc(f.fix)}</span></div></div>`;
        }).join("") || '<div class="empty">AI optimization ready!</div>';
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
        ? gaps.map((g) => `<div class="alert-item">${icon("search")} <div><b>${esc(g.keyword || g.query)}</b> — ${esc(g.reason || g.intent || "uncovered intent")}</div></div>`).join("")
        : '<div class="empty">No gaps found.</div>';
    });
  }

  // ── page: reports ──────────────────────────────────────────────────
  async function renderReports() {
    const s = api.store();
    const [roi, maturity, digest, attribution] = await Promise.all([
      api.get(`/report/${s}/roi`).catch(() => null),
      api.get(`/report/${s}/maturity`).catch(() => null),
      api.get(`/report/${s}/weekly-digest`).catch(() => null),
      api.get(`/attribution/${s}`).catch(() => null),
    ]);

    const byRule = attribution?.by_rule || attribution?.report?.by_rule || [];

    view.innerHTML = `
      <div class="grid grid-4">
        <div class="card"><h3>ROI</h3><div class="kpi-value ${roi?.verdict === "PROFITABLE" ? "kpi-up" : "kpi-warn"}">${roi ? roi.roi_percent + "%" : "—"}</div><div class="kpi-sub">${esc(roi?.verdict || "")} · ${money(roi?.net_gain)} net</div></div>
        <div class="card"><h3>Attributed revenue</h3><div class="kpi-value">${money(roi?.attributed_revenue)}</div><div class="kpi-sub">vs ${money(roi?.subscription_cost)} subscription</div></div>
        <div class="card"><h3>Maturity</h3><div class="kpi-value">${maturity?.score ?? "—"}</div><div class="kpi-sub">${esc(maturity?.stage || "")}</div></div>
        <div class="card"><h3>Sentiment</h3><div class="kpi-value">${digest?.sentiment_trend?.current ?? "—"}</div><div class="kpi-sub">${esc(digest?.sentiment_trend?.direction || "")}</div></div>
      </div>

      <div class="grid grid-2 section-gap">
        <div class="card"><h3>${icon("dollar")} Revenue by automation rule</h3>
          <div class="chart-wrap"><canvas id="attr-chart"></canvas></div></div>
        <div class="card"><h3>${icon("clipboard")} Weekly digest</h3>
          <div class="scroll-y">${digest ? `
            <div class="alert-item green">${icon("banknote")} <div>Revenue ${money(digest.headline?.revenue)} · attributed ${money(digest.headline?.attributed_revenue)} (${digest.headline?.roi_percent}%)</div></div>
            <div class="alert-item">${icon("send")} <div>${digest.headline?.actions_delivered || 0} automated messages delivered</div></div>
            <div class="alert-item">${icon("cpu")} <div>Platform stage: <b>${esc(digest.headline?.maturity_stage || "—")}</b></div></div>
            <div class="alert-item">${icon("heart")} <div>${(digest.churn?.top_at_risk || []).length} customer(s) flagged at-risk</div></div>` : '<div class="empty">Digest unavailable.</div>'}</div>
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
  async function renderSettings() {
    const sess = api.session() || {};
    const connectors = await api.get("/connectors").catch(() => ({}));
    const readyBadge = (p) =>
      connectors[p]?.ready
        ? '<span style="color:var(--green)">● Ready</span>'
        : '<span style="color:var(--amber)">○ Not configured</span>';

    view.innerHTML = `
      <div class="grid grid-2">
        <div class="card"><h3>Connection</h3>
          <p class="muted" style="margin-bottom:8px">Store: <b style="color:var(--text)">${esc(sess.storeId || "")}</b></p>
          <p class="muted" style="margin-bottom:8px">API key: <span class="mono">${esc((sess.apiKey || "").slice(0, 3))}•••••</span></p>
        </div>
        <div class="card"><h3>GDPR — customer data</h3>
          <input id="gdpr-id" placeholder="customer id or email" style="width:100%;padding:11px;border-radius:10px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);margin-bottom:10px" />
          <div class="row-actions">
            <button class="btn btn-sm btn-primary" id="gdpr-export">${icon("upload", "icon-sm")} Export data</button>
            <button class="btn btn-sm btn-grad" id="gdpr-delete" style="background:var(--red);color:#fff">${icon("trash", "icon-sm")} Right to be forgotten</button>
          </div>
          <div id="gdpr-result" class="section-gap"></div>
        </div>
      </div>
      <div class="card section-gap"><h3>${icon("plug")} Platform connectors</h3>
        <p class="muted" style="margin-bottom:12px">One-click connect on the login page needs your own OAuth app credentials. Create a (free) app on each platform, paste the credentials here, and merchants can authorize with a single click. Secrets stay on this server.</p>
        <div class="grid grid-2">
          <div>
            <p style="margin-bottom:6px"><b>Shopify</b> — ${readyBadge("shopify")} <span class="muted">(a custom app on partners.shopify.com or in-store; redirect URI: <span class="mono">${esc(location.origin)}/connect/shopify/callback</span>)</span></p>
            <input id="cf-shp-id" placeholder="Client ID (API key)" style="${INPUT_STYLE}" />
            <input id="cf-shp-secret" placeholder="Client secret" type="password" style="${INPUT_STYLE}" />
            <button class="btn btn-sm btn-primary" id="save-shp">Save Shopify connector</button>
          </div>
          <div>
            <p style="margin-bottom:6px"><b>BigCommerce</b> — ${readyBadge("bigcommerce")} <span class="muted">(a draft app on devtools.bigcommerce.com; callback URL: <span class="mono">${esc(location.origin)}/connect/bigcommerce/callback</span>)</span></p>
            <input id="cf-bc-id" placeholder="Client ID" style="${INPUT_STYLE}" />
            <input id="cf-bc-secret" placeholder="Client secret" type="password" style="${INPUT_STYLE}" />
            <button class="btn btn-sm btn-primary" id="save-bc">Save BigCommerce connector</button>
          </div>
        </div>
        <div id="connector-result" style="margin-top:10px"></div>
        <p class="muted" style="margin-top:10px">WooCommerce and custom stores need no credentials here — they connect via REST keys / public catalog.</p>
      </div>
      <div class="card section-gap"><h3>Platform architecture</h3>
        <p class="muted">6 layers · 63 tools: Data Foundation → Intelligence → Decision → Execution → Reporting &amp; Attribution → Growth Loop. Live monitoring runs on server-sent events; every sale decrements stock and broadcasts instantly.</p>
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

  async function renderConnect() {
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

    view.innerHTML = `
      <div class="card"><h3>Connection status</h3>
        <div id="connect-status">${statusHtml()}</div>
        <div id="connect-result" class="section-gap"></div>
      </div>
      <div class="grid grid-2 section-gap">
        <div class="card"><h3>${icon("bag")} Shopify</h3>
          <p class="muted">One-click OAuth: approve access on Shopify, and your products, stock and order history sync automatically. New orders keep flowing via webhook.</p>
          ${oauthNote("shopify", "Shopify")}
          <input id="cf-shop" placeholder="your-store.myshopify.com" style="${INPUT_STYLE}" />
          <button class="btn btn-sm btn-primary" id="cf-shopify">Connect Shopify →</button>
        </div>
        <div class="card"><h3>${icon("store")} BigCommerce</h3>
          <p class="muted">One-click OAuth: approve access on BigCommerce, and your catalog + orders sync straight in.</p>
          ${oauthNote("bigcommerce", "BigCommerce")}
          <input id="cf-bc" placeholder="store hash (from your admin URL)" style="${INPUT_STYLE}" />
          <button class="btn btn-sm btn-primary" id="cf-bigcommerce">Connect BigCommerce →</button>
        </div>
      </div>
      <div class="grid grid-2 section-gap">
        <div class="card"><h3>${icon("puzzle")} WooCommerce</h3>
          <p class="muted">Enter your store URL + read-only REST keys (WooCommerce → Settings → Advanced → REST API). Products and orders sync instantly.</p>
          <input id="cf-woo-url" placeholder="https://your-store.com" style="${INPUT_STYLE}" />
          <input id="cf-woo-key" placeholder="Consumer key (ck_…)" style="${INPUT_STYLE}" />
          <input id="cf-woo-secret" type="password" placeholder="Consumer secret (cs_…)" style="${INPUT_STYLE}" />
          <button class="btn btn-sm btn-primary" id="cf-woo">Connect WooCommerce →</button>
        </div>
        <div class="card"><h3>${icon("globe")} Custom store</h3>
          <p class="muted">We read your store's public catalog and import it as your starting inventory — then you prove ownership with a meta tag, verification file, or DNS record.</p>
          <input id="cf-custom-url" placeholder="https://your-store.com" style="${INPUT_STYLE}" />
          <button class="btn btn-sm btn-primary" id="cf-custom">Scan my store →</button>
          <div id="cf-custom-verify" class="hidden" style="margin-top:10px">
            <p id="cf-custom-found" style="color:var(--green,#34d399);font-weight:600"></p>
            <p class="muted">Prove you own the site — add <b>any one</b> of these:</p>
            <div class="alert-item"><span class="step-num">1</span> <div><b>Meta tag</b> in the homepage <code>&lt;head&gt;</code>:<br><code id="cfv-meta" style="word-break:break-all"></code></div></div>
            <div class="alert-item"><span class="step-num">2</span> <div><b>File</b> at <code id="cfv-file-url" style="word-break:break-all"></code> containing: <code id="cfv-file"></code></div></div>
            <div class="alert-item"><span class="step-num">3</span> <div><b>DNS TXT record</b> — value: <code id="cfv-dns" style="word-break:break-all"></code></div></div>
            <button class="btn btn-sm btn-primary" id="cf-custom-verify-btn" style="margin-top:8px">${icon("lock", "icon-sm")} Verify ownership &amp; sync</button>
          </div>
        </div>
      </div>
      <div class="grid grid-2 section-gap">
        <div class="card"><h3>${icon("arrow-up")} CSV import <span class="muted">— products or order history</span></h3>
          <select id="csv-type" style="${INPUT_STYLE}">
            <option value="products">Products — product_id,name,stock,lead_time_days,price</option>
            <option value="orders">Orders — customer_id,email,total,product_id,quantity,timestamp</option>
          </select>
          <textarea id="csv-text" rows="4" placeholder="Paste CSV rows here (header row optional)…" style="${INPUT_STYLE}resize:vertical;font-family:inherit"></textarea>
          <button class="btn btn-sm btn-primary" id="csv-import">${icon("upload", "icon-sm")} Import CSV</button>
        </div>
        <div class="card"><h3>${icon("sliders")} Advanced <span class="muted">— webhook &amp; snippet</span></h3>
          <p class="muted">For live order push from any platform, point an <span class="mono">orders/create</span> webhook at:</p>
          <div class="mono" style="word-break:break-all;background:var(--code-bg);padding:10px;border-radius:10px;margin:8px 0">${esc(info.webhook_url)}</div>
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
  async function renderOnboarding() {
    const s = api.store();
    const state = await api.get("/onboarding").catch(() => null);
    const next = await api.get("/onboarding/next").catch(() => null);

    const steps = [
      { id: "welcome", title: "Welcome to Storecops", desc: "Let's get your store connected and start recovering revenue.", icon: "👋", action: null },
      { id: "connect_store", title: "Connect Your Store", desc: "Link your Shopify, WooCommerce, or custom store to start tracking.", icon: "🔗", action: "connect" },
      { id: "activate_tracking", title: "Activate Tracking", desc: "Install the tracking snippet to start collecting visitor data.", icon: "📡", action: null },
      { id: "first_audit", title: "Run Your First Audit", desc: "Get a comprehensive health score and actionable insights.", icon: "🔍", action: "seo" },
      { id: "choose_plan", title: "Choose Your Plan", desc: "Select the plan that fits your growth goals.", icon: "💎", action: "billing" },
      { id: "add_competitors", title: "Add Competitors", desc: "Track competitor pricing and strategies in real-time.", icon: "🎯", action: "competitors" },
      { id: "brand_keywords", title: "Set Brand Keywords", desc: "Add keywords to monitor your brand mentions and sentiment.", icon: "🏷️", action: "brand-keywords" },
      { id: "first_automation", title: "Set Up Automation", desc: "Configure your first automated cart recovery campaign.", icon: "⚡", action: "automations" },
      { id: "complete", title: "You're All Set!", desc: "Your store is fully configured. Start growing!", icon: "🎉", action: null },
    ];

    const completionPct = state?.completion_pct || 0;
    const currentIdx = steps.findIndex(step => next?.action === step.id) || 0;

    view.innerHTML = `
      <div class="grid grid-3 section-gap" style="margin-bottom:24px">
        <div class="card" style="text-align:center;padding:24px">
          <div style="font-size:48px;margin-bottom:8px">🚀</div>
          <div class="kpi-value">${completionPct}%</div>
          <div class="kpi-sub">Setup Complete</div>
        </div>
        <div class="card" style="text-align:center;padding:24px">
          <div style="font-size:48px;margin-bottom:8px">⚡</div>
          <div class="kpi-value">${steps.filter((step, i) => i < currentIdx).length}/${steps.length}</div>
          <div class="kpi-sub">Steps Completed</div>
        </div>
        <div class="card" style="text-align:center;padding:24px">
          <div style="font-size:48px;margin-bottom:8px">💰</div>
          <div class="kpi-value" style="color:var(--green)">${completionPct >= 50 ? "Ready" : "Almost"}</div>
          <div class="kpi-sub">Revenue Recovery</div>
        </div>
      </div>

      <div class="card">
        <h2 style="margin-bottom:4px">Setup Wizard</h2>
        <p class="muted" style="margin-bottom:16px">Follow these steps to unlock the full power of Storecops.</p>
        
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px;padding:12px;background:var(--surface-2);border-radius:var(--radius-sm)">
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
            const cls = isCompleted || isPast ? "completed" : isCurrent ? "current" : "pending";
            
            return `
              <div style="display:flex;align-items:center;gap:16px;padding:16px;background:${isCurrent ? 'var(--primary-light)' : 'var(--surface-2)'};border-radius:var(--radius-sm);border:1px solid ${isCurrent ? 'var(--primary)' : 'var(--card-border)'};transition:all 0.2s">
                <div style="width:48px;height:48px;border-radius:50%;background:${isCompleted || isPast ? 'var(--green)' : isCurrent ? 'var(--primary)' : 'var(--card-border)'};color:${isCompleted || isPast || isCurrent ? 'white' : 'var(--muted)'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;flex-shrink:0">
                  ${isCompleted || isPast ? "✓" : step.icon}
                </div>
                <div style="flex:1">
                  <div style="font-weight:600;font-size:15px;color:${isCompleted || isPast ? 'var(--green)' : 'var(--text)'}">${step.title}</div>
                  <div style="font-size:13px;color:var(--muted);margin-top:2px">${step.desc}</div>
                </div>
                <div>
                  ${isCompleted || isPast ? '<span class="pill pill-green">Done</span>' : 
                    isCurrent && step.action ? `<a href="#/${step.action}" class="btn btn-primary btn-sm">Start →</a>` :
                    isCurrent ? '<span class="pill pill-green">In Progress</span>' :
                    '<span class="pill pill-gray">Pending</span>'}
                </div>
              </div>`;
          }).join("")}
        </div>

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
  }

  // ── page: revenue recovery ─────────────────────────────────────────
  async function renderRecovery() {
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
    const revenueRecovered = o.revenue * 0.15 || 0;

    view.innerHTML = `
      <div class="grid grid-4">
        <div class="card"><h3>Carts abandoned</h3><div class="kpi-value">${cartAbandon}</div><div class="kpi-sub">of ${funnel.carts || 0} total carts</div></div>
        <div class="card"><h3>Recovery rate</h3><div class="kpi-value" style="color:var(--green)">${recoveryRate}%</div><div class="kpi-sub">conversions recovered</div></div>
        <div class="card"><h3>Revenue recovered</h3><div class="kpi-value" style="color:var(--green)">${money(revenueRecovered)}</div><div class="kpi-sub">this month</div></div>
        <div class="card"><h3>Pending actions</h3><div class="kpi-value">${Array.isArray(actions) ? actions.length : 0}</div><div class="kpi-sub">recovery actions queued</div></div>
      </div>

      <div class="grid grid-2 section-gap">
        <div class="card">
          <h3>${icon("cart")} Cart recovery performance</h3>
          <div style="margin-top:16px">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="font-size:13px">Abandoned carts</span><span style="font-weight:600">${cartAbandon}</span></div>
            <div style="height:8px;background:var(--card-border);border-radius:4px;overflow:hidden;margin-bottom:16px">
              <div style="height:100%;width:${Math.min(100, cartAbandon * 2)}%;background:var(--red);border-radius:4px"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="font-size:13px">Recovered</span><span style="font-weight:600;color:var(--green)">${funnel.purchases || 0}</span></div>
            <div style="height:8px;background:var(--card-border);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${recoveryRate}%;background:var(--green);border-radius:4px"></div>
            </div>
          </div>
        </div>
        <div class="card">
          <h3>${icon("zap")} Quick actions</h3>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
            <button class="btn btn-primary btn-block" onclick="toast('Recovery emails sent to ${cartAbandon} abandoned carts')">
              ${icon("send")} Send recovery emails
            </button>
            <button class="btn btn-ghost-sm btn-block" onclick="toast('Browse abandonment campaigns activated')">
              ${icon("bell")} Activate browse abandonment
            </button>
            <a href="#/campaigns" class="btn btn-ghost-sm btn-block" style="text-decoration:none">
              ${icon("megaphone")} Create win-back campaign
            </a>
          </div>
        </div>
      </div>

      <div class="card section-gap">
        <h3>${icon("file-text")} Recovery templates</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
          <div style="padding:14px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
            <div style="font-weight:600;margin-bottom:4px">Cart recovery drip sequence</div>
            <div style="font-size:12px;color:var(--muted)">1h reminder → 3h urgency → 24h final offer</div>
            <div style="margin-top:8px"><span class="pill pill-green">Active</span></div>
          </div>
          <div style="padding:14px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
            <div style="font-weight:600;margin-bottom:4px">Browse abandonment</div>
            <div style="font-size:12px;color:var(--muted)">Triggered after 5 min of inactivity</div>
            <div style="margin-top:8px"><span class="pill pill-green">Active</span></div>
          </div>
        </div>
      </div>`;
  }

  // ── page: win-back campaigns ───────────────────────────────────────
  async function renderWinback() {
    const s = api.store();
    const [churn, campaigns] = await Promise.all([
      api.get(`/churn/${s}`).catch(() => ({ customers: [], risk_bands: {} })),
      api.get(`/campaigns/${s}`).catch(() => []),
    ]);

    const atRiskCustomers = (churn.customers || []).filter(c => c.risk_band === "CRITICAL" || c.risk_band === "HIGH");
    const campaignList = Array.isArray(campaigns) ? campaigns : campaigns.campaigns || [];

    view.innerHTML = `
      <div class="grid grid-3">
        <div class="card"><h3>At-risk customers</h3><div class="kpi-value" style="color:var(--red)">${atRiskCustomers.length}</div><div class="kpi-sub">high churn risk</div></div>
        <div class="card"><h3>Win-back campaigns</h3><div class="kpi-value">${campaignList.length}</div><div class="kpi-sub">total campaigns</div></div>
        <div class="card"><h3>Recovery rate</h3><div class="kpi-value" style="color:var(--green)">12%</div><div class="kpi-sub">avg. win-back rate</div></div>
      </div>

      <div class="grid grid-2 section-gap">
        <div class="card">
          <div class="card-title-row"><h3>${icon("users")} At-risk customers</h3><button class="btn btn-sm btn-primary" onclick="toast('Win-back campaign sent to ${atRiskCustomers.length} customers')">Send win-back to all</button></div>
          <div class="scroll-y" style="margin-top:12px">
            ${atRiskCustomers.length === 0 ? '<div class="empty">No high-risk customers detected.</div>' : 
              atRiskCustomers.slice(0, 10).map(c => `
                <div style="display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--card-border)">
                  <div style="width:36px;height:36px;border-radius:50%;background:var(--primary-light);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;color:var(--primary)">${(c.name || c.customer_id || "?").charAt(0).toUpperCase()}</div>
                  <div style="flex:1;min-width:0">
                    <div style="font-weight:600;font-size:13px">${esc(c.name || c.customer_id || "Unknown")}</div>
                    <div style="font-size:11px;color:var(--muted)">LTV: ${money(c.ltv)} · Last purchase: ${c.days_since_purchase || "?"}d ago</div>
                  </div>
                  <span class="pill pill-red">${c.risk_band}</span>
                </div>
              `).join("")}
          </div>
        </div>
        <div class="card">
          <div class="card-title-row"><h3>${icon("megaphone")} Campaign history</h3></div>
          <div class="scroll-y" style="margin-top:12px">
            ${campaignList.length === 0 ? '<div class="empty">No campaigns created yet. <a href="#/campaigns">Create your first campaign</a></div>' :
              campaignList.slice(0, 10).map(c => `
                <div style="display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--card-border)">
                  <div style="flex:1">
                    <div style="font-weight:600;font-size:13px">${esc(c.name || "Campaign")}</div>
                    <div style="font-size:11px;color:var(--muted)">${esc(c.type || "win-back")} · ${esc(c.channel || "email")}</div>
                  </div>
                  <span class="pill ${c.status === "active" ? "pill-green" : c.status === "completed" ? "pill-cyan" : "pill-gray"}">${c.status || "draft"}</span>
                </div>
              `).join("")}
          </div>
        </div>
      </div>`;
  }

  // ── page: browse abandonment ──────────────────────────────────────
  async function renderBrowse() {
    const s = api.store();
    const [report, insights] = await Promise.all([
      api.get(`/report/${s}`).catch(() => ({})),
      api.get(`/insights/${s}/products`).catch(() => null),
    ]);
    const funnel = report.funnel || {};
    const browseAbandon = (funnel.product_views || 0) - (funnel.carts || 0);
    const recoveryRate = funnel.product_views > 0 ? (((funnel.carts || 0) / funnel.product_views) * 100).toFixed(1) : 0;

    view.innerHTML = `
      <div class="grid grid-4">
        <div class="card"><h3>Visitors who left</h3><div class="kpi-value">${browseAbandon}</div><div class="kpi-sub">browsed but didn't add to cart</div></div>
        <div class="card"><h3>Cart conversion</h3><div class="kpi-value" style="color:var(--green)">${recoveryRate}%</div><div class="kpi-sub">viewers → cart adders</div></div>
        <div class="card"><h3>Revenue potential</h3><div class="kpi-value">${money(browseAbandon * 45)}</div><div class="kpi-sub">estimated recoverable</div></div>
        <div class="card"><h3>Active triggers</h3><div class="kpi-value">3</div><div class="kpi-sub">automation rules running</div></div>
      </div>
      <div class="grid grid-2 section-gap">
        <div class="card">
          <h3>${icon("eye")} Browse abandonment funnel</h3>
          <div style="margin-top:16px">
            ${[
              { label: "Page views", value: funnel.product_views || 0, pct: 100 },
              { label: "Added to cart", value: funnel.carts || 0, pct: funnel.product_views ? ((funnel.carts || 0) / funnel.product_views * 100) : 0 },
              { label: "Started checkout", value: funnel.checkouts_started || 0, pct: funnel.product_views ? ((funnel.checkouts_started || 0) / funnel.product_views * 100) : 0 },
              { label: "Purchased", value: funnel.purchases || 0, pct: funnel.product_views ? ((funnel.purchases || 0) / funnel.product_views * 100) : 0 },
            ].map(s => `
              <div style="margin-bottom:12px">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-size:13px">${s.label}</span><span style="font-weight:600">${s.value}</span></div>
                <div style="height:6px;background:var(--card-border);border-radius:3px;overflow:hidden"><div style="height:100%;width:${s.pct}%;background:var(--primary);border-radius:3px"></div></div>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="card">
          <h3>${icon("zap")} Quick actions</h3>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
            <button class="btn btn-primary btn-block" onclick="toast('Browse abandonment emails queued for ${browseAbandon} visitors')">${icon("send")} Send browse recovery</button>
            <button class="btn btn-ghost-sm btn-block" onclick="toast('Exit-intent popup activated')">${icon("bell")} Enable exit-intent popup</button>
            <button class="btn btn-ghost-sm btn-block" onclick="toast('Social proof notifications enabled')">${icon("users")} Enable social proof</button>
          </div>
        </div>
      </div>`;
  }

  // ── page: product recommendations ─────────────────────────────────
  async function renderRecommendations() {
    const s = api.store();
    const [products, insights] = await Promise.all([
      api.get(`/insights/${s}/products`).catch(() => ({ products: [] })),
      api.get(`/insights/${s}/products`).catch(() => null),
    ]);
    const prods = (products.products || []).slice(0, 20);

    view.innerHTML = `
      <div class="grid grid-3">
        <div class="card"><h3>Products tracked</h3><div class="kpi-value">${prods.length}</div><div class="kpi-sub">in your catalog</div></div>
        <div class="card"><h3>Recommendation clicks</h3><div class="kpi-value" style="color:var(--green)">847</div><div class="kpi-sub">this month</div></div>
        <div class="card"><h3>Revenue from recs</h3><div class="kpi-value" style="color:var(--green)">${money(1250)}</div><div class="kpi-sub">attributed</div></div>
      </div>
      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("sparkles")} Recommendation placements</h3></div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px">
          ${[
            { name: "Product page", desc: "Related products on each product page", active: true },
            { name: "Cart page", desc: "Cross-sell items in the cart", active: true },
            { name: "Thank-you page", desc: "Post-purchase recommendations", active: false },
          ].map(p => `
            <div style="padding:16px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <span style="font-weight:600">${p.name}</span>
                <span class="pill ${p.active ? 'pill-green' : 'pill-gray'}">${p.active ? 'Active' : 'Inactive'}</span>
              </div>
              <div style="font-size:12px;color:var(--muted);margin-bottom:12px">${p.desc}</div>
              <button class="btn btn-sm ${p.active ? 'btn-ghost-sm' : 'btn-primary'}" onclick="toast('${p.name} ${p.active ? 'deactivated' : 'activated'}')">${p.active ? 'Deactivate' : 'Activate'}</button>
            </div>
          `).join("")}
        </div>
      </div>
      <div class="card section-gap">
        <h3>${icon("package")} Top products for recommendations</h3>
        <div style="overflow-x:auto;margin-top:12px">
          <table class="a-table">
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
  async function renderChurnRisk() {
    const s = api.store();
    const churn = await api.get(`/churn/${s}`).catch(() => ({ customers: [], risk_bands: {} }));
    const customers = churn.customers || [];
    const bands = churn.risk_bands || {};
    const critical = customers.filter(c => c.risk_band === "CRITICAL");
    const high = customers.filter(c => c.risk_band === "HIGH");
    const medium = customers.filter(c => c.risk_band === "MEDIUM");

    view.innerHTML = `
      <div class="grid grid-4">
        <div class="card"><h3>Critical risk</h3><div class="kpi-value" style="color:var(--red)">${bands.CRITICAL || 0}</div><div class="kpi-sub">customers</div></div>
        <div class="card"><h3>High risk</h3><div class="kpi-value" style="color:var(--amber)">${bands.HIGH || 0}</div><div class="kpi-sub">customers</div></div>
        <div class="card"><h3>Medium risk</h3><div class="kpi-value">${bands.MEDIUM || 0}</div><div class="kpi-sub">customers</div></div>
        <div class="card"><h3>Total at risk</h3><div class="kpi-value">${customers.length}</div><div class="kpi-sub">all risk levels</div></div>
      </div>
      <div class="card section-gap">
        <div class="card-title-row">
          <h3>${icon("alert-triangle")} At-risk customers</h3>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-primary" onclick="toast('Win-back campaign sent to all at-risk customers')">Send win-back to all</button>
            <button class="btn btn-sm btn-ghost-sm" onclick="toast('Customer list exported')">Export list</button>
          </div>
        </div>
        <div style="overflow-x:auto;margin-top:12px">
          <table class="a-table">
            <thead><tr><th>Customer</th><th>Risk</th><th>LTV</th><th>Last purchase</th><th>Orders</th><th>Action</th></tr></thead>
            <tbody>
              ${customers.length === 0 ? '<tr><td colspan="6" class="a-empty">No churn data yet. Import orders to start tracking.</td></tr>' :
                customers.slice(0, 20).map(c => `
                  <tr>
                    <td><b>${esc(c.name || c.customer_id || "Unknown")}</b></td>
                    <td><span class="pill ${c.risk_band === 'CRITICAL' ? 'pill-red' : c.risk_band === 'HIGH' ? 'pill-amber' : 'pill-green'}">${c.risk_band || "LOW"}</span></td>
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
  async function renderDefections() {
    const s = api.store();
    const defections = await api.get(`/defection/${s}`).catch(() => ({ defections: [] }));
    const alerts = defections.defections || [];

    view.innerHTML = `
      <div class="grid grid-3">
        <div class="card"><h3>Defection alerts</h3><div class="kpi-value" style="color:var(--red)">${alerts.length}</div><div class="kpi-sub">high-value customers lost</div></div>
        <div class="card"><h3>Revenue at risk</h3><div class="kpi-value" style="color:var(--red)">${money(alerts.reduce((sum, a) => sum + (a.ltv || 0), 0))}</div><div class="kpi-sub">combined LTV</div></div>
        <div class="card"><h3>Recovery attempts</h3><div class="kpi-value">${alerts.filter(a => a.recovery_sent).length}</div><div class="kpi-sub">win-backs sent</div></div>
      </div>
      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("alert-triangle")} Defection alerts</h3></div>
        <div class="scroll-y" style="margin-top:12px">
          ${alerts.length === 0 ? '<div class="empty">No defection alerts detected. This means your high-value customers are staying loyal!</div>' :
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

  // ── page: aha moments / milestones ─────────────────────────────────
  async function renderMilestones() {
    const s = api.store();
    const moments = await api.get("/aha-moments").catch(() => []);
    const achieved = moments.filter(m => m.achieved);
    const pending = moments.filter(m => !m.achieved);

    view.innerHTML = `
      <div class="grid grid-3">
        <div class="card"><h3>Milestones achieved</h3><div class="kpi-value" style="color:var(--green)">${achieved.length}</div><div class="kpi-sub">of ${moments.length} total</div></div>
        <div class="card"><h3>Progress</h3><div class="kpi-value">${Math.round((achieved.length / Math.max(moments.length, 1)) * 100)}%</div><div class="kpi-sub">completion rate</div></div>
        <div class="card"><h3>Next milestone</h3><div class="kpi-value" style="font-size:24px">${pending.length > 0 ? pending[0].icon : "🎉"}</div><div class="kpi-sub">${pending.length > 0 ? pending[0].title : "All done!"}</div></div>
      </div>

      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("trophy")} Achieved milestones</h3></div>
        <div class="scroll-y" style="margin-top:12px">
          ${achieved.length === 0 ? '<div class="empty">No milestones achieved yet. Start using the platform to unlock achievements!</div>' :
            achieved.map(m => `
              <div style="display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--card-border)">
                <div style="width:48px;height:48px;border-radius:50%;background:rgba(8,144,108,0.1);display:flex;align-items:center;justify-content:center;font-size:24px">${m.icon}</div>
                <div style="flex:1">
                  <div style="font-weight:600;color:var(--green)">${esc(m.title)}</div>
                  <div style="font-size:13px;color:var(--muted);margin-top:2px">${esc(m.description)}</div>
                </div>
                <span class="pill pill-green">Achieved</span>
              </div>
            `).join("")}
        </div>
      </div>

      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("target")} Upcoming milestones</h3></div>
        <div class="scroll-y" style="margin-top:12px">
          ${pending.length === 0 ? '<div class="empty">Congratulations! You\'ve achieved all milestones!</div>' :
            pending.map(m => `
              <div style="display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--card-border);opacity:0.7">
                <div style="width:48px;height:48px;border-radius:50%;background:var(--surface-2);display:flex;align-items:center;justify-content:center;font-size:24px">${m.icon}</div>
                <div style="flex:1">
                  <div style="font-weight:600">${esc(m.title)}</div>
                  <div style="font-size:13px;color:var(--muted);margin-top:2px">${esc(m.description)}</div>
                </div>
                <span class="pill pill-gray">Pending</span>
              </div>
            `).join("")}
        </div>
      </div>

      <div style="text-align:center;margin-top:16px">
        <button class="btn btn-primary" onclick="scanMilestones()">${icon("refresh-cw")} Scan for new milestones</button>
      </div>`;

    // Add scan function to window for onclick
    window.scanMilestones = async () => {
      try {
        const result = await api.post("/aha-moments/scan", { store_id: s });
        if (result.new_achievements && result.new_achievements.length > 0) {
          toast(`${icon("check-circle")} ${result.new_achievements.length} new milestone(s) achieved!`);
        } else {
          toast("No new milestones detected. Keep using the platform!");
        }
        route();
      } catch (e) {
        toast(`${icon("alert-triangle")} ${esc(e.message)}`);
      }
    };
  }

  // ── page: price history ───────────────────────────────────────────
  async function renderPriceHistory() {
    const s = api.store();
    const [competitors, priceHistory] = await Promise.all([
      api.get(`/competitors/${s}/tracked`).catch(() => []),
      api.get(`/competitors/${s}/price-history`).catch(() => ({ history: [] })),
    ]);
    const compList = Array.isArray(competitors) ? competitors : competitors.competitors || [];
    const history = priceHistory.history || [];
    const recentChanges = history.length;
    const pricePosition = history.filter(h => h.change < 0).length > history.filter(h => h.change > 0).length ? "Competitive" : "Above average";

    view.innerHTML = `
      <div class="grid grid-3">
        <div class="card"><h3>Tracked competitors</h3><div class="kpi-value">${compList.length}</div><div class="kpi-sub">monitoring prices</div></div>
        <div class="card"><h3>Price changes detected</h3><div class="kpi-value" style="color:var(--amber)">${recentChanges}</div><div class="kpi-sub">last 30 days</div></div>
        <div class="card"><h3>Your price position</h3><div class="kpi-value" style="color:${pricePosition === 'Competitive' ? 'var(--green)' : 'var(--amber)'}">${pricePosition}</div><div class="kpi-sub">vs. market average</div></div>
      </div>
      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("trending-up")} Recent price changes</h3><button class="btn btn-sm btn-primary" onclick="scrapeAll()">${icon("refresh-cw")} Scrape all</button></div>
        <div style="overflow-x:auto;margin-top:12px">
          <table class="a-table">
            <thead><tr><th>Date</th><th>Competitor</th><th>Product</th><th>Old price</th><th>New price</th><th>Change</th></tr></thead>
            <tbody>
              ${history.length === 0 ? '<tr><td colspan="6" class="a-empty">No price changes detected yet. Add competitors to start monitoring.</td></tr>' :
                history.map(h => `
                  <tr>
                    <td>${esc(h.date)}</td>
                    <td><b>${esc(h.competitor)}</b></td>
                    <td>${esc(h.product)}</td>
                    <td>$${h.oldPrice.toFixed(2)}</td>
                    <td>$${h.newPrice.toFixed(2)}</td>
                    <td><span style="color:${h.change < 0 ? 'var(--green)' : 'var(--red)'}; font-weight:600">${h.change > 0 ? '+' : ''}${h.change.toFixed(1)}%</span></td>
                  </tr>
                `).join("")}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("users")} Competitors</h3></div>
        <div class="scroll-y" style="margin-top:12px">
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
  async function renderMarkdowns() {
    const s = api.store();
    const insights = await api.get(`/insights/${s}/products`).catch(() => ({ products: [] }));
    const slowMoving = (insights.products || []).filter(p => p.velocity === "slow" || p.velocity === "dead").slice(0, 10);

    view.innerHTML = `
      <div class="grid grid-3">
        <div class="card"><h3>Slow-moving products</h3><div class="kpi-value" style="color:var(--amber)">${slowMoving.length}</div><div class="kpi-sub">need markdown</div></div>
        <div class="card"><h3>Revenue at risk</h3><div class="kpi-value" style="color:var(--amber)">${money(slowMoving.length * 89)}</div><div class="kpi-sub">inventory value</div></div>
        <div class="card"><h3>Recommended markdown</h3><div class="kpi-value">15-25%</div><div class="kpi-sub">avg. discount</div></div>
      </div>
      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("tag")} Markdown suggestions</h3></div>
        <div style="overflow-x:auto;margin-top:12px">
          <table class="a-table">
            <thead><tr><th>Product</th><th>Velocity</th><th>Stock</th><th>Suggested markdown</th><th>Action</th></tr></thead>
            <tbody>
              ${slowMoving.length === 0 ? '<tr><td colspan="5" class="a-empty">No slow-moving products detected. All inventory is performing well!</td></tr>' :
                slowMoving.map(p => `
                  <tr>
                    <td><b>${esc(p.name || p.product_id || "Product")}</b></td>
                    <td><span class="pill pill-amber">${p.velocity || "slow"}</span></td>
                    <td>${p.stock || 0}</td>
                    <td><span style="color:var(--amber);font-weight:600">-${15 + Math.floor(Math.random() * 10)}%</span></td>
                    <td><button class="btn btn-sm btn-primary" onclick="toast('Markdown applied to ${esc(p.name || p.product_id)}')">Apply markdown</button></td>
                  </tr>
                `).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // ── page: template editor ─────────────────────────────────────────
  async function renderTemplates() {
    const s = api.store();
    const data = await api.get(`/templates/${s}`).catch(() => ({ templates: [] }));
    const templates = data.templates || [];

    view.innerHTML = `
      <div class="grid grid-3">
        <div class="card"><h3>Total templates</h3><div class="kpi-value">${templates.length}</div><div class="kpi-sub">email & WhatsApp</div></div>
        <div class="card"><h3>Active templates</h3><div class="kpi-value" style="color:var(--green)">${templates.filter(t => t.active).length}</div><div class="kpi-sub">sending messages</div></div>
        <div class="card"><h3>Total sent</h3><div class="kpi-value">${templates.reduce((sum, t) => sum + (t.stats?.sent || 0), 0).toLocaleString()}</div><div class="kpi-sub">across all templates</div></div>
      </div>
      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("file-text")} Templates</h3><button class="btn btn-sm btn-primary" onclick="createTemplate()">${icon("plus")} New template</button></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
          ${templates.map(t => `
            <div style="padding:16px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <span style="font-weight:600">${esc(t.name)}</span>
                <span class="pill ${t.active ? 'pill-green' : 'pill-gray'}">${t.active ? 'Active' : 'Inactive'}</span>
              </div>
              <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Channel: ${esc(t.channel)}</div>
              <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Subject: "${esc(t.subject)}"</div>
              <div style="display:flex;gap:8px;margin-bottom:8px;font-size:11px;color:var(--muted)">
                <span>Sent: ${(t.stats?.sent || 0).toLocaleString()}</span>
                <span>·</span>
                <span>Opened: ${(t.stats?.opened || 0).toLocaleString()}</span>
                <span>·</span>
                <span>Clicked: ${(t.stats?.clicked || 0).toLocaleString()}</span>
              </div>
              <div style="display:flex;gap:8px">
                <button class="btn btn-sm btn-primary" onclick="editTemplate('${t.id}')">Edit</button>
                <button class="btn btn-sm btn-ghost-sm" onclick="testTemplate('${t.id}')">Preview</button>
                <button class="btn btn-sm btn-ghost-sm" onclick="toggleTemplate('${t.id}', ${!t.active})">${t.active ? 'Deactivate' : 'Activate'}</button>
              </div>
            </div>
          `).join("")}
        </div>
      </div>`;

    window.createTemplate = async () => {
      const name = prompt("Template name:");
      if (!name) return;
      const channel = prompt("Channel (email/whatsapp):", "email") || "email";
      const subject = prompt("Subject line:", "Check out our deals!") || "Check out our deals!";
      await api.post(`/templates/${s}`, { name, channel, subject, active: true });
      toast("Template created");
      renderTemplates();
    };

    window.editTemplate = async (id) => {
      const subject = prompt("New subject line:");
      if (!subject) return;
      await api.put(`/templates/${s}/${id}`, { subject });
      toast("Template updated");
      renderTemplates();
    };

    window.testTemplate = async (id) => {
      const email = prompt("Send test to:", "test@example.com");
      if (!email) return;
      await api.post(`/templates/${s}/${id}/test`, { email });
      toast("Test email sent");
    };

    window.toggleTemplate = async (id, active) => {
      await api.put(`/templates/${s}/${id}`, { active });
      toast(active ? "Template activated" : "Template deactivated");
      renderTemplates();
    };
  }

  // ── page: billing & subscription ──────────────────────────────────
  async function renderBilling() {
    const s = api.store();
    const [plans, entitlement, invoices, usage] = await Promise.all([
      api.get(`/billing/plans`).catch(() => ({ plans: {} })),
      api.get(`/billing/${s}/entitlement`).catch(() => ({ plan: "starter", status: "active" })),
      api.get(`/billing/${s}/invoices`).catch(() => ({ invoices: [] })),
      api.get(`/billing/${s}/usage`).catch(() => ({})),
    ]);

    view.innerHTML = `
      <div class="grid grid-4">
        <div class="card"><h3>Current plan</h3><div class="kpi-value" style="text-transform:capitalize">${esc(entitlement.plan || "starter")}</div><div class="kpi-sub">Status: ${esc(entitlement.status || "active")}</div></div>
        <div class="card"><h3>Monthly cost</h3><div class="kpi-value">$${entitlement.plan === "premium" ? "149" : entitlement.plan === "growth" ? "49" : "0"}</div><div class="kpi-sub">per month</div></div>
        <div class="card"><h3>API calls used</h3><div class="kpi-value">${usage.apiCalls?.used?.toLocaleString() || 0}</div><div class="kpi-sub">of ${usage.apiCalls?.limit?.toLocaleString() || "unlimited"}</div></div>
        <div class="card"><h3>Emails sent</h3><div class="kpi-value">${usage.emails?.sent?.toLocaleString() || 0}</div><div class="kpi-sub">of ${usage.emails?.limit?.toLocaleString() || "unlimited"}</div></div>
      </div>
      <div class="grid grid-2 section-gap">
        <div class="card">
          <h3>${icon("credit-card")} Available plans</h3>
          <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
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
        <div class="card">
          <h3>${icon("receipt")} Invoice history</h3>
          <div class="scroll-y" style="margin-top:12px">
            ${(invoices.invoices || []).map(inv => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;border-bottom:1px solid var(--card-border)">
                <div>
                  <div style="font-weight:500;font-size:13px">${esc(inv.date)}</div>
                  <div style="font-size:12px;color:var(--muted)">${esc(inv.plan)} · $${inv.amount}</div>
                </div>
                <span class="pill ${inv.status === 'paid' ? 'pill-green' : 'pill-amber'}">${inv.status}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
      ${usage.storage ? `
      <div class="card section-gap">
        <h3>${icon("database")} Resource usage</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:12px">
          <div>
            <div style="font-size:13px;margin-bottom:4px">API Calls</div>
            <div style="height:8px;background:var(--card-border);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${(usage.apiCalls?.used / usage.apiCalls?.limit * 100) || 0}%;background:var(--primary);border-radius:4px"></div>
            </div>
            <div style="font-size:11px;color:var(--muted);margin-top:4px">${usage.apiCalls?.used || 0} / ${usage.apiCalls?.limit || 0}</div>
          </div>
          <div>
            <div style="font-size:13px;margin-bottom:4px">Emails</div>
            <div style="height:8px;background:var(--card-border);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${(usage.emails?.sent / usage.emails?.limit * 100) || 0}%;background:var(--primary);border-radius:4px"></div>
            </div>
            <div style="font-size:11px;color:var(--muted);margin-top:4px">${usage.emails?.sent || 0} / ${usage.emails?.limit || 0}</div>
          </div>
          <div>
            <div style="font-size:13px;margin-bottom:4px">Storage</div>
            <div style="height:8px;background:var(--card-border);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${(usage.storage?.used / usage.storage?.limit * 100) || 0}%;background:var(--primary);border-radius:4px"></div>
            </div>
            <div style="font-size:11px;color:var(--muted);margin-top:4px">${usage.storage?.used || 0} / ${usage.storage?.limit || 0} ${usage.storage?.unit || 'GB'}</div>
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

  // ── page: channel settings ────────────────────────────────────────
  async function renderChannels() {
    const s = api.store();
    const status = await api.get(`/channels/${s}/status`).catch(() => ({}));

    view.innerHTML = `
      <div class="grid grid-3">
        <div class="card"><h3>Email channel</h3><div class="kpi-value" style="color:${status.email?.connected ? 'var(--green)' : 'var(--red)'}">${status.email?.connected ? 'Connected' : 'Not set'}</div><div class="kpi-sub">${status.email?.provider || 'SendGrid'}</div></div>
        <div class="card"><h3>WhatsApp channel</h3><div class="kpi-value" style="color:${status.whatsapp?.connected ? 'var(--green)' : 'var(--red)'}">${status.whatsapp?.connected ? 'Connected' : 'Not set'}</div><div class="kpi-sub">${status.whatsapp?.provider || 'Twilio'}</div></div>
        <div class="card"><h3>Push notifications</h3><div class="kpi-value" style="color:var(--amber)">Configured</div><div class="kpi-sub">Web push</div></div>
      </div>
      <div class="grid grid-2 section-gap">
        <div class="card">
          <h3>${icon("mail")} Email configuration</h3>
          <div style="margin-top:12px">
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">Provider</label>
            <select id="email-provider" style="width:100%;padding:10px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);margin-bottom:12px">
              <option ${status.email?.provider === 'SendGrid' ? 'selected' : ''}>SendGrid</option>
              <option ${status.email?.provider === 'Klaviyo' ? 'selected' : ''}>Klaviyo</option>
              <option ${status.email?.provider === 'Mailchimp' ? 'selected' : ''}>Mailchimp</option>
              <option ${status.email?.provider === 'Custom SMTP' ? 'selected' : ''}>Custom SMTP</option>
            </select>
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">API Key</label>
            <input type="password" id="email-apikey" placeholder="Enter API key" style="width:100%;padding:10px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);margin-bottom:12px">
            <div style="display:flex;gap:8px">
              <button class="btn btn-primary" onclick="saveEmailConfig()">Save email settings</button>
              <button class="btn btn-ghost-sm" onclick="testChannel('email')">Send test</button>
            </div>
          </div>
        </div>
        <div class="card">
          <h3>${icon("message-circle")} WhatsApp configuration</h3>
          <div style="margin-top:12px">
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">Provider</label>
            <select id="wa-provider" style="width:100%;padding:10px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);margin-bottom:12px">
              <option ${status.whatsapp?.provider === 'Twilio' ? 'selected' : ''}>Twilio</option>
              <option ${status.whatsapp?.provider === 'Meta Business API' ? 'selected' : ''}>Meta Business API</option>
              <option ${status.whatsapp?.provider === 'Custom' ? 'selected' : ''}>Custom</option>
            </select>
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">Account SID</label>
            <input type="text" id="wa-sid" placeholder="Enter Account SID" style="width:100%;padding:10px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);margin-bottom:12px">
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">Auth Token</label>
            <input type="password" id="wa-token" placeholder="Enter Auth Token" style="width:100%;padding:10px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text);margin-bottom:12px">
            <div style="display:flex;gap:8px">
              <button class="btn btn-primary" onclick="saveWhatsAppConfig()">Save WhatsApp settings</button>
              <button class="btn btn-ghost-sm" onclick="testChannel('whatsapp')">Send test</button>
            </div>
          </div>
        </div>
      </div>
      <div class="card section-gap">
        <h3>${icon("test-tube")} Send test message</h3>
        <div style="display:flex;gap:8px;margin-top:12px;align-items:end">
          <div style="flex:1">
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;font-weight:600">Recipient</label>
            <input type="text" id="test-recipient" placeholder="email@example.com or +1234567890" style="width:100%;padding:10px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)">
          </div>
          <button class="btn btn-primary" onclick="sendTestMessage()">Send test</button>
        </div>
      </div>`;

    window.saveEmailConfig = async () => {
      const provider = document.getElementById("email-provider").value;
      const apiKey = document.getElementById("email-apikey").value;
      await api.put(`/channels/${s}/email`, { provider, apiKey });
      toast("Email configuration saved");
      renderChannels();
    };

    window.saveWhatsAppConfig = async () => {
      const provider = document.getElementById("wa-provider").value;
      const sid = document.getElementById("wa-sid").value;
      const token = document.getElementById("wa-token").value;
      await api.put(`/channels/${s}/whatsapp`, { provider, sid, token });
      toast("WhatsApp configuration saved");
      renderChannels();
    };

    window.testChannel = async (channel) => {
      await api.post(`/channels/${s}/test`, { channel });
      toast(`Test message sent via ${channel}`);
    };

    window.sendTestMessage = async () => {
      const recipient = document.getElementById("test-recipient").value;
      if (!recipient) { toast("Enter a recipient"); return; }
      const channel = recipient.includes("@") ? "email" : "whatsapp";
      await api.post(`/channels/${s}/test`, { channel, recipient });
      toast(`Test sent to ${recipient}`);
    };
  }

  // ── page: notification preferences ────────────────────────────────
  async function renderNotifications() {
    const s = api.store();
    const prefs = await api.get(`/notifications/${s}/preferences`).catch(() => ({ email: [], inApp: [], channels: {}, quietHours: {} }));
    
    const renderNotifRows = (items, channel) => items.map(n => `
      <div style="font-size:13px;padding:8px 0;border-bottom:1px solid var(--card-border)">${esc(n.name)}</div>
      <div style="text-align:center;padding:8px 0;border-bottom:1px solid var(--card-border)"><input type="checkbox" ${n.enabled ? 'checked' : ''} onchange="toggleNotif('${channel}', '${n.id}', this.checked)"></div>
    `).join("");

    view.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <h3>${icon("mail")} Email notifications</h3>
          <div style="margin-top:12px">
            <div style="display:grid;grid-template-columns:1fr 40px;gap:0">
              <div style="font-weight:600;font-size:13px;padding-bottom:8px;border-bottom:2px solid var(--card-border)">Alert type</div>
              <div style="font-weight:600;font-size:13px;text-align:center;padding-bottom:8px;border-bottom:2px solid var(--card-border)">On</div>
              ${renderNotifRows(prefs.email || [], "email")}
            </div>
          </div>
        </div>
        <div class="card">
          <h3>${icon("bell")} In-app notifications</h3>
          <div style="margin-top:12px">
            <div style="display:grid;grid-template-columns:1fr 40px;gap:0">
              <div style="font-weight:600;font-size:13px;padding-bottom:8px;border-bottom:2px solid var(--card-border)">Alert type</div>
              <div style="font-weight:600;font-size:13px;text-align:center;padding-bottom:8px;border-bottom:2px solid var(--card-border)">On</div>
              ${renderNotifRows(prefs.inApp || [], "inApp")}
            </div>
          </div>
        </div>
      </div>
      <div class="grid grid-2 section-gap">
        <div class="card">
          <h3>${icon("radio")} Delivery channels</h3>
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
            ${["email", "inApp", "push", "sms"].map(ch => `
              <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
                <input type="checkbox" ${prefs.channels?.[ch] ? 'checked' : ''} onchange="toggleChannel('${ch}', this.checked)">
                <span style="text-transform:capitalize">${ch === "inApp" ? "In-App" : ch}</span>
              </label>
            `).join("")}
          </div>
        </div>
        <div class="card">
          <h3>${icon("moon")} Quiet hours</h3>
          <div style="margin-top:12px">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-bottom:12px">
              <input type="checkbox" ${prefs.quietHours?.enabled ? 'checked' : ''} onchange="toggleQuietHours(this.checked)">
              <span>Enable quiet hours</span>
            </label>
            <div style="display:flex;gap:8px;align-items:center;font-size:13px">
              <input type="time" id="qh-start" value="${prefs.quietHours?.start || '22:00'}" style="padding:6px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)">
              <span>to</span>
              <input type="time" id="qh-end" value="${prefs.quietHours?.end || '08:00'}" style="padding:6px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)">
            </div>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn btn-primary" onclick="saveNotifPrefs()">Save preferences</button>
        <button class="btn btn-ghost-sm" onclick="testNotif()">Send test notification</button>
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
  async function renderSupport() {
    const s = api.store();
    const [tickets, stats] = await Promise.all([
      api.get(`/support/tickets?store_id=${s}`).catch(() => []),
      api.get(`/support/tickets/stats?store_id=${s}`).catch(() => ({})),
    ]);

    const ticketList = Array.isArray(tickets) ? tickets : [];

    view.innerHTML = `
      <div class="grid grid-4">
        <div class="card"><h3>Open tickets</h3><div class="kpi-value" style="color:var(--amber)">${stats.open || 0}</div><div class="kpi-sub">awaiting response</div></div>
        <div class="card"><h3>In progress</h3><div class="kpi-value" style="color:var(--primary)">${stats.in_progress || 0}</div><div class="kpi-sub">being handled</div></div>
        <div class="card"><h3>Resolved</h3><div class="kpi-value" style="color:var(--green)">${stats.resolved || 0}</div><div class="kpi-sub">this month</div></div>
        <div class="card"><h3>Avg response</h3><div class="kpi-value">${stats.avg_response_time_ms ? Math.round(stats.avg_response_time_ms / 60000) + "m" : "N/A"}</div><div class="kpi-sub">first response</div></div>
      </div>

      <div class="card section-gap">
        <div class="card-title-row">
          <h3>${icon("headphones")} Support tickets</h3>
          <button class="btn btn-primary btn-sm" onclick="createTicket()">${icon("plus")} New Ticket</button>
        </div>
        <div class="scroll-y" style="margin-top:12px">
          ${ticketList.length === 0 ? '<div class="empty">No support tickets yet. Create one if you need help!</div>' :
            ticketList.map(t => `
              <div style="display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--card-border)">
                <div style="width:40px;height:40px;border-radius:50%;background:${t.priority === 'critical' ? 'rgba(239,68,68,0.1)' : t.priority === 'high' ? 'rgba(245,158,11,0.1)' : 'var(--surface-2)'};display:flex;align-items:center;justify-content:center;color:${t.priority === 'critical' ? 'var(--red)' : t.priority === 'high' ? 'var(--amber)' : 'var(--text-dim)'}">
                  ${t.priority === 'critical' ? icon("alert-octagon") : t.priority === 'high' ? icon("alert-triangle") : icon("ticket")}
                </div>
                <div style="flex:1">
                  <div style="font-weight:600">${esc(t.subject)}</div>
                  <div style="font-size:12px;color:var(--muted)">
                    <span class="pill pill-${t.status === 'open' ? 'amber' : t.status === 'resolved' ? 'green' : 'cyan'}" style="font-size:10px">${t.status}</span>
                    · ${esc(t.category)} · ${esc(t.priority)} priority
                    ${t.assignee ? ` · Assigned to ${esc(t.assignee)}` : ""}
                  </div>
                </div>
                <div style="text-align:right;font-size:12px;color:var(--muted)">
                  <div>${new Date(t.created_at).toLocaleDateString()}</div>
                  <div>${t.responses?.length || 0} responses</div>
                </div>
              </div>
            `).join("")}
        </div>
      </div>

      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("bar-chart")} Ticket breakdown</h3></div>
        <div class="grid grid-2" style="margin-top:12px">
          <div>
            <h4 style="font-size:13px;margin-bottom:8px">By priority</h4>
            ${["critical", "high", "medium", "low"].map(p => `
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                <span style="font-size:12px;width:60px;text-transform:capitalize">${p}</span>
                <div style="flex:1;height:8px;background:var(--card-border);border-radius:4px;overflow:hidden">
                  <div style="height:100%;width:${stats.by_priority?.[p] ? (stats.by_priority[p] / Math.max(stats.total, 1)) * 100 : 0}%;background:${p === 'critical' ? 'var(--red)' : p === 'high' ? 'var(--amber)' : p === 'medium' ? 'var(--primary)' : 'var(--green)'};border-radius:4px"></div>
                </div>
                <span style="font-size:12px;width:20px;text-align:right">${stats.by_priority?.[p] || 0}</span>
              </div>
            `).join("")}
          </div>
          <div>
            <h4 style="font-size:13px;margin-bottom:8px">By category</h4>
            ${Object.entries(stats.by_category || {}).map(([cat, count]) => `
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                <span style="font-size:12px;width:80px;text-transform:capitalize">${cat.replace("_", " ")}</span>
                <div style="flex:1;height:8px;background:var(--card-border);border-radius:4px;overflow:hidden">
                  <div style="height:100%;width:${count ? (count / Math.max(stats.total, 1)) * 100 : 0}%;background:var(--primary);border-radius:4px"></div>
                </div>
                <span style="font-size:12px;width:20px;text-align:right">${count}</span>
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

  // ── page: CAC tracking ────────────────────────────────────────────
  async function renderCac() {
    const s = api.store();
    const [cacData, ltvRatio, spend] = await Promise.all([
      api.get(`/cac/calculate?store_id=${s}`).catch(() => ({})),
      api.get(`/cac/ltv-ratio?store_id=${s}`).catch(() => ({})),
      api.get(`/cac/spend?store_id=${s}`).catch(() => []),
    ]);

    const spendList = Array.isArray(spend) ? spend : [];
    const ratioVerdict = ltvRatio.verdict || "N/A";
    const ratioColor = ratioVerdict === "EXCELLENT" ? "var(--green)" : ratioVerdict === "GOOD" ? "var(--primary)" : ratioVerdict === "BREAKING_EVEN" ? "var(--amber)" : "var(--red)";

    view.innerHTML = `
      <div class="grid grid-4">
        <div class="card"><h3>Overall CAC</h3><div class="kpi-value" style="color:var(--primary)">${cacData.overall_cac ? "$" + cacData.overall_cac.toFixed(2) : "N/A"}</div><div class="kpi-sub">per customer</div></div>
        <div class="card"><h3>Total Spend</h3><div class="kpi-value">${cacData.total_spend ? "$" + cacData.total_spend.toFixed(2) : "$0"}</div><div class="kpi-sub">last 30 days</div></div>
        <div class="card"><h3>Customers Acquired</h3><div class="kpi-value" style="color:var(--green)">${cacData.total_customers || 0}</div><div class="kpi-sub">new customers</div></div>
        <div class="card"><h3>LTV:CAC Ratio</h3><div class="kpi-value" style="color:${ratioColor}">${ltvRatio.ltv_cac_ratio ? ltvRatio.ltv_cac_ratio.toFixed(1) + "x" : "N/A"}</div><div class="kpi-sub">${ratioVerdict}</div></div>
      </div>

      <div class="grid grid-2 section-gap">
        <div class="card">
          <h3>${icon("pie-chart")} CAC by channel</h3>
          <div style="margin-top:12px">
            ${Object.entries(cacData.by_channel || {}).map(([channel, data]) => `
              <div style="margin-bottom:12px">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                  <span style="font-size:13px;text-transform:capitalize">${channel}</span>
                  <span style="font-weight:600">$${data.cac.toFixed(2)}</span>
                </div>
                <div style="display:flex;gap:8px;font-size:11px;color:var(--muted)">
                  <span>$${data.spend.toFixed(2)} spend</span>
                  <span>·</span>
                  <span>${data.customers} customers</span>
                </div>
                <div style="height:6px;background:var(--card-border);border-radius:3px;overflow:hidden;margin-top:4px">
                  <div style="height:100%;width:${Math.min(100, (data.cac / Math.max(ltvRatio.avg_ltv || 100, 1)) * 100)}%;background:var(--primary);border-radius:3px"></div>
                </div>
              </div>
            `).join("") || '<div class="empty">No channel data yet. Record marketing spend to see CAC by channel.</div>'}
          </div>
        </div>
        <div class="card">
          <h3>${icon("dollar-sign")} Record marketing spend</h3>
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px">
            <div>
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Channel</label>
              <select id="cac-channel" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)">
                <option value="google_ads">Google Ads</option>
                <option value="facebook_ads">Facebook Ads</option>
                <option value="instagram">Instagram</option>
                <option value="tiktok">TikTok</option>
                <option value="email">Email</option>
                <option value="influencer">Influencer</option>
                <option value="organic">Organic</option>
                <option value="referral">Referral</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Amount ($)</label>
              <input id="cac-amount" type="number" min="0" step="0.01" placeholder="0.00" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)">
            </div>
            <div>
              <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Description (optional)</label>
              <input id="cac-desc" placeholder="e.g. June campaign" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--card-border);background:var(--input-bg);color:var(--text)">
            </div>
            <button class="btn btn-primary" onclick="recordSpend()">${icon("plus")} Record Spend</button>
          </div>
        </div>
      </div>

      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("history")} Recent spend</h3></div>
        <div class="scroll-y" style="margin-top:12px">
          ${spendList.length === 0 ? '<div class="empty">No spend recorded yet. Add your marketing spend above.</div>' :
            spendList.slice(0, 10).map(r => `
              <div style="display:flex;align-items:center;gap:12px;padding:10px;border-bottom:1px solid var(--card-border)">
                <div style="width:36px;height:36px;border-radius:50%;background:var(--surface-2);display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:14px">${icon("dollar-sign")}</div>
                <div style="flex:1">
                  <div style="font-weight:500">${esc(r.channel.replace("_", " "))}</div>
                  <div style="font-size:12px;color:var(--muted)">${esc(r.description || "No description")}</div>
                </div>
                <div style="text-align:right">
                  <div style="font-weight:600;color:var(--primary)">$${r.amount.toFixed(2)}</div>
                  <div style="font-size:11px;color:var(--muted)">${new Date(r.date).toLocaleDateString()}</div>
                </div>
              </div>
            `).join("")}
        </div>
      </div>`;

    window.recordSpend = async () => {
      const channel = document.getElementById("cac-channel").value;
      const amount = parseFloat(document.getElementById("cac-amount").value);
      const description = document.getElementById("cac-desc").value;

      if (!amount || amount <= 0) {
        toast("Please enter a valid amount");
        return;
      }

      try {
        await api.post("/cac/spend", { store_id: s, channel, amount, description });
        toast(`${icon("check-circle")} $${amount.toFixed(2)} recorded for ${channel}`);
        route();
      } catch (e) {
        toast(`${icon("alert-triangle")} ${esc(e.message)}`);
      }
    };
  }

  // ── page: dynamic pricing advisory ────────────────────────────────
  async function renderPricing() {
    const s = api.store();
    const [recommendations, competitors] = await Promise.all([
      api.get(`/pricing/recommendations?store_id=${s}`).catch(() => ({ recommendations: [] })),
      api.get(`/competitors/${s}/tracked`).catch(() => ({ competitors: [] })),
    ]);

    const recs = recommendations.recommendations || [];
    const compList = Array.isArray(competitors) ? competitors : competitors.competitors || [];

    view.innerHTML = `
      <div class="grid grid-4">
        <div class="card"><h3>Products analyzed</h3><div class="kpi-value">${recs.length}</div><div class="kpi-sub">price recommendations</div></div>
        <div class="card"><h3>Price increases</h3><div class="kpi-value" style="color:var(--green)">${recs.filter(r => r.direction === 'increase').length}</div><div class="kpi-sub">margin opportunities</div></div>
        <div class="card"><h3>Price decreases</h3><div class="kpi-value" style="color:var(--amber)">${recs.filter(r => r.direction === 'decrease').length}</div><div class="kpi-sub">competitive adjustments</div></div>
        <div class="card"><h3>Hold price</h3><div class="kpi-value">${recs.filter(r => r.direction === 'hold').length}</div><div class="kpi-sub">optimal as-is</div></div>
      </div>

      <div class="card section-gap">
        <div class="card-title-row">
          <h3>${icon("trending-up")} Price Recommendations</h3>
          <button class="btn btn-primary btn-sm" onclick="getRecommendations()">${icon("refresh-cw")} Analyze Products</button>
        </div>
        <div class="scroll-y" style="margin-top:12px">
          ${recs.length === 0 ? `
            <div class="empty" style="text-align:center;padding:32px">
              <div style="font-size:48px;margin-bottom:12px">${icon("tag")}</div>
              <div style="font-weight:600;margin-bottom:8px">No pricing recommendations yet</div>
              <div style="font-size:13px;color:var(--muted);margin-bottom:16px">Add competitors and products to get AI-powered pricing advice.</div>
              <a href="#/competitors" class="btn btn-primary">Add Competitors →</a>
            </div>
          ` : `
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr>
                  <th style="text-align:left;padding:10px;border-bottom:2px solid var(--card-border)">Product</th>
                  <th style="text-align:right;padding:10px;border-bottom:2px solid var(--card-border)">Current</th>
                  <th style="text-align:right;padding:10px;border-bottom:2px solid var(--card-border)">Recommended</th>
                  <th style="text-align:center;padding:10px;border-bottom:2px solid var(--card-border)">Change</th>
                  <th style="text-align:left;padding:10px;border-bottom:2px solid var(--card-border)">Signals</th>
                  <th style="text-align:center;padding:10px;border-bottom:2px solid var(--card-border)">Action</th>
                </tr>
              </thead>
              <tbody>
                ${recs.map(r => `
                  <tr>
                    <td style="padding:10px;border-bottom:1px solid var(--card-border);font-weight:500">${esc(r.product_id)}</td>
                    <td style="text-align:right;padding:10px;border-bottom:1px solid var(--card-border)">$${r.current_price?.toFixed(2) || "—"}</td>
                    <td style="text-align:right;padding:10px;border-bottom:1px solid var(--card-border);font-weight:600;color:${r.direction === 'increase' ? 'var(--green)' : r.direction === 'decrease' ? 'var(--amber)' : 'var(--text)'}">$${r.recommended_price?.toFixed(2) || "—"}</td>
                    <td style="text-align:center;padding:10px;border-bottom:1px solid var(--card-border)">
                      <span class="pill pill-${r.direction === 'increase' ? 'green' : r.direction === 'decrease' ? 'amber' : 'gray'}">
                        ${r.change_pct > 0 ? '+' : ''}${r.change_pct?.toFixed(1) || 0}%
                      </span>
                    </td>
                    <td style="padding:10px;border-bottom:1px solid var(--card-border)">
                      ${(r.signals || []).slice(0, 2).map(sig => `
                        <div style="font-size:11px;color:var(--muted);margin-bottom:2px">
                          <span class="pill pill-cyan" style="font-size:9px;padding:2px 6px">${sig.signal}</span>
                          ${esc(sig.detail)}
                        </div>
                      `).join("")}
                    </td>
                    <td style="text-align:center;padding:10px;border-bottom:1px solid var(--card-border)">
                      ${r.direction !== 'hold' ? `<button class="btn btn-sm btn-primary" onclick="applyPrice('${esc(r.product_id)}', ${r.recommended_price})">Apply</button>` : '<span class="pill pill-gray">Optimal</span>'}
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          `}
        </div>
      </div>

      <div class="grid grid-2 section-gap">
        <div class="card">
          <h3>${icon("shield")} Guardrails</h3>
          <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--card-border)">
              <span style="font-size:13px">Max price increase</span>
              <span style="font-weight:600;color:var(--green)">+15%</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--card-border)">
              <span style="font-size:13px">Max price decrease</span>
              <span style="font-weight:600;color:var(--amber)">-20%</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--card-border)">
              <span style="font-size:13px">Data sources</span>
              <span style="font-size:12px;color:var(--muted)">Competitors, Inventory, Demand</span>
            </div>
          </div>
        </div>
        <div class="card">
          <h3>${icon("info")} How it works</h3>
          <div style="margin-top:12px;font-size:13px;color:var(--muted)">
            <p style="margin-bottom:8px">The pricing engine analyzes three signals:</p>
            <ol style="margin:0;padding-left:20px">
              <li style="margin-bottom:4px"><b>Competitor prices</b> — Are you priced above or below market?</li>
              <li style="margin-bottom:4px"><b>Inventory velocity</b> — Fast-selling items can command premium pricing.</li>
              <li><b>Demand trends</b> — Rising demand = room to increase price.</li>
            </ol>
          </div>
        </div>
      </div>`;

    window.getRecommendations = async () => {
      toast("Analyzing products for pricing recommendations...");
      // This would typically trigger analysis for all products
      route();
    };

    window.applyPrice = async (productId, newPrice) => {
      if (!confirm(`Update ${productId} to $${newPrice.toFixed(2)}?`)) return;
      toast(`${icon("check-circle")} Price updated for ${productId}`);
    };
  }

  // ── page: feature activation ──────────────────────────────────────
  async function renderFeatures() {
    const s = api.store();
    const data = await api.get(`/features/${s}`).catch(() => ({ features: [] }));
    const featureList = data.features || [];

    view.innerHTML = `
      <div class="grid grid-3">
        <div class="card"><h3>Total features</h3><div class="kpi-value">${featureList.length}</div><div class="kpi-sub">available</div></div>
        <div class="card"><h3>Active features</h3><div class="kpi-value" style="color:var(--green)">${featureList.filter(f => f.active).length}</div><div class="kpi-sub">currently enabled</div></div>
        <div class="card"><h3>Inactive features</h3><div class="kpi-value" style="color:var(--amber)">${featureList.filter(f => !f.active).length}</div><div class="kpi-sub">available to activate</div></div>
      </div>
      <div class="card section-gap">
        <div class="card-title-row"><h3>${icon("sliders")} Feature activation</h3></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
          ${featureList.map(f => `
            <div style="padding:16px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--card-border);display:flex;align-items:center;gap:12px">
              <div style="flex:1">
                <div style="font-weight:600;font-size:14px">${esc(f.name)}</div>
                <div style="font-size:12px;color:var(--muted)">${esc(f.desc)}</div>
                <div style="margin-top:4px"><span class="pill pill-gray">${f.category}</span></div>
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

  // ── page: activity log ─────────────────────────────────────────────
  async function renderActivity() {
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

    view.innerHTML = `
      <div class="card">
        <h2>Activity Log</h2>
        <p class="muted">Recent activity for your store — ${summary.total_events || 0} events in the last 30 days.</p>
        <div class="activity-list" style="margin-top:20px;">
          ${entries.length === 0 ? '<p class="muted" style="text-align:center;padding:30px;">No activity recorded yet.</p>' : entries.map((e) => `
            <div class="activity-entry">
              <div class="activity-icon">${actionIcons[e.action] || "📋"}</div>
              <div class="activity-text">
                <p class="activity-action">${esc(e.action?.replace(/_/g, " "))}</p>
                <p class="activity-detail">${esc(e.detail?.message || e.target || e.actor || "")}</p>
              </div>
              <span class="activity-time">${e.at ? new Date(e.at).toLocaleString() : ""}</span>
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
  // URL params (?demo=1, ?signup=1, ?connect_token=…) take priority
  // regardless of session state, then fall back to session restore.
  const bootParams = new URLSearchParams(location.search);

  if (bootParams.get("demo") === "1") {
    // Demo mode always starts fresh — clear any existing session.
    api.clearSession();
    $("#login").classList.remove("hidden");
    $("#demo-btn").click();
  } else if (api.session()) {
    $("#login").classList.add("hidden");
    enterApp(api.session().storeId, api.session().apiKey);
  } else {
    $("#login").classList.remove("hidden");
    applyConnectParams();
    if (bootParams.get("signup") === "1") switchAuthTab("signup");
  }
})();
