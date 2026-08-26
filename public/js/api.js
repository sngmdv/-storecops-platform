"use strict";

/* Tiny API client: session (store + key + bearer token) lives in localStorage. */

window.StorecopsAPI = (function () {
  const BASE = "/api/v1";

  function session() {
    try {
      return JSON.parse(localStorage.getItem("storecops_session") || "null");
    } catch {
      return null;
    }
  }

  /** Session shape: { storeId, apiKey, token?, email? } */
  function saveSession(storeId, apiKey, extra = {}) {
    localStorage.setItem(
      "storecops_session",
      JSON.stringify({ storeId, apiKey, ...extra })
    );
  }

  function clearSession() {
    localStorage.removeItem("storecops_session");
  }

  async function request(method, path, body) {
    const sess = session();
    const headers = { "Content-Type": "application/json" };
    // Bearer token first (real login); API key as fallback (dev/demo).
    if (sess?.token) headers["Authorization"] = `Bearer ${sess.token}`;
    else if (sess?.apiKey) headers["X-API-Key"] = sess.apiKey;

    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  /** Public auth endpoints — no session required. */
  async function authRequest(path, body) {
    const res = await fetch(BASE + "/auth" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data; // { user, store_id, api_key, token, expires_at }
  }

  /** SSE stream — EventSource can't send headers, so the key goes in the query. */
  function liveStream(storeId, onPurchase) {
    const sess = session();
    const url = `${BASE}/live/${encodeURIComponent(storeId)}?api_key=${encodeURIComponent(sess?.apiKey || "")}`;
    const source = new EventSource(url);
    source.addEventListener("purchase", (event) => {
      try {
        onPurchase(JSON.parse(event.data));
      } catch {
        /* ignore malformed frames */
      }
    });
    return source; // caller owns .close()
  }

  return {
    session,
    saveSession,
    clearSession,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body || {}),
    put: (path, body) => request("PUT", path, body || {}),
    del: (path) => request("DELETE", path),
    liveStream,
    store: () => encodeURIComponent(session()?.storeId || "demo_store"),

    // Real auth: signup/login return { store_id, api_key, token }.
    signup: (payload) => authRequest("/signup", payload),
    login: (payload) => authRequest("/login", payload),
    logoutRemote: () => {
      const sess = session();
      return fetch(BASE + "/auth/logout", {
        method: "POST",
        headers: sess?.token ? { Authorization: `Bearer ${sess.token}` } : {},
      }).catch(() => {});
    },
  };
})();
