"use strict";

/**
 * Shopify App Bridge Integration
 *
 * Provides a unified API that works in both:
 * 1. Shopify embedded app mode (inside Shopify Admin iframe)
 * 2. Standalone mode (direct access outside Shopify)
 *
 * The bridge automatically detects the environment and provides
 * the appropriate API surface. In standalone mode, it falls back
 * to standard browser APIs.
 */

// App Bridge CDN URL
const APP_BRIDGE_CDN = "https://cdn.shopify.com/shopifycloud/app-bridge.js";

/**
 * Detect if we're running inside Shopify Admin (embedded mode).
 * Uses multiple signals for reliability.
 */
function isEmbeddedMode() {
  // Check URL params
  const params = new URLSearchParams(window.location.search);
  if (params.get("embedded") === "1") return true;
  if (params.get("shop")) return true;
  
  // Check for Shopify host param (embedded apps get this)
  const host = params.get("host");
  if (host && host.endsWith(".myshopify.com")) return true;
  
  // Check if we're in an iframe
  try {
    if (window.self !== window.top) return true;
  } catch {
    // Cross-origin iframe = likely Shopify Admin
    return true;
  }
  
  return false;
}

/**
 * Get Shopify session tokens from URL params or postMessage.
 */
function getShopifySession() {
  const params = new URLSearchParams(window.location.search);
  return {
    shop: params.get("shop") || null,
    host: params.get("host") || null,
    embedded: params.get("embedded") === "1",
    locale: params.get("locale") || "en",
  };
}

/**
 * Create a Shopify App Bridge instance (embedded mode only).
 * Returns null in standalone mode.
 */
function createAppBridge(config) {
  if (!isEmbeddedMode()) return null;
  
  // Dynamically load App Bridge if not already loaded
  if (!window.shopify) {
    // App Bridge is loaded via script tag in embedded mode
    // The host HTML must include:
    // <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
    console.warn("[AppBridge] App Bridge script not loaded. Add it to your HTML for embedded mode.");
    return null;
  }
  
  try {
    return window.shopify;
  } catch (err) {
    console.error("[AppBridge] Failed to initialize:", err);
    return null;
  }
}

/**
 * Unified navigation that works in both modes.
 * In embedded mode, uses App Bridge actions.
 * In standalone mode, uses standard window.location.
 */
function navigateTo(path, options = {}) {
  if (isEmbeddedMode() && window.shopify) {
    // Use App Bridge navigation
    try {
      const app = window.shopify;
      if (app.redirect) {
        app.redirect(app.Redirect.Action.REMOTE, path);
        return;
      }
    } catch (err) {
      console.warn("[AppBridge] Navigation failed, falling back to standard:", err);
    }
  }
  
  // Standard navigation (standalone mode)
  if (options.newTab) {
    window.open(path, "_blank");
  } else {
    window.location.href = path;
  }
}

/**
 * Show a toast notification that works in both modes.
 */
function showToast(message, options = {}) {
  const { isError = false, duration = 5000 } = options;
  
  if (isEmbeddedMode() && window.shopify) {
    // Use App Bridge Toast
    try {
      const app = window.shopify;
      if (app.toast) {
        app.toast.show(message, {
          isError,
          duration,
        });
        return;
      }
    } catch (err) {
      console.warn("[AppBridge] Toast failed, falling back to standard:", err);
    }
  }
  
  // Standard toast (standalone mode)
  const toast = document.getElementById("toast");
  if (toast) {
    toast.textContent = message;
    toast.className = `toast show ${isError ? "toast-error" : ""}`;
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
      toast.className = "toast";
    }, duration);
  }
}

/**
 * Get the current user/merchant info.
 * In embedded mode, this comes from Shopify session tokens.
 * In standalone mode, this comes from local storage.
 */
async function getCurrentUser() {
  if (isEmbeddedMode() && window.shopify) {
    // In embedded mode, user info comes from the session token
    // which is validated server-side
    try {
      const session = getShopifySession();
      return {
        shop: session.shop,
        isEmbedded: true,
      };
    } catch (err) {
      console.error("[AppBridge] Failed to get user:", err);
    }
  }
  
  // Standalone mode - get from local storage
  try {
    const session = JSON.parse(localStorage.getItem("storecops_session") || "null");
    return session || null;
  } catch {
    return null;
  }
}

/**
 * Initialize the App Bridge script tag in the document head.
 * Call this once when the app loads.
 */
function initAppBridgeScript() {
  if (isEmbeddedMode() && !document.querySelector('script[src*="app-bridge.js"]')) {
    const script = document.createElement("script");
    script.src = APP_BRIDGE_CDN;
    script.onload = () => {
      console.log("[AppBridge] Script loaded successfully");
    };
    script.onerror = () => {
      console.warn("[AppBridge] Failed to load App Bridge script");
    };
    document.head.appendChild(script);
  }
}

/**
 * Handle the OAuth redirect callback from Shopify.
 * This processes the session token and shop info.
 */
function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const shop = params.get("shop");
  const host = params.get("host");
  
  if (shop && host) {
    // Store Shopify session info
    sessionStorage.setItem("shopify_shop", shop);
    sessionStorage.setItem("shopify_host", host);
    return { shop, host };
  }
  
  return null;
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  isEmbeddedMode,
  getShopifySession,
  createAppBridge,
  navigateTo,
  showToast,
  getCurrentUser,
  initAppBridgeScript,
  handleOAuthCallback,
  APP_BRIDGE_CDN,
};

// Also export for browser usage (will be bundled)
if (typeof window !== "undefined") {
  window.StorecopsBridge = module.exports;
}
