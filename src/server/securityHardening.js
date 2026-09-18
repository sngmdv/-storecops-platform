'use strict';

/**
 * Security Hardening Middleware
 *
 * Adds additional security layers:
 * - Security headers (XSS, clickjacking, MIME sniffing)
 * - Input validation and sanitization
 * - Request logging for security auditing
 * - IP blocking capabilities
 *
 * Supports both Shopify embedded app mode and standalone mode.
 * Detects embedded mode via query param or header.
 */


/**
 * Routes rendered inside the Shopify Admin iframe.
 *
 * Used to pick `frame-ancestors`. This is derived from the request *path*,
 * which the server owns — not from the query string.
 */
const EMBEDDED_ROUTES = ['/app', '/admin',];

/** True when the path is one of the routes served inside the Shopify admin. */
function isEmbeddedRoute(pathname,) {
  const path = String(pathname || '/',);
  return EMBEDDED_ROUTES.some((route,) => path === route || path.startsWith(`${route}/`,),);
}

/**
 * Detect if a request *looks* like it came from the Shopify embedded app.
 *
 * This is a hint for diagnostics only, never a trust decision. Every input it
 * reads — `?shop=`, `?embedded=1`, `?host=`, `x-shopify-host` — is supplied by
 * the caller, so it must not be used to select a security policy. It used to
 * do exactly that, which made the CSP attacker-selectable: appending
 * `?shop=anything` to any URL returned the weaker embedded policy.
 */
function isEmbeddedApp(req,) {
  const host = req.query?.host || req.headers?.['x-shopify-host'];
  // Boolean() matters: the `host && ...` term evaluated to `undefined` when no
  // host was present, so this predicate returned `undefined` instead of `false`.
  return Boolean(
    req.query?.embedded === '1' ||
    req.query?.shop !== undefined ||
    (host && host.endsWith('.myshopify.com',)),
  );
}

/**
 * Security headers middleware.
 *
 * The CSP differs between the embedded app and the rest of the site in exactly
 * one directive — `frame-ancestors` — and that choice is made from the request
 * path, which the caller cannot forge. Everything else is identical, so there is
 * no weaker policy to talk a caller into.
 *
 * Previously the whole policy branched on `isEmbeddedApp(req)` and the embedded
 * branch shipped `unsafe-eval`, extra script origins, and a permissive
 * `frame-ancestors`. Because the branch came from the query string, any caller
 * could select the weaker policy with `?shop=anything`.
 *
 * Also removed, because nothing needs them:
 *   - `unsafe-eval` — no `eval()` or `new Function()` anywhere in public/.
 *   - `https://cdn.jsdelivr.net` — Chart.js is served from the local
 *     `/vendor/chart.umd.min.js`, not a CDN.
 *   - `https://*.myshopify.com` from `script-src` — we never load
 *     merchant-hosted scripts.
 *
 * KNOWN REMAINING WEAKNESSES (tracked separately, not fixed here):
 *   1. `unsafe-inline` is still required because public/*.html contain inline
 *      `<script>` blocks. Removing it means moving those into .js files.
 *   2. `frame-ancestors` for the embedded routes still allows any
 *      `https://*.myshopify.com` origin, and any Shopify merchant can create
 *      one. Pinning it to the *authenticated* shop needs the session-token
 *      plumbing in the HTML routes.
 */
function securityHeaders() {
  return (req, res, next,) => {
    // Prevent XSS attacks
    res.setHeader('X-XSS-Protection', '1; mode=block',);

    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff',);

    // Enable HSTS (HTTPS only)
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains',);
    }

    // Control referrer information
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin',);

    // Control permissions
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()',);

    const embeddedRoute = isEmbeddedRoute(req.path,);

    res.setHeader(
      'Content-Security-Policy',
      [
        'default-src \'self\'',
        // 'unsafe-inline' is required by the inline <script> blocks in
        // public/*.html. Lucide icons are vendored at
        // /vendor/lucide.min.js (like Chart.js), so no CDN script origin
        // is needed here.
        'script-src \'self\' \'unsafe-inline\'',
        'style-src \'self\' \'unsafe-inline\' https://fonts.googleapis.com',
        'img-src \'self\' data: https:',
        'font-src \'self\' data: https://fonts.gstatic.com',
        'connect-src \'self\' https: wss:',
        embeddedRoute
          // Required by `embedded = true`. Shopify serves the app from
          // admin.shopify.com and, on older admins, from {shop}.myshopify.com.
          ? 'frame-ancestors https://admin.shopify.com https://*.myshopify.com'
          : 'frame-ancestors \'none\'',
        'form-action \'self\'',
        'base-uri \'self\'',
      ].join('; ',),
    );

    if (!embeddedRoute) {
      // Kept for browsers that ignore frame-ancestors. Not set on the embedded
      // routes, where it would block the Shopify admin iframe.
      res.setHeader('X-Frame-Options', 'DENY',);
    }

    // Remove server identification
    res.removeHeader('X-Powered-By',);

    next();
  };
}

/**
 * Replace a request field with a sanitized copy.
 *
 * Direct assignment works for `body` and `params` — both are ordinary own
 * properties written by the body parser and the router. `query` is NOT:
 * Express 5 defines it as a getter on the request prototype, so `req.query = x`
 * throws "Cannot set property query of #<IncomingMessage> which has only a
 * getter" and every request 500s. Defining an own property shadows the prototype
 * accessor and behaves identically on Express 4, so this form is correct on both
 * and the middleware does not have to know which major version is installed.
 */
function replaceRequestField(req, key, value,) {
  Object.defineProperty(req, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  },);
}

/**
 * Input sanitization middleware
 */
function sanitizeInput() {
  return (req, res, next,) => {
    if (req.body) {
      replaceRequestField(req, 'body', sanitizeObject(req.body,),);
    }
    if (req.query) {
      replaceRequestField(req, 'query', sanitizeObject(req.query,),);
    }
    if (req.params) {
      replaceRequestField(req, 'params', sanitizeObject(req.params,),);
    }
    next();
  };
}

/**
 * Recursively sanitize object values
 */
function sanitizeObject(obj,) {
  if (typeof obj === 'string') {
    return sanitizeString(obj,);
  }
  if (Array.isArray(obj,)) {
    return obj.map(sanitizeObject,);
  }
  if (obj && typeof obj === 'object') {
    const sanitized = {};
    for (const [key, value,] of Object.entries(obj,)) {
      sanitized[sanitizeString(key,)] = sanitizeObject(value,);
    }
    return sanitized;
  }
  return obj;
}

/**
 * Sanitize string input — only null-byte removal for API bodies.
 * HTML encoding is NOT applied to API payloads (it breaks JSON).
 * XSS encoding is only needed for HTML template contexts.
 */
function sanitizeString(str,) {
  if (typeof str !== 'string') return str;
  return str.replace(/\0/g, '',);
}

/**
 * Request logging middleware for security auditing
 */
function securityLogger() {
  return (req, res, next,) => {
    const start = Date.now();

    // Log request
    const logEntry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      ip: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('user-agent',),
      contentType: req.get('content-type',),
      contentLength: req.get('content-length',),
    };

    // Track response
    res.on('finish', () => {
      logEntry.statusCode = res.statusCode;
      logEntry.duration = Date.now() - start;

      // Log security-relevant events
      if (res.statusCode >= 400) {
        logEntry.level = 'warn';
        logEntry.error = res.statusCode >= 500 ? 'server_error' : 'client_error';
      } else {
        logEntry.level = 'info';
      }

      // Log authentication attempts
      if (req.path.includes('/auth/',) && req.method === 'POST') {
        logEntry.authAttempt = true;
        logEntry.success = res.statusCode < 400;
      }

      // Log webhook calls
      if (req.path.includes('/webhook',)) {
        logEntry.webhook = true;
      }

      console.log('[SECURITY]', JSON.stringify(logEntry,),);
    },);

    next();
  };
}

/**
 * IP blocklist middleware
 */
function createIpBlocklist(blockedIps = [],) {
  const blocked = new Set(blockedIps,);

  return (req, res, next,) => {
    const clientIp = req.ip || req.connection?.remoteAddress;

    if (blocked.has(clientIp,)) {
      console.log('[SECURITY] Blocked IP attempted access:', clientIp,);
      return res.status(403,).json({ error: 'Access denied.', },);
    }

    return next();
  };
}

/**
 * Request size limiter
 */
function requestSizeLimiter(maxSizeBytes = 1024 * 1024,) {
  return (req, res, next,) => {
    const contentLength = parseInt(req.get('content-length',) || '0', 10,);

    if (contentLength > maxSizeBytes) {
      console.log('[SECURITY] Request too large:', contentLength, 'bytes',);
      return res.status(413,).json({ error: 'Request entity too large.', },);
    }

    return next();
  };
}

/**
 * SQL injection prevention — only blocks high-confidence attack patterns.
 * NOTE: This is a defense-in-depth layer. The real protection comes from
 * using parameterized queries (which SQLite store already does).
 * We intentionally do NOT block SELECT/INSERT/etc. in text fields since
 * those are legitimate product names, descriptions, etc.
 */
function preventSqlInjection() {
  return (req, res, next,) => {
    const sqlPatterns = [
      /(';\s*(DROP|DELETE|INSERT|UPDATE|ALTER)\b)/i,
      /(UNION\s+(ALL\s+)?SELECT)/i,
      /(--\s*$)|(\/\*.*\*\/)/,
    ];

    const checkValue = (value,) => {
      if (typeof value === 'string') {
        return sqlPatterns.some((pattern,) => pattern.test(value,),);
      }
      return false;
    };

    const checkObject = (obj,) => {
      if (!obj || typeof obj !== 'object') return false;

      for (const value of Object.values(obj,)) {
        if (checkValue(value,)) return true;
        if (typeof value === 'object' && checkObject(value,)) return true;
      }
      return false;
    };

    if (checkObject(req.body,) || checkObject(req.query,) || checkObject(req.params,)) {
      console.log('[SECURITY] Potential SQL injection detected:', req.path,);
      return res.status(400,).json({ error: 'Invalid input detected.', },);
    }

    return next();
  };
}

/**
 * Path traversal prevention
 */
function preventPathTraversal() {
  return (req, res, next,) => {
    const pathPatterns = [
      /\.\.\//,
      /\.\.\\/,
      /%2e%2e/i,
      /\.\./,
    ];

    const checkPath = (path,) => pathPatterns.some((pattern,) => pattern.test(path,),);

    // `decodeURIComponent` throws URIError on a malformed percent-escape — a
    // bare request for "/%" used to surface as an unhandled 500. A path we
    // cannot even decode is a bad request, not a server fault.
    let decoded;
    try {
      decoded = decodeURIComponent(req.path,);
    } catch {
      console.log('[SECURITY] Undecodable path:', req.path,);
      return res.status(400,).json({ error: 'Invalid path.', },);
    }

    if (checkPath(req.path,) || checkPath(decoded,)) {
      console.log('[SECURITY] Path traversal attempt:', req.path,);
      return res.status(400,).json({ error: 'Invalid path.', },);
    }

    return next();
  };
}

module.exports = {
  securityHeaders,
  isEmbeddedApp,
  sanitizeInput,
  securityLogger,
  createIpBlocklist,
  requestSizeLimiter,
  preventSqlInjection,
  preventPathTraversal,
};
