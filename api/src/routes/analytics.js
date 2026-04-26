'use strict';

const { Router } = require('express');
const { query }  = require('../services/db');

const router = Router();

/**
 * GET /api/v1/analytics/overview
 * Usage summary for the current user across all their API keys.
 */
router.get('/overview', async (req, res, next) => {
  const userId = req.user.sub;
  try {
    const [usageRes, keysRes, planRes] = await Promise.all([
      query(
        `SELECT
           COALESCE(SUM(du.request_count), 0)                     AS total_requests_today,
           COALESCE(SUM(CASE WHEN du.usage_date >= NOW() - INTERVAL '7 days'
                        THEN du.request_count ELSE 0 END), 0)     AS total_requests_7d,
           COALESCE(SUM(CASE WHEN du.usage_date >= NOW() - INTERVAL '30 days'
                        THEN du.request_count ELSE 0 END), 0)     AS total_requests_30d
         FROM api_keys ak
         LEFT JOIN daily_usage du ON du.api_key_id = ak.id
         WHERE ak.user_id = $1 AND ak.revoked_at IS NULL`,
        [userId]
      ),
      query(
        `SELECT COUNT(*) FILTER (WHERE is_active = TRUE AND revoked_at IS NULL) AS active_keys,
                COUNT(*) FILTER (WHERE revoked_at IS NOT NULL)                  AS revoked_keys
         FROM api_keys WHERE user_id = $1`,
        [userId]
      ),
      query(
        'SELECT plan, email, full_name, company_name FROM users WHERE id = $1',
        [userId]
      ),
    ]);

    const quota = await query(
      'SELECT daily_requests, rpm, search_results, price_monthly FROM plan_quotas WHERE plan = $1',
      [planRes.rows[0]?.plan || 'free']
    );

    res.json({
      data: {
        user:         planRes.rows[0],
        quota:        quota.rows[0],
        usage:        usageRes.rows[0],
        keys:         keysRes.rows[0],
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/analytics/timeseries?key_id=&days=30
 * Daily request counts for chart rendering.
 */
router.get('/timeseries', async (req, res, next) => {
  const userId = req.user.sub;
  const keyId  = req.query.key_id || null;
  const days   = Math.min(90, Math.max(7, parseInt(req.query.days || '30', 10)));

  try {
    const keyFilter = keyId ? 'AND ak.id = $3::uuid' : '';
    const params    = keyId ? [userId, days, keyId] : [userId, days];

    const { rows } = await query(
      `SELECT
         du.usage_date AS date,
         SUM(du.request_count) AS requests
       FROM daily_usage du
       JOIN api_keys ak ON ak.id = du.api_key_id
       WHERE ak.user_id = $1
         AND du.usage_date >= CURRENT_DATE - ($2 || ' days')::interval
         ${keyFilter}
       GROUP BY du.usage_date
       ORDER BY du.usage_date ASC`,
      params
    );

    res.json({ data: rows, meta: { days, key_id: keyId } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/analytics/endpoints?days=7
 * Top endpoint usage breakdown.
 */
router.get('/endpoints', async (req, res, next) => {
  const userId = req.user.sub;
  const days   = Math.min(30, Math.max(1, parseInt(req.query.days || '7', 10)));

  try {
    const { rows } = await query(
      `SELECT
         ul.endpoint,
         COUNT(*)                                  AS requests,
         AVG(ul.latency_ms)::int                  AS avg_latency_ms,
         PERCENTILE_CONT(0.95) WITHIN GROUP
           (ORDER BY ul.latency_ms)::int           AS p95_latency_ms,
         SUM(CASE WHEN ul.cache_hit THEN 1 ELSE 0 END)::float
           / NULLIF(COUNT(*), 0) * 100             AS cache_hit_pct,
         SUM(CASE WHEN ul.status_code >= 400 THEN 1 ELSE 0 END) AS errors
       FROM usage_logs ul
       JOIN api_keys ak ON ak.id = ul.api_key_id
       WHERE ak.user_id = $1
         AND ul.created_at >= NOW() - ($2 || ' days')::interval
       GROUP BY ul.endpoint
       ORDER BY requests DESC
       LIMIT 20`,
      [userId, days]
    );

    res.json({ data: rows, meta: { days } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
