'use strict';

const { query } = require('../services/db');

/**
 * Tracks API usage asynchronously - never blocks the response.
 * Updates: usage_logs (detail) + daily_usage (aggregate for quota checks).
 */
function usageTracker(req, res, next) {
  const start      = Date.now();
  const cacheHit   = res.locals.cacheHit || false;
  const keyId      = req.apiKey?.id;

  res.on('finish', () => {
    if (!keyId) return;
    const latency    = Date.now() - start;
    const statusCode = res.statusCode;
    const endpoint   = `${req.method}:${req.route?.path || req.path}`.substring(0, 100);

    // Fire-and-forget: don't await, don't block
    Promise.all([
      query(
        `INSERT INTO usage_logs (api_key_id, endpoint, method, status_code, latency_ms, cache_hit, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7::inet)`,
        [keyId, endpoint, req.method, statusCode, latency, res.locals.cacheHit || false, req.ip]
      ),
      query('SELECT increment_daily_usage($1)', [keyId]),
      // Update last_used_at on key (throttled: only if > 5 min since last)
      query(
        `UPDATE api_keys SET last_used_at = NOW()
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '5 minutes')`,
        [keyId]
      ),
    ]).catch(err => console.error('Usage tracking error:', err.message));
  });

  next();
}

module.exports = { usageTracker };
