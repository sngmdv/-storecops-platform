"use strict";

/**
 * Webhook Retry Queue — reliable delivery for outbound webhooks.
 *
 * When a webhook delivery fails (network error, timeout, non-2xx response),
 * it enters a retry queue with exponential backoff:
 *   Attempt 1: immediate
 *   Attempt 2: 1 minute
 *   Attempt 3: 5 minutes
 *   Attempt 4: 30 minutes
 *   Attempt 5: 2 hours (final)
 *
 * After max retries, the webhook enters a dead-letter queue for manual
 * inspection. Failed webhooks generate critical notifications.
 */

const RETRY_SCHEDULE_MS = [
  0,              // immediate
  60 * 1000,      // 1 minute
  5 * 60 * 1000,  // 5 minutes
  30 * 60 * 1000, // 30 minutes
  2 * 60 * 60 * 1000, // 2 hours
];

const MAX_RETRIES = RETRY_SCHEDULE_MS.length;
const TIMEOUT_MS = 10000;
const PROCESS_INTERVAL_MS = 30 * 1000; // Check queue every 30 seconds

function createWebhookRetryQueue({ store, notificationService }) {
  let processingTimer = null;

  async function deliverWebhook(entry) {
    const { url, payload, headers = {}, attempt } = entry;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Storecops-Retry": String(attempt),
          "X-Storecops-Delivery-Id": entry._id,
          ...headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        return { success: true, status: response.status, attempt };
      }

      return {
        success: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        attempt,
      };
    } catch (error) {
      return {
        success: false,
        status: null,
        error: error.name === "AbortError" ? "Timeout" : error.message,
        attempt,
      };
    }
  }

  async function processQueue() {
    const now = Date.now();
    const pending = await store.webhookQueue.find((entry) =>
      entry.status === "pending" && entry.next_retry_at <= new Date(now).toISOString()
    );

    if (pending.length === 0) return { processed: 0 };

    let delivered = 0;
    let failed = 0;

    for (const entry of pending) {
      const result = await deliverWebhook(entry);

      if (result.success) {
        await store.webhookQueue.update(entry._id, {
          status: "delivered",
          delivered_at: new Date().toISOString(),
          last_result: result,
        });
        delivered++;
      } else {
        const nextAttempt = entry.attempt + 1;
        if (nextAttempt >= MAX_RETRIES) {
          // Move to dead letter.
          await store.webhookQueue.update(entry._id, {
            status: "dead_letter",
            last_result: result,
            dead_letter_at: new Date().toISOString(),
            attempt: nextAttempt,
          });

          // Notify about dead-lettered webhook.
          if (notificationService) {
            await notificationService.push({
              store_id: entry.store_id || "__admin__",
              title: "Webhook delivery failed permanently",
              message: `Webhook to ${entry.url} failed after ${MAX_RETRIES} attempts: ${result.error}`,
              severity: "critical",
              category: "system",
            }).catch(() => {});
          }
          failed++;
        } else {
          const delayMs = RETRY_SCHEDULE_MS[nextAttempt] || RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1];
          const nextRetry = new Date(now + delayMs).toISOString();
          await store.webhookQueue.update(entry._id, {
            attempt: nextAttempt,
            next_retry_at: nextRetry,
            last_result: result,
            retry_count: (entry.retry_count || 0) + 1,
          });
        }
      }
    }

    return { processed: pending.length, delivered, failed };
  }

  return {
    MAX_RETRIES,
    RETRY_SCHEDULE_MS,

    /**
     * Enqueue a webhook for delivery with automatic retry.
     */
    async enqueue({ store_id, url, payload, headers, priority = "normal" }) {
      if (!url) throw new Error("url is required");
      if (!payload) throw new Error("payload is required");

      const entry = await store.webhookQueue.insert({
        store_id: store_id || null,
        url,
        payload,
        headers: headers || {},
        priority,
        status: "pending",
        attempt: 0,
        retry_count: 0,
        next_retry_at: new Date().toISOString(), // Immediate first attempt.
        created_at: new Date().toISOString(),
      });

      // Attempt immediate delivery.
      const result = await deliverWebhook({ ...entry, attempt: 0 });
      if (result.success) {
        await store.webhookQueue.update(entry._id, {
          status: "delivered",
          delivered_at: new Date().toISOString(),
          last_result: result,
        });
        return { enqueued: true, delivered_immediately: true, id: entry._id };
      }

      // First attempt failed — update for retry.
      const nextDelay = RETRY_SCHEDULE_MS[1] || 60000;
      await store.webhookQueue.update(entry._id, {
        attempt: 1,
        next_retry_at: new Date(Date.now() + nextDelay).toISOString(),
        last_result: result,
      });

      return { enqueued: true, delivered_immediately: false, id: entry._id, next_retry_in_ms: nextDelay };
    },

    /**
     * Start the background processor that retries pending webhooks.
     */
    start() {
      if (processingTimer) return;
      processingTimer = setInterval(() => {
        processQueue().catch((err) =>
          console.error("[WEBHOOK-QUEUE] Processing error:", err.message)
        );
      }, PROCESS_INTERVAL_MS);
      if (processingTimer.unref) processingTimer.unref();
      console.log(`[WEBHOOK-QUEUE] Retry processor started (every ${PROCESS_INTERVAL_MS / 1000}s)`);
    },

    /**
     * Stop the background processor.
     */
    stop() {
      if (processingTimer) {
        clearInterval(processingTimer);
        processingTimer = null;
      }
    },

    /**
     * Manually trigger queue processing (for tests or admin action).
     */
    async processNow() {
      return processQueue();
    },

    /**
     * Get queue status summary.
     */
    async status() {
      const all = await store.webhookQueue.find({});
      const pending = all.filter((e) => e.status === "pending");
      const deadLetter = all.filter((e) => e.status === "dead_letter");
      const delivered = all.filter((e) => e.status === "delivered");

      return {
        total: all.length,
        pending: pending.length,
        delivered: delivered.length,
        dead_letter: deadLetter.length,
        next_retry: pending.length > 0
          ? pending.sort((a, b) => (a.next_retry_at || "").localeCompare(b.next_retry_at || ""))[0]?.next_retry_at
          : null,
      };
    },

    /**
     * Retry a dead-lettered webhook manually.
     */
    async retryDeadLetter(entry_id) {
      const entry = await store.webhookQueue.findById(entry_id);
      if (!entry || entry.status !== "dead_letter") {
        throw new Error("Entry not found or not in dead-letter state.");
      }

      await store.webhookQueue.update(entry_id, {
        status: "pending",
        attempt: 0,
        retry_count: 0,
        next_retry_at: new Date().toISOString(),
        dead_letter_at: null,
      });

      return { retried: true, id: entry_id };
    },

    /**
     * Clear old delivered/dead-letter entries (cleanup).
     */
    async cleanup(olderThanDays = 7) {
      const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
      const all = await store.webhookQueue.find({});
      let cleared = 0;

      for (const entry of all) {
        if ((entry.status === "delivered" || entry.status === "dead_letter") && entry.createdAt < cutoff) {
          // Mark as cleared (in-memory store doesn't support delete, so flag it).
          await store.webhookQueue.update(entry._id, { cleared: true });
          cleared++;
        }
      }

      return { cleared };
    },
  };
}

module.exports = { createWebhookRetryQueue, RETRY_SCHEDULE_MS, MAX_RETRIES };
