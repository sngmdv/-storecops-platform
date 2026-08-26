"use strict";

/**
 * Production Monitoring & Alerting Service
 *
 * Tracks webhook failures, worker errors, token refresh failures,
 * and message delivery failures. Provides a unified health dashboard
 * and configurable alert thresholds.
 *
 * Task 65: Production monitoring and alerting
 */

const ALERT_TYPES = {
  WEBHOOK_FAILURE: "webhook_failure",
  TOKEN_REFRESH_FAILURE: "token_refresh_failure",
  MESSAGE_DELIVERY_FAILURE: "message_delivery_failure",
  WORKER_ERROR: "worker_error",
  HIGH_ERROR_RATE: "high_error_rate",
  QUEUE_BACKLOG: "queue_backlog",
  BILLING_FAILURE: "billing_failure",
};

const SEVERITY = {
  INFO: "info",
  WARNING: "warning",
  CRITICAL: "critical",
};

function createMonitoringService({ store, config }) {
  const counters = new Map();
  const MAX_ALERTS = 500;
  const startTime = Date.now();
  const requestMetrics = {
    total: 0,
    errors: 0,
    responseTimes: [],
  };

  function bumpCounter(key) {
    const current = counters.get(key) || 0;
    counters.set(key, current + 1);
  }

  function getCounter(key) {
    return counters.get(key) || 0;
  }

  function resetCounter(key) {
    counters.delete(key);
  }

  return {
    ALERT_TYPES,
    SEVERITY,

    /**
     * Record a monitoring event (error, failure, or warning).
     */
    async recordEvent(type, detail = {}) {
      const event = {
        type,
        severity: detail.severity || SEVERITY.WARNING,
        shopInstallationId: detail.shopInstallationId || null,
        message: detail.message || "",
        error_code: detail.error_code || null,
        retry_count: detail.retry_count || 0,
        timestamp: new Date().toISOString(),
      };

      await store.monitoringEvents.insert(event);

      // Trim old events to prevent unbounded growth
      const all = await store.monitoringEvents.find({});
      if (all.length > MAX_ALERTS) {
        const sorted = all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const toRemove = sorted.slice(0, all.length - MAX_ALERTS);
        for (const old of toRemove) {
          await store.monitoringEvents.update(old._id, { _deleted: true });
        }
      }

      bumpCounter(`events:${type}`);
      if (event.severity === SEVERITY.CRITICAL) {
        bumpCounter(`critical:${type}`);
      }

      return event;
    },

    /**
     * Record a webhook delivery failure.
     */
    async recordWebhookFailure(shopInstallationId, topic, error) {
      return this.recordEvent(ALERT_TYPES.WEBHOOK_FAILURE, {
        shopInstallationId,
        message: `Webhook ${topic} failed: ${error?.message || error}`,
        severity: SEVERITY.WARNING,
        error_code: error?.code || null,
      });
    },

    /**
     * Record a token refresh failure.
     */
    async recordTokenRefreshFailure(shopInstallationId, error) {
      return this.recordEvent(ALERT_TYPES.TOKEN_REFRESH_FAILURE, {
        shopInstallationId,
        message: `Token refresh failed: ${error?.message || error}`,
        severity: SEVERITY.CRITICAL,
      });
    },

    /**
     * Record a message delivery failure (email/WhatsApp/push).
     */
    async recordMessageFailure(shopInstallationId, channel, error) {
      return this.recordEvent(ALERT_TYPES.MESSAGE_DELIVERY_FAILURE, {
        shopInstallationId,
        message: `Message delivery failed on ${channel}: ${error?.message || error}`,
        severity: channel === "whatsapp" ? SEVERITY.CRITICAL : SEVERITY.WARNING,
      });
    },

    /**
     * Record a worker/queue processing error.
     */
    async recordWorkerError(shopInstallationId, error) {
      return this.recordEvent(ALERT_TYPES.WORKER_ERROR, {
        shopInstallationId,
        message: `Worker error: ${error?.message || error}`,
        severity: SEVERITY.WARNING,
      });
    },

    /**
     * Get recent monitoring events, optionally filtered by type or installation.
     */
    async getRecentEvents({ type, shopInstallationId, severity, limit = 50 } = {}) {
      let events = await store.monitoringEvents.find((e) => {
        if (e._deleted) return false;
        if (type && e.type !== type) return false;
        if (shopInstallationId && e.shopInstallationId !== shopInstallationId) return false;
        if (severity && e.severity !== severity) return false;
        return true;
      });
      return events
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit);
    },

    /**
     * Health summary: counts of events by type and severity in the last N hours.
     */
    async getHealthSummary(hours = 24) {
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const events = await store.monitoringEvents.find(
        (e) => !e._deleted && e.timestamp >= cutoff
      );

      const byType = {};
      const bySeverity = { info: 0, warning: 0, critical: 0 };

      for (const e of events) {
        byType[e.type] = (byType[e.type] || 0) + 1;
        bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
      }

      return {
        period_hours: hours,
        total_events: events.length,
        by_type: byType,
        by_severity: bySeverity,
        healthy: bySeverity.critical === 0 && bySeverity.warning <= 5,
        generated_at: new Date().toISOString(),
      };
    },

    /**
     * Get counter values for quick dashboard stats.
     */
    getCounters() {
      const obj = {};
      for (const [key, value] of counters) {
        obj[key] = value;
      }
      return obj;
    },

    /**
     * Reset all counters (e.g. after an alert is acknowledged).
     */
    resetCounters() {
      counters.clear();
      return { reset: true };
    },

    /**
     * Track request metrics for performance monitoring.
     */
    trackRequest(duration, isError = false) {
      requestMetrics.total++;
      if (isError) requestMetrics.errors++;
      requestMetrics.responseTimes.push(duration);

      // Keep only last 1000 response times for memory efficiency
      if (requestMetrics.responseTimes.length > 1000) {
        requestMetrics.responseTimes = requestMetrics.responseTimes.slice(-1000);
      }
    },

    /**
     * Get performance metrics.
     */
    getPerformanceMetrics() {
      const times = requestMetrics.responseTimes;
      const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
      const p95 = times.length > 0 ? times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)] : 0;
      const p99 = times.length > 0 ? times.sort((a, b) => a - b)[Math.floor(times.length * 0.99)] : 0;

      return {
        total_requests: requestMetrics.total,
        error_count: requestMetrics.errors,
        error_rate: requestMetrics.total > 0 ? (requestMetrics.errors / requestMetrics.total * 100).toFixed(2) + "%" : "0%",
        avg_response_time_ms: Math.round(avg),
        p95_response_time_ms: Math.round(p95),
        p99_response_time_ms: Math.round(p99),
      };
    },

    /**
     * Get uptime in human-readable format.
     */
    getUptime() {
      const uptimeMs = Date.now() - startTime;
      const seconds = Math.floor(uptimeMs / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      return {
        uptime_ms: uptimeMs,
        uptime_seconds: seconds,
        uptime_human: `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`,
        started_at: new Date(startTime).toISOString(),
      };
    },

    /**
     * Get comprehensive health status.
     */
    async getHealthStatus() {
      const uptime = this.getUptime();
      const performance = this.getPerformanceMetrics();
      const summary = await this.getHealthSummary(24);

      return {
        status: summary.healthy ? "healthy" : "degraded",
        uptime,
        performance,
        health_summary: summary,
        timestamp: new Date().toISOString(),
      };
    },
  };
}

module.exports = { createMonitoringService, ALERT_TYPES, SEVERITY };
