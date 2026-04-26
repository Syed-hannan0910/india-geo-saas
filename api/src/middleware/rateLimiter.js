'use strict';

const { checkRateLimit, buildKey, getRedis } = require('../services/cache');
const { query } = require('../services/db');

/**
 * Dual-layer rate limiter:
 *   Layer 1: Per-minute RPM limit  (Redis sliding window)
 *   Layer 2: Per-day quota check   (Redis counter, DB fallback)
 *
 * Returns standard rate limit headers so clients can self-throttle.
 */
async function rateLimiter(req, res, next) {
  const key    = req.apiKey;
  const keyId  = key.id;
  const plan   = key.plan;
  const rpm    = key.rpm;
  const daily  = key.daily_requests;  // -1 = unlimited

  try {
    // ── Layer 1: RPM sliding window ────────────────────────────────────
    const rpm_check = await checkRateLimit(`rpm:${keyId}`, 60, rpm);

    res.set({
      'X-RateLimit-Limit-Minute':     rpm,
      'X-RateLimit-Remaining-Minute': rpm_check.remaining,
      'X-RateLimit-Reset-Minute':     Math.floor(Date.now() / 1000) + rpm_check.resetIn,
    });

    if (!rpm_check.allowed) {
      return res.status(429).json({
        error:      'Rate limit exceeded (per-minute)',
        plan,
        rpm_limit:  rpm,
        reset_in:   rpm_check.resetIn,
        upgrade_url:'https://india-geo.io/pricing',
      });
    }

    // ── Layer 2: Daily quota ───────────────────────────────────────────
    if (daily !== -1) {
      const redis   = getRedis();
      const dayKey  = buildKey('daily', keyId, new Date().toISOString().slice(0, 10));
      let todayCount = 0;

      if (redis?.isReady) {
        const val = await redis.get(dayKey);
        todayCount = val ? parseInt(val, 10) : await fetchDailyCount(keyId);
        await redis.setEx(dayKey, 90, String(todayCount + 1)); // 90s TTL, refreshed on each req
      } else {
        todayCount = await fetchDailyCount(keyId);
      }

      res.set({
        'X-RateLimit-Limit-Day':     daily,
        'X-RateLimit-Remaining-Day': Math.max(0, daily - todayCount - 1),
      });

      if (todayCount >= daily) {
        return res.status(429).json({
          error:       'Daily quota exceeded',
          plan,
          daily_limit: daily,
          upgrade_url: 'https://india-geo.io/pricing',
        });
      }
    } else {
      res.set({ 'X-RateLimit-Limit-Day': 'unlimited' });
    }

    next();
  } catch (err) {
    // Never block a request due to rate limit infra failure
    console.error('Rate limiter error (bypassing):', err.message);
    next();
  }
}

async function fetchDailyCount(keyId) {
  const { rows } = await query(
    'SELECT COALESCE(request_count, 0) AS cnt FROM daily_usage WHERE api_key_id = $1 AND usage_date = CURRENT_DATE',
    [keyId]
  );
  return rows[0]?.cnt ?? 0;
}

module.exports = { rateLimiter };
