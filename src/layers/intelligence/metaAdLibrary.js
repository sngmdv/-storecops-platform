'use strict';

/**
 * Layer 2 — Meta Ad Library Integration.
 *
 * Pulls active ads from Meta's Ad Library API for competitor
 * Facebook/Instagram pages. The Ad Library API is publicly accessible
 * with a valid access token and reveals every ad a page is currently
 * running across Facebook, Instagram, Messenger and the Audience
 * Network.
 *
 * API docs: https://developers.facebook.com/docs/marketing-api/using-the-api/ad-library-api
 *
 * Requires:
 *   - META_AD_LIBRARY_TOKEN: a long-lived access token with ads_read
 *     or business_management permission
 *   - Each competitor's Facebook Page ID
 */

const API_VERSION = 'v19.0';
const GRAPH_BASE = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 20_000;

function createMetaAdLibrary({ config, adIntelligence, },) {
  const accessToken =
    config?.metaAdLibraryToken ||
    process.env.META_AD_LIBRARY_TOKEN ||
    null;

  const apiVersion =
    config?.metaAdLibraryApiVersion ||
    process.env.META_AD_LIBRARY_API_VERSION ||
    API_VERSION;

  /**
   * Fetch active ads for a competitor's Facebook Page from the
   * Meta Ad Library API.
   *
   * @param {string} pageId — the competitor's Facebook Page ID
   * @param {string} competitorName — human-readable name for labeling
   * @param {Function} fetchFn — injectable fetch (for testing)
   * @returns {Array} normalized ad records ready for adIntelligence.ingest
   */
  async function fetchPageAds(pageId, competitorName, fetchFn = globalThis.fetch,) {
    if (!accessToken) {
      throw new Error(
        'META_AD_LIBRARY_TOKEN is not set. Get a token with ads_read permission from Meta Business Manager.',
      );
    }
    if (!pageId) {
      throw new Error('pageId is required.',);
    }

    const url = buildAdLibraryUrl(pageId,);
    const res = await fetchWithTimeout(url, fetchFn,);

    if (!res.ok) {
      const errorBody = await safeJson(res,);
      const msg = errorBody?.error?.message || `HTTP ${res.status}`;
      throw new Error(`Meta Ad Library API error: ${msg}`,);
    }

    const json = await res.json();
    const rawData = json.data || [];

    return rawData.map((ad,) => normalizeAd(ad, competitorName, pageId,),);
  }

  /**
   * Fetch ads for ALL competitors that have a meta_page_id configured.
   * Ingests results into the existing adIntelligence module.
   */
  async function scrapeAllCompetitors(store, fetchFn = globalThis.fetch,) {
    if (!accessToken) {
      return {
        status: 'not_configured',
        message: 'META_AD_LIBRARY_TOKEN not set.',
        ads_scraped: 0,
      };
    }

    const tracked = await store.trackedCompetitors.find({
      enabled: true,
    },);
    const withPageId = tracked.filter((c,) => c.meta_page_id,);

    if (withPageId.length === 0) {
      return {
        status: 'no_competitors',
        message: 'No competitors have a Meta Page ID configured.',
        ads_scraped: 0,
      };
    }

    const results = [];
    let totalAds = 0;

    for (const competitor of withPageId) {
      try {
        const ads = await fetchPageAds(
          competitor.meta_page_id,
          competitor.competitor,
          fetchFn,
        );
        totalAds += ads.length;

        // Ingest into the existing ad intelligence pipeline
        if (ads.length > 0 && competitor.store_id) {
          await adIntelligence.ingest({
            store_id: competitor.store_id,
            ads,
          },);
        }

        results.push({
          competitor: competitor.competitor,
          page_id: competitor.meta_page_id,
          ads_found: ads.length,
          status: 'success',
        },);
      } catch (error) {
        results.push({
          competitor: competitor.competitor,
          page_id: competitor.meta_page_id,
          ads_found: 0,
          status: 'failed',
          error: error.message,
        },);
      }
    }

    return {
      status: 'success',
      competitors_scraped: withPageId.length,
      ads_scraped: totalAds,
      results,
      scraped_at: new Date().toISOString(),
    };
  }

  return {
    fetchPageAds,
    scrapeAllCompetitors,
    buildAdLibraryUrl,
    normalizeAd,
    hasToken: !!accessToken,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Build the Meta Ad Library API URL.
 * Uses the ads_archive endpoint with search_page_ids to get all
 * active ads for a specific page.
 */
function buildAdLibraryUrl(pageId, { accessToken, apiVersion = API_VERSION, } = {},) {
  const token = accessToken || process.env.META_AD_LIBRARY_TOKEN || '';
  const params = new URLSearchParams({
    access_token: token,
    search_page_ids: pageId,
    ad_active_status: 'ACTIVE',
    ad_reached_countries: '["US"]',
    fields: [
      'ad_creative_bodies',
      'ad_creative_link_captions',
      'ad_creative_link_titles',
      'ad_creative_link_descriptions',
      'ad_delivery_start_time',
      'ad_snapshot_url',
      'page_name',
    ].join(',',),
    limit: '100',
  },);

  return `${GRAPH_BASE}/${apiVersion}/ads_archive?${params}`;
}

/**
 * Normalize a Meta Ad Library ad record into the format the
 * adIntelligence module expects.
 */
function normalizeAd(metaAd, competitorName, pageId,) {
  const bodies = metaAd.ad_creative_bodies || [];
  const titles = metaAd.ad_creative_link_titles || [];
  const captions = metaAd.ad_creative_link_captions || [];

  // Determine creative type from the snapshot URL or body content
  const creativeType = detectCreativeType(metaAd,);

  // Extract CTA from captions or body text
  const cta = extractCta(captions, bodies,);

  // Build a headline from the title or first body text
  const headline = titles[0] || truncate(bodies[0] || '', 80,);

  return {
    competitor: competitorName,
    platform: 'meta',
    creative_type: creativeType,
    headline,
    body: bodies[0] || null,
    cta,
    started_at: metaAd.ad_delivery_start_time || null,
    url: metaAd.ad_snapshot_url || null,
    page_id: pageId,
    page_name: metaAd.page_name || competitorName,
  };
}

function detectCreativeType(ad,) {
  const snapshot = (ad.ad_snapshot_url || '').toLowerCase();
  if (snapshot.includes('video',) || snapshot.includes('.mp4',)) return 'video';
  if (snapshot.includes('carousel',)) return 'carousel';

  // Check if body suggests video content
  const bodies = ad.ad_creative_bodies || [];
  const bodyText = bodies.join(' ',).toLowerCase();
  if (bodyText.includes('watch',) || bodyText.includes('video',)) return 'video';

  return 'static';
}

function extractCta(captions, bodies,) {
  const ctaPatterns = [
    /shop now/i,
    /learn more/i,
    /sign up/i,
    /get (?:offer|deal|discount)/i,
    /buy now/i,
    /order now/i,
    /subscribe/i,
    /download/i,
    /free shipping/i,
    /limited (?:time|offer)/i,
    /save \d+%?/i,
  ];

  // Check captions first
  for (const caption of captions) {
    for (const pattern of ctaPatterns) {
      const match = caption.match(pattern,);
      if (match) return match[0];
    }
  }

  // Then body text
  for (const body of bodies) {
    for (const pattern of ctaPatterns) {
      const match = body.match(pattern,);
      if (match) return match[0];
    }
  }

  return captions[0] || null;
}

function truncate(str, maxLen,) {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen - 3,) + '...';
}

async function fetchWithTimeout(url, fetchFn = globalThis.fetch,) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS,);
  try {
    return await fetchFn(url, { signal: controller.signal, },);
  } finally {
    clearTimeout(timer,);
  }
}

async function safeJson(res,) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

module.exports = { createMetaAdLibrary, buildAdLibraryUrl, normalizeAd, };
