"use strict";

/**
 * Security Hardening Middleware
 *
 * Adds additional security layers:
 * - Security headers (XSS, clickjacking, MIME sniffing)
 * - Input validation and sanitization
 * - Request logging for security auditing
 * - IP blocking capabilities
 */

const crypto = require("crypto");

/**
 * Security headers middleware (Helmet-like)
 */
function securityHeaders() {
  return (req, res, next) => {
    // Prevent XSS attacks
    res.setHeader("X-XSS-Protection", "1; mode=block");

    // Prevent MIME type sniffing
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Prevent clickjacking
    res.setHeader("X-Frame-Options", "DENY");

    // Enable HSTS (HTTPS only)
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    // Control referrer information
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    // Control permissions
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

    // Content Security Policy (adjust for your needs)
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:;"
    );

    // Remove server identification
    res.removeHeader("X-Powered-By");

    next();
  };
}

/**
 * Input sanitization middleware
 */
function sanitizeInput() {
  return (req, res, next) => {
    if (req.body) {
      req.body = sanitizeObject(req.body);
    }
    if (req.query) {
      req.query = sanitizeObject(req.query);
    }
    if (req.params) {
      req.params = sanitizeObject(req.params);
    }
    next();
  };
}

/**
 * Recursively sanitize object values
 */
function sanitizeObject(obj) {
  if (typeof obj === "string") {
    return sanitizeString(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  if (obj && typeof obj === "object") {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[sanitizeString(key)] = sanitizeObject(value);
    }
    return sanitized;
  }
  return obj;
}

/**
 * Sanitize string input
 */
function sanitizeString(str) {
  if (typeof str !== "string") return str;

  // Remove null bytes
  let sanitized = str.replace(/\0/g, "");

  // Basic XSS prevention - encode HTML entities
  sanitized = sanitized
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

  return sanitized;
}

/**
 * Request logging middleware for security auditing
 */
function securityLogger() {
  return (req, res, next) => {
    const start = Date.now();

    // Log request
    const logEntry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      ip: req.ip || req.connection?.remoteAddress,
      userAgent: req.get("user-agent"),
      contentType: req.get("content-type"),
      contentLength: req.get("content-length"),
    };

    // Track response
    res.on("finish", () => {
      logEntry.statusCode = res.statusCode;
      logEntry.duration = Date.now() - start;

      // Log security-relevant events
      if (res.statusCode >= 400) {
        logEntry.level = "warn";
        logEntry.error = res.statusCode >= 500 ? "server_error" : "client_error";
      } else {
        logEntry.level = "info";
      }

      // Log authentication attempts
      if (req.path.includes("/auth/") && req.method === "POST") {
        logEntry.authAttempt = true;
        logEntry.success = res.statusCode < 400;
      }

      // Log webhook calls
      if (req.path.includes("/webhook")) {
        logEntry.webhook = true;
      }

      console.log("[SECURITY]", JSON.stringify(logEntry));
    });

    next();
  };
}

/**
 * IP blocklist middleware
 */
function createIpBlocklist(blockedIps = []) {
  const blocked = new Set(blockedIps);

  return (req, res, next) => {
    const clientIp = req.ip || req.connection?.remoteAddress;

    if (blocked.has(clientIp)) {
      console.log("[SECURITY] Blocked IP attempted access:", clientIp);
      return res.status(403).json({ error: "Access denied." });
    }

    next();
  };
}

/**
 * Request size limiter
 */
function requestSizeLimiter(maxSizeBytes = 1024 * 1024) {
  return (req, res, next) => {
    const contentLength = parseInt(req.get("content-length") || "0", 10);

    if (contentLength > maxSizeBytes) {
      console.log("[SECURITY] Request too large:", contentLength, "bytes");
      return res.status(413).json({ error: "Request entity too large." });
    }

    next();
  };
}

/**
 * SQL injection prevention (for any raw queries)
 */
function preventSqlInjection() {
  return (req, res, next) => {
    const sqlPatterns = [
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|FETCH|DECLARE|TRUNCATE)\b)/i,
      /(-{2})|(\b(OR|AND)\b\s+\d+\s*=\s*\d+)/i,
      /(';\s*(DROP|DELETE|INSERT|UPDATE))/i,
    ];

    const checkValue = (value) => {
      if (typeof value === "string") {
        return sqlPatterns.some((pattern) => pattern.test(value));
      }
      return false;
    };

    const checkObject = (obj) => {
      if (!obj || typeof obj !== "object") return false;

      for (const value of Object.values(obj)) {
        if (checkValue(value)) return true;
        if (typeof value === "object" && checkObject(value)) return true;
      }
      return false;
    };

    if (checkObject(req.body) || checkObject(req.query) || checkObject(req.params)) {
      console.log("[SECURITY] Potential SQL injection detected:", req.path);
      return res.status(400).json({ error: "Invalid input detected." });
    }

    next();
  };
}

/**
 * Path traversal prevention
 */
function preventPathTraversal() {
  return (req, res, next) => {
    const pathPatterns = [
      /\.\.\//,
      /\.\.\\/,
      /%2e%2e/i,
      /\.\./,
    ];

    const checkPath = (path) => pathPatterns.some((pattern) => pattern.test(path));

    if (checkPath(req.path) || checkPath(decodeURIComponent(req.path))) {
      console.log("[SECURITY] Path traversal attempt:", req.path);
      return res.status(400).json({ error: "Invalid path." });
    }

    next();
  };
}

module.exports = {
  securityHeaders,
  sanitizeInput,
  securityLogger,
  createIpBlocklist,
  requestSizeLimiter,
  preventSqlInjection,
  preventPathTraversal,
};
