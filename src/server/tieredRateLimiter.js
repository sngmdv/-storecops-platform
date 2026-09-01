'use strict';

/**
 * Tiered Rate Limiter — per-plan API rate limits.
 *
 * Different subscription tiers get different rate limits:
 *   free:    60 requests/minute
 *   starter: 120 requests/minute
 *   growth:  300 requests/minute
 *   premium: 600 requests/minute
 *
 * Falls back to per-IP limiting for unauthenticated requests.
 * Integrates with the existing rate limiter in security.js —
 * this adds a second layer based on the user's plan tier.
 */

const PLAN_LIMITS = {
  free: { rpm: 60,  burst: 10,  daily: 1000, },
  starter: { rpm: 120, burst: 20,  daily: 5000, },
  growth: { rpm: 300, burst: 50,  daily: 20000, },
  premium: { rpm: 600, burst: 100, daily: 100000, },
  admin: { rpm: 1000, burst: 200, daily: 500000, },
};

function createTieredRateLimiter({ windowMs = 60000, platform, } = {},) {
  const hits = new Map();
  const dailyHits = new Map();

  // Evict stale entries.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps,] of hits) {
      const fresh = timestamps.filter((at,) => at > cutoff,);
      if (fresh.length === 0) hits.delete(key,);
      else hits.set(key, fresh,);
    }
    // Daily cleanup.
    const dailyCutoff = new Date();
    dailyCutoff.setDate(dailyCutoff.getDate() - 1,);
    const dailyCutoffStr = dailyCutoff.toISOString();
    for (const [key, data,] of dailyHits) {
      if (data.date < dailyCutoffStr) dailyHits.delete(key,);
    }
  }, windowMs,);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  function getLimits(req,) {
    // Determine the user's plan tier.
    const plan = req.authUser?.plan || req.user?.plan || 'free';
    const isAdmin = req.authUser?.role === 'admin' || req.authUser?.email === 'master@platform';
    const tier = isAdmin ? 'admin' : plan;
    return PLAN_LIMITS[tier] || PLAN_LIMITS.free;
  }

  function getKey(req,) {
    return req.authUser?.email || req.get('X-API-Key',) || req.ip || 'anonymous';
  }

  return {
    PLAN_LIMITS,

    /**
     * Express middleware — enforce per-plan rate limits.
     */
    middleware(req, res, next,) {
      const key = getKey(req,);
      const limits = getLimits(req,);
      const now = Date.now();

      // Per-minute rate limit.
      const windowStart = now - windowMs;
      const timestamps = (hits.get(key,) || []).filter((at,) => at > windowStart,);
      timestamps.push(now,);
      hits.set(key, timestamps,);

      // Daily limit tracking.
      const today = new Date().toISOString().split('T',)[0];
      const dailyKey = `${key}:${today}`;
      const dailyData = dailyHits.get(dailyKey,) || { count: 0, date: today, };
      dailyData.count++;
      dailyHits.set(dailyKey, dailyData,);

      // Set response headers.
      res.set('X-RateLimit-Limit', String(limits.rpm,),);
      res.set('X-RateLimit-Remaining', String(Math.max(0, limits.rpm - timestamps.length,),),);
      res.set('X-RateLimit-Daily-Limit', String(limits.daily,),);
      res.set('X-RateLimit-Daily-Remaining', String(Math.max(0, limits.daily - dailyData.count,),),);
      res.set('X-RateLimit-Plan', req.authUser?.plan || 'free',);

      // Check per-minute limit.
      if (timestamps.length > limits.rpm) {
        const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000,);
        res.set('Retry-After', String(retryAfter,),);
        return res.status(429,).json({
          error: 'Rate limit exceeded for your plan.',
          plan: req.authUser?.plan || 'free',
          limit: limits.rpm,
          retry_after_seconds: retryAfter,
          upgrade_hint: limits.rpm < PLAN_LIMITS.premium.rpm
            ? 'Upgrade your plan for higher rate limits.'
            : null,
        },);
      }

      // Check daily limit.
      if (dailyData.count > limits.daily) {
        return res.status(429,).json({
          error: 'Daily API limit exceeded.',
          plan: req.authUser?.plan || 'free',
          daily_limit: limits.daily,
          retry_after_seconds: 86400 - (Date.now() % 86400000) / 1000,
          upgrade_hint: 'Upgrade your plan for higher daily limits.',
        },);
      }

      return next();
    },

    /**
     * Get current usage for a user (for dashboard display).
     */
    getUsage(req,) {
      const key = getKey(req,);
      const limits = getLimits(req,);
      const now = Date.now();
      const windowStart = now - windowMs;
      const timestamps = (hits.get(key,) || []).filter((at,) => at > windowStart,);
      const today = new Date().toISOString().split('T',)[0];
      const dailyData = dailyHits.get(`${key}:${today}`,) || { count: 0, };

      return {
        plan: req.authUser?.plan || 'free',
        per_minute: {
          used: timestamps.length,
          limit: limits.rpm,
          remaining: Math.max(0, limits.rpm - timestamps.length,),
        },
        daily: {
          used: dailyData.count,
          limit: limits.daily,
          remaining: Math.max(0, limits.daily - dailyData.count,),
        },
      };
    },
  };
}

module.exports = { createTieredRateLimiter, PLAN_LIMITS, };
