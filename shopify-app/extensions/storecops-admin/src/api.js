/**
 * Backend client shared by every Storecops admin extension.
 *
 * Extensions run inside Shopify's admin, on Shopify's origin, so every
 * call here is cross-domain. Two things make that work:
 *
 *   1. A Shopify session token is fetched fresh before each request.
 *      It expires in about a minute, so it is never cached.
 *   2. The token goes in `Authorization: Bearer <token>`. The backend
 *      verifies the HS256 signature against the app's client secret and
 *      resolves which shop (and therefore which tenant) is calling.
 *
 * The backend also has to send CORS headers — see src/server/cors.js.
 */

/** Where the Storecops API lives. Override for a staging deployment. */
export const APP_URL = 'https://storecops.com';

/**
 * Fetch a fresh Shopify session token.
 *
 * The admin extension runtime exposes it on the global `shopify`
 * object. Both spellings are probed because the surface has moved
 * between App Bridge versions.
 */
async function getSessionToken() {
  const shopifyGlobal = globalThis.shopify;

  if (typeof shopifyGlobal?.auth?.idToken === 'function') {
    return shopifyGlobal.auth.idToken();
  }
  if (typeof shopifyGlobal?.idToken === 'function') {
    return shopifyGlobal.idToken();
  }
  throw new Error(
    'Could not obtain a Shopify session token. This extension must run inside the Shopify admin.',
  );
}

/**
 * Call the Storecops API as the current shop.
 *
 * @param {string} path   e.g. '/ext/shop/me'
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {object} [opts.body]
 * @returns {Promise<object>}
 */
export async function callApi(path, { method = 'GET', body, } = {},) {
  const token = await getSessionToken();

  const response = await fetch(`${APP_URL}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body,) : undefined,
  },);

  if (!response.ok) {
    // Surface the backend's message — it is written for humans.
    const detail = await response.json().catch(() => ({}),);
    throw new Error(detail.error || `Storecops request failed (${response.status}).`,);
  }

  return response.json();
}

/**
 * The Shopify GID of whatever resource the extension is rendered on.
 * Blocks and actions receive it via `shopify.data.selected`.
 */
export function selectedId() {
  return globalThis.shopify?.data?.selected?.[0]?.id ?? null;
}

/** Strip a Shopify GID down to its numeric id (`.../Customer/123` -> `123`). */
export function numericId(gid,) {
  if (!gid) return null;
  const match = String(gid,).match(/\/(\d+)(?:\?.*)?$/,);
  return match ? match[1] : String(gid,);
}
