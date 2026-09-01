'use strict';

/**
 * Layer 2 — Seasonal & Event Opportunity Alerts.
 *
 * A built-in retail event calendar (holidays, shopping moments,
 * cultural events) cross-referenced with the store's categories.
 * Surfaces "prepare a campaign now" alerts ahead of each moment so
 * clients never miss a revenue window.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rolling retail calendar. `categories` hint which stores it matters to. */
const RETAIL_CALENDAR = [
  { name: 'New Year Sale', month: 1, day: 1, categories: ['all',], prep_days: 14, },
  { name: 'Valentine\'s Day', month: 2, day: 14, categories: ['gifts', 'jewelry', 'fashion', 'beauty', 'all',], prep_days: 21, },
  { name: 'Holi', month: 3, day: 14, categories: ['fashion', 'home', 'gifts', 'all',], prep_days: 14, },
  { name: 'Summer Kickoff', month: 5, day: 1, categories: ['outdoor', 'fashion', 'electronics', 'all',], prep_days: 14, },
  { name: 'Father\'s Day', month: 6, day: 15, categories: ['gifts', 'electronics', 'fashion', 'all',], prep_days: 14, },
  { name: 'Back to School', month: 8, day: 1, categories: ['stationery', 'electronics', 'fashion', 'all',], prep_days: 21, },
  { name: 'Independence Day (IN)', month: 8, day: 15, categories: ['all',], prep_days: 10, },
  { name: 'Festive / Diwali Season', month: 10, day: 20, categories: ['gifts', 'electronics', 'home', 'fashion', 'all',], prep_days: 30, },
  { name: 'Black Friday', month: 11, day: 28, categories: ['all',], prep_days: 30, },
  { name: 'Cyber Monday', month: 12, day: 1, categories: ['electronics', 'all',], prep_days: 7, },
  { name: 'Christmas / Year-end Gifting', month: 12, day: 25, categories: ['gifts', 'toys', 'fashion', 'all',], prep_days: 21, },
];

function nextOccurrence(event, from = new Date(),) {
  let candidate = new Date(from.getFullYear(), event.month - 1, event.day,);
  if (candidate < from) candidate = new Date(from.getFullYear() + 1, event.month - 1, event.day,);
  return candidate;
}

function createSeasonalAlerts() {
  return {
    RETAIL_CALENDAR,

    /**
     * Upcoming revenue moments within `horizonDays`, with when prep
     * should start and a ready campaign angle.
     *
     * categories: the store's categories (matched against the event).
     */
    upcoming({ store_id, categories = ['all',], horizonDays = 45, now = new Date(), } = {},) {
      const opportunities = [];

      for (const event of RETAIL_CALENDAR) {
        const relevant =
          event.categories.includes('all',) ||
          categories.some((category,) => event.categories.includes(String(category,).toLowerCase(),),);
        if (!relevant) continue;

        const date = nextOccurrence(event, now,);
        const daysUntil = Math.ceil((date.getTime() - now.getTime()) / DAY_MS,);
        if (daysUntil > horizonDays) continue;

        const prepStart = new Date(date.getTime() - event.prep_days * DAY_MS,);
        const prepStatus = prepStart <= now ? 'START_NOW' : 'SCHEDULED';

        opportunities.push({
          event: event.name,
          date: date.toISOString().slice(0, 10,),
          days_until: daysUntil,
          prep_start: prepStart.toISOString().slice(0, 10,),
          prep_status: prepStatus,
          urgency: daysUntil <= 7 ? 'CRITICAL' : daysUntil <= 14 ? 'HIGH' : 'MEDIUM',
          campaign_angle: `Launch a ${event.name} campaign: themed bundles, countdown urgency and a limited ${event.name.toLowerCase()} offer.`,
        },);
      }

      opportunities.sort((a, b,) => a.days_until - b.days_until,);

      return {
        store_id: store_id || null,
        horizon_days: horizonDays,
        opportunities,
        scanned_at: now.toISOString(),
      };
    },
  };
}

module.exports = { createSeasonalAlerts, RETAIL_CALENDAR, };
