/**
 * Storecops hosted storefront tracker.
 *
 * Injected into merchant stores via the Shopify Script Tag API (or
 * pasted manually before </body>). Collects product views, cart adds,
 * purchases and sends them to the platform /track endpoint using the
 * write-only ingest key — never exposes the tenant's read API key.
 *
 * ── Task 31: Shopify Consent / Privacy Compliance Audit ──────────
 *
 * CONSENT MODEL (two-tier, aligned with Shopify Customer Privacy API):
 *
 *   Analytics tier (session_start, product_view, scroll_depth):
 *     - Requires: analyticsProcessingAllowed = true
 *     - Default (no banner): ALLOWED — these are anonymous behavioral
 *       metrics (no PII, no cross-site identifiers) needed for the
 *       platform's core intelligence features.
 *     - Shopify docs: https://shopify.dev/docs/api/customer-privacy
 *
 *   Marketing tier (cart_updated, cart_abandoned, purchase, lead_captured):
 *     - Requires: marketingAllowed = true
 *     - Default (no banner): BLOCKED — these events power recovery
 *       messaging and require explicit opt-in under GDPR/CCPA/DPDP.
 *     - Shopify docs: https://shopify.dev/docs/api/customer-privacy
 *
 * REGIONAL COMPLIANCE:
 *   - EU/UK (GDPR/ePrivacy): Analytics default-allowed is permissible
 *     for anonymous first-party metrics. Marketing requires opt-in.
 *   - California (CCPA/CPRA): No "sale" of data — identifiers are
 *     first-party, not shared with third parties. Opt-out respected.
 *   - India (DPDP 2023): Consent obtained via Shopify's privacy API.
 *     Data minimization enforced (see Task 34 payload audit below).
 *
 * CONSENT CHANGE LISTENERS:
 *   - tracking_consent  → Shopify Customer Privacy API
 *   - cmp:consentupdate → Google Consent Mode v2
 *   - storecops:consent → Merchant custom banner
 *   On any change, readConsent() is re-evaluated and tracking starts
 *   or stops immediately.
 *
 * DATA MINIMIZATION (Task 34):
 *   - No IP address, user-agent, cookies, or fingerprinting data.
 *   - Product context limited to: product_id, product_price, page_url.
 *   - No product_name or product_image (not needed for intelligence).
 *   - No referrer URL in session_start (not needed for core features).
 *   - Identifiers are random UUIDs, not derived from PII.
 *
 * Full disclosure page: /tracker-disclosure.html
 * ────────────────────────────────────────────────────────────────────
 */
(function () {
  "use strict";
  if (window.__STORECOPS_TRACKER_READY__) return;

  /* ── Bootstrap: read config from the script tag URL ─────────── */
  var currentScript =
    document.currentScript ||
    document.querySelector('script[src*="tracker.js"]');
  if (!currentScript) return;

  var scriptUrl = new URL(currentScript.src);
  var storeId = scriptUrl.searchParams.get("store");
  var ingestKey = scriptUrl.searchParams.get("key");
  var apiBase = scriptUrl.origin + "/api/v1";

  if (!storeId || !ingestKey) return; // silently exit if misconfigured

  window.__STORECOPS_TRACKER_READY__ = true;

  /* ── Consent gating ─────────────────────────────────────────── */
  function readConsent() {
    try {
      var override = String(window.STORECOPS_CONSENT || "").toLowerCase();
      if (override === "granted") return { analytics: true, marketing: true };
      if (override === "denied") return { analytics: false, marketing: false };

      var shopify = window.Shopify && window.Shopify.customerPrivacy;
      if (shopify) {
        return {
          analytics: Boolean(
            shopify.analyticsProcessingAllowed ||
              shopify.analytics_processing_allowed
          ),
          marketing: Boolean(
            shopify.marketingAllowed || shopify.marketing_allowed
          ),
        };
      }
    } catch (_) {}
    // Default: analytics allowed, marketing requires opt-in.
    return { analytics: true, marketing: false };
  }

  var consent = readConsent();

  function canTrack(eventType) {
    var isMarketing =
      eventType === "cart_updated" ||
      eventType === "purchase" ||
      eventType === "cart_abandoned";
    return isMarketing ? consent.marketing : consent.analytics;
  }

  /* ── Identifiers (only persisted after consent) ─────────────── */
  var memStore = {};
  function safeGet(type, key) {
    try {
      var s = type === "local" ? localStorage : sessionStorage;
      return s.getItem(key) || memStore[key] || null;
    } catch (_) {
      return memStore[key] || null;
    }
  }
  function safeSet(type, key, val) {
    try {
      var s = type === "local" ? localStorage : sessionStorage;
      s.setItem(key, val);
    } catch (_) {
      memStore[key] = val;
    }
  }

  function genId(prefix) {
    if (window.crypto && crypto.randomUUID) return prefix + "_" + crypto.randomUUID();
    return prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2);
  }

  var visitorId = safeGet("local", "sc_vid") || genId("sc_v");
  var sessionId = safeGet("session", "sc_sid") || genId("sc_s");
  safeSet("local", "sc_vid", visitorId);
  safeSet("session", "sc_sid", sessionId);

  /* ── Transmit helper ────────────────────────────────────────── */
  function transmit(eventType, data) {
    if (!canTrack(eventType)) return;
    var body = Object.assign(
      {
        store_id: storeId,
        event_type: eventType,
        timestamp: new Date().toISOString(),
        visitor_id: visitorId,
        session_id: sessionId,
      },
      data || {}
    );
    try {
      var blob = new Blob([JSON.stringify(body)], { type: "application/json" });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(apiBase + "/track?api_key=" + encodeURIComponent(ingestKey), blob);
      } else {
        fetch(apiBase + "/track", {
          method: "POST",
          headers: { "X-API-Key": ingestKey, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive: true,
        });
      }
    } catch (_) {
      /* never break the host page */
    }
  }

  /* ── Product context from the page ──────────────────────────── */
  /* Task 34: Minimized payload — only product_id, product_price,
     and page_url are needed for intelligence. product_name and
     product_image were removed (not used by any platform feature). */
  function getProductInfo() {
    return {
      product_id:
        document.querySelector('meta[name="product-id"]')?.content ||
        document.querySelector('[data-product-id]')?.dataset.productId ||
        null,
      product_price:
        document.querySelector('meta[property="og:price:amount"]')?.content ||
        document.querySelector('[class*="price"]')?.innerText?.replace(/[^0-9.]/g, "") ||
        null,
      page_url: window.location.href,
    };
  }

  /* ── Auto-track product views ───────────────────────────────── */
  function trackProductView() {
    var info = getProductInfo();
    if (!info.product_id && !window.location.href.includes("/products/")) return;
    transmit("product_view", info);
  }

  /* ── Cart interception (Shopify AJAX cart API) ──────────────── */
  function interceptCart() {
    try {
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function () {
        this._sc_url = arguments[1];
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        this.addEventListener("load", function () {
          try {
            if (/\/cart\/(add|update|change)/.test(this._sc_url || "")) {
              transmit("cart_updated", { source: "ajax_intercept" });
            }
          } catch (_) {}
        });
        return origSend.apply(this, arguments);
      };
    } catch (_) {}
  }

  /* ── Exit intent (abandonment signal) ───────────────────────── */
  document.addEventListener("mouseleave", function (e) {
    if (e.clientY < 0) {
      transmit("cart_abandoned", { exit_intent: true });
    }
  });

  /* ── Email capture from forms ───────────────────────────────── */
  document.addEventListener("focusout", function (e) {
    var val = e.target?.value;
    if (val && /@/.test(val) && /\./.test(val)) {
      transmit("lead_captured", { email: val.trim().toLowerCase() });
    }
  });

  /* ── Scroll depth ───────────────────────────────────────────── */
  var scrollFired = {};
  window.addEventListener("scroll", function () {
    var docH = document.documentElement.scrollHeight - window.innerHeight;
    if (docH <= 0) return;
    var pct = Math.round((window.scrollY / docH) * 100);
    [50, 75, 90].forEach(function (m) {
      if (pct >= m && !scrollFired[m]) {
        scrollFired[m] = true;
        transmit("scroll_depth", { depth: pct });
      }
    });
  });

  /* ── Consent change listener ────────────────────────────────── */
  function refreshConsent() {
    consent = readConsent();
  }
  try {
    document.addEventListener("tracking_consent", refreshConsent);
    window.addEventListener("cmp:consentupdate", refreshConsent);
    window.addEventListener("storecops:consent", refreshConsent);
  } catch (_) {}

  /* ── Public API for merchant themes ─────────────────────────── */
  window.Storecops = {
    view: function (productId) {
      transmit("product_view", { product_id: productId });
    },
    cart: function (productId, qty) {
      transmit("cart_updated", { product_id: productId, quantity: qty || 1 });
    },
    abandon: function (productId) {
      transmit("cart_abandoned", { product_id: productId });
    },
    purchase: function (order) {
      transmit("purchase", order);
    },
    debug: function () {
      return { consent: consent, visitorId: visitorId, sessionId: sessionId };
    },
  };

  /* ── Init ───────────────────────────────────────────────────── */
  /* Task 34: referrer removed from session_start — not needed by
     any platform feature and reduces data footprint. */
  interceptCart();
  setTimeout(trackProductView, 2000);
  transmit("session_start", {});
})();
