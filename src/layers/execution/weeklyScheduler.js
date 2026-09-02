'use strict';

/**
 * Weekly Email Scheduler
 *
 * Automatically sends weekly digest emails to merchants:
 * - Runs every Sunday at 9 AM (configurable)
 * - Generates and sends weekly performance reports
 * - Tracks send history to avoid duplicates
 * - Supports different digest types (weekly, monthly)
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function createWeeklyScheduler({ store, reporting, emailService, emailTemplates, notificationService, },) {
  let schedulerInterval = null;
  const sendHistory = new Map();

  function getNextSunday9AM() {
    const now = new Date();
    const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
    const nextSunday = new Date(now,);
    nextSunday.setDate(now.getDate() + daysUntilSunday,);
    nextSunday.setHours(9, 0, 0, 0,);
    return nextSunday;
  }

  function getWeekKey(date,) {
    const d = new Date(date,);
    const startOfYear = new Date(d.getFullYear(), 0, 1,);
    const weekNumber = Math.ceil(((d - startOfYear) / DAY_MS + startOfYear.getDay() + 1) / 7,);
    return `${d.getFullYear()}-W${weekNumber}`;
  }

  async function sendWeeklyDigest(store_id,) {
    const weekKey = getWeekKey(new Date(),);
    const historyKey = `${store_id}:${weekKey}`;

    // Don't send if already sent this week
    if (sendHistory.has(historyKey,)) {
      return { sent: false, reason: 'already_sent_this_week', };
    }

    try {
      // Generate the weekly digest
      const digest = await reporting.weeklyDigest(store_id,);

      // Get store owner email
      const user = await store.users?.findOne({ store_id, role: 'owner', },);
      const email = user?.email;

      if (!email) {
        return { sent: false, reason: 'no_email_found', };
      }

      // Build email content
      const subject = `📊 Your Weekly Store Report — ${digest.headline.revenue > 0 ? `$${digest.headline.revenue.toFixed(2,)} revenue` : 'Getting started'}`;
      const body = buildDigestEmail(digest,);

      // Send email
      if (emailService) {
        await emailService.send({
          to: email,
          subject,
          html: body,
          from: 'Storecops <reports@storecops.ai>',
        },);
      }

      // Record in history
      sendHistory.set(historyKey, {
        store_id,
        sent_at: new Date().toISOString(),
        week_key: weekKey,
      },);

      // Persist to database
      await store.activityLogs?.insert({
        store_id,
        type: 'weekly_digest_sent',
        week_key: weekKey,
        sent_at: new Date().toISOString(),
        digest_summary: {
          revenue: digest.headline.revenue,
          actions_delivered: digest.headline.actions_delivered,
          roi_percent: digest.headline.roi_percent,
        },
      },);

      // Send notification
      if (notificationService) {
        await notificationService.send(store_id, {
          type: 'weekly_digest',
          title: 'Weekly Report Sent',
          message: `Your weekly performance report has been sent to ${email}`,
          icon: '📊',
          severity: 'success',
          category: 'report',
        },);
      }

      return { sent: true, email, week_key: weekKey, };
    } catch (error) {
      console.error(`Failed to send weekly digest for ${store_id}:`, error,);
      return { sent: false, reason: 'error', error: error.message, };
    }
  }

  function buildDigestEmail(digest,) {
    const revenue = digest.headline.revenue || 0;
    const actions = digest.headline.actions_delivered || 0;
    const roi = digest.headline.roi_percent || 0;
    const maturity = digest.headline.maturity_stage || 'N/A';
    const sentiment = digest.sentiment_trend?.current || 0;
    const sentimentDir = digest.sentiment_trend?.direction || 'N/A';

    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: white; }
    .header { background: linear-gradient(265.26deg, #08906c 38.04%, #34bf99 94.86%); padding: 32px; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 24px; }
    .header p { color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 14px; }
    .content { padding: 32px; }
    .metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 24px 0; }
    .metric { background: #f8f9fa; padding: 16px; border-radius: 8px; text-align: center; }
    .metric-value { font-size: 28px; font-weight: 700; color: #08906c; }
    .metric-label { font-size: 12px; color: #666; margin-top: 4px; }
    .section { margin: 24px 0; }
    .section h3 { font-size: 16px; margin: 0 0 12px; color: #333; }
    .insight { padding: 12px; background: #f0fdf4; border-left: 4px solid #08906c; margin: 8px 0; border-radius: 0 4px 4px 0; }
    .cta { text-align: center; margin: 32px 0; }
    .cta a { background: #08906c; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; }
    .footer { padding: 24px; text-align: center; background: #f8f9fa; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Weekly Performance Report</h1>
      <p>Your store's health at a glance</p>
    </div>
    <div class="content">
      <div class="metric-grid">
        <div class="metric">
          <div class="metric-value">$${revenue.toFixed(2,)}</div>
          <div class="metric-label">Total Revenue</div>
        </div>
        <div class="metric">
          <div class="metric-value">${actions}</div>
          <div class="metric-label">Actions Delivered</div>
        </div>
        <div class="metric">
          <div class="metric-value" style="color: ${roi >= 0 ? '#08906c' : '#ef4444'}">${roi.toFixed(1,)}%</div>
          <div class="metric-label">ROI</div>
        </div>
        <div class="metric">
          <div class="metric-value">${maturity}</div>
          <div class="metric-label">Maturity Stage</div>
        </div>
      </div>

      <div class="section">
        <h3>📈 Key Insights</h3>
        <div class="insight">
          <strong>Sentiment:</strong> ${sentiment > 0 ? 'Positive' : sentiment < 0 ? 'Negative' : 'Neutral'} (${sentimentDir})
        </div>
        <div class="insight">
          <strong>Funnel:</strong> ${digest.funnel?.product_views || 0} views → ${digest.funnel?.carts || 0} carts → ${digest.funnel?.purchases || 0} purchases
        </div>
        <div class="insight">
          <strong>Churn Risk:</strong> ${digest.churn?.risk_bands?.CRITICAL || 0} critical, ${digest.churn?.risk_bands?.HIGH || 0} high-risk customers
        </div>
      </div>

      <div class="cta">
        <a href="https://app.storecops.ai">View Full Dashboard →</a>
      </div>
    </div>
    <div class="footer">
      <p>Storecops — AI-Powered Store Intelligence</p>
      <p>You're receiving this because you're subscribed to weekly reports.</p>
    </div>
  </div>
</body>
</html>`;
  }

  return {
    /**
     * Start the weekly scheduler.
     * Checks every hour if it's time to send digests.
     */
    start() {
      if (schedulerInterval) return;

      schedulerInterval = setInterval(async () => {
        const now = new Date();
        // Send on Sunday at 9 AM
        if (now.getDay() === 0 && now.getHours() === 9) {
          const allStores = await store.onboardingStates?.find({ completed: true, },) || [];
          for (const state of allStores) {
            await sendWeeklyDigest(state.store_id,);
          }
        }
      }, 60 * 60 * 1000,); // Check every hour

      // Don't keep the process alive solely for the scheduler (tests,
      // one-off scripts). The running server keeps it alive in prod.
      if (schedulerInterval.unref) schedulerInterval.unref();

      console.log('[WeeklyScheduler] Started — will send digests every Sunday at 9 AM',);
    },

    /**
     * Stop the scheduler.
     */
    stop() {
      if (schedulerInterval) {
        clearInterval(schedulerInterval,);
        schedulerInterval = null;
      }
    },

    /**
     * Manually send a weekly digest for a store.
     */
    sendWeeklyDigest,

    /**
     * Get send history for a store.
     */
    async getSendHistory(store_id, limit = 10,) {
      const logs = await store.activityLogs?.find({
        store_id,
        type: 'weekly_digest_sent',
      },) || [];

      return logs
        .sort((a, b,) => new Date(b.sent_at,) - new Date(a.sent_at,),)
        .slice(0, limit,);
    },

    /**
     * Schedule a digest for immediate sending (for testing).
     */
    async sendNow(store_id,) {
      return sendWeeklyDigest(store_id,);
    },

    /**
     * Get the next scheduled send time.
     */
    getNextSendTime() {
      return getNextSunday9AM();
    },
  };
}

module.exports = { createWeeklyScheduler, };
