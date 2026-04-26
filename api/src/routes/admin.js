'use strict';

const { Router } = require('express');
const { query }  = require('../services/db');

const router = Router();

/** GET /api/v1/admin/stats — Platform overview */
router.get('/stats', async (req, res, next) => {
  try {
    const [users, keys, usage, geo, latency] = await Promise.all([
      query(`SELECT
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE plan = 'free')      AS free,
               COUNT(*) FILTER (WHERE plan = 'premium')   AS premium,
               COUNT(*) FILTER (WHERE plan = 'pro')       AS pro,
               COUNT(*) FILTER (WHERE plan = 'unlimited') AS unlimited,
               COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24h') AS new_24h
             FROM users WHERE role = 'client'`),
      query(`SELECT
               COUNT(*) FILTER (WHERE is_active = TRUE AND revoked_at IS NULL) AS active,
               COUNT(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked
             FROM api_keys`),
      query(`SELECT
               SUM(request_count)  AS total_today,
               COUNT(DISTINCT api_key_id) AS active_keys_today
             FROM daily_usage WHERE usage_date = CURRENT_DATE`),
      query(`SELECT
               (SELECT COUNT(*) FROM states)        AS states,
               (SELECT COUNT(*) FROM districts)     AS districts,
               (SELECT COUNT(*) FROM sub_districts) AS sub_districts,
               (SELECT COUNT(*) FROM villages)      AS villages`),
      query(`SELECT
               AVG(latency_ms)::int          AS avg_ms,
               PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95_ms,
               PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms)::int AS p99_ms,
               SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) * 100 AS cache_hit_pct
             FROM usage_logs WHERE created_at >= NOW() - INTERVAL '1 hour'`),
    ]);

    res.json({
      data: {
        users:   users.rows[0],
        keys:    keys.rows[0],
        usage:   usage.rows[0],
        geo:     geo.rows[0],
        latency: latency.rows[0],
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/admin/users?page=1&limit=20&plan=free&search= */
router.get('/users', async (req, res, next) => {
  const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit  = Math.min(100, parseInt(req.query.limit || '20', 10));
  const offset = (page - 1) * limit;
  const plan   = req.query.plan;
  const search = req.query.search?.trim();

  try {
    const conditions = ["u.role = 'client'"];
    const params     = [];
    let p = 1;

    if (plan)   { conditions.push(`u.plan = $${p++}`);                    params.push(plan); }
    if (search) { conditions.push(`(u.email ILIKE $${p} OR u.full_name ILIKE $${p} OR u.company_name ILIKE $${p})`); params.push(`%${search}%`); p++; }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [usersRes, countRes] = await Promise.all([
      query(
        `SELECT u.id, u.email, u.full_name, u.company_name, u.plan, u.is_active,
                u.is_verified, u.created_at,
                COUNT(ak.id) FILTER (WHERE ak.revoked_at IS NULL) AS active_keys,
                COALESCE(SUM(du.request_count), 0) AS requests_today
         FROM users u
         LEFT JOIN api_keys  ak ON ak.user_id    = u.id
         LEFT JOIN daily_usage du ON du.api_key_id = ak.id AND du.usage_date = CURRENT_DATE
         ${where}
         GROUP BY u.id
         ORDER BY u.created_at DESC
         LIMIT $${p} OFFSET $${p+1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) AS total FROM users u ${where}`, params),
    ]);

    res.json({
      data: usersRes.rows,
      meta: { total: parseInt(countRes.rows[0].total, 10), page, limit },
    });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/admin/users/:id — Update plan or active status */
router.patch('/users/:id', async (req, res, next) => {
  const { plan, is_active } = req.body;
  const validPlans = ['free', 'premium', 'pro', 'unlimited'];

  try {
    const updates = [];
    const params  = [req.params.id];
    let   p       = 2;

    if (plan !== undefined) {
      if (!validPlans.includes(plan)) return res.status(400).json({ error: `plan must be one of: ${validPlans.join(', ')}` });
      updates.push(`plan = $${p++}`); params.push(plan);
      // Also update all active keys to new plan
      await query('UPDATE api_keys SET plan = $1 WHERE user_id = $2 AND revoked_at IS NULL', [plan, req.params.id]);
    }
    if (is_active !== undefined) { updates.push(`is_active = $${p++}`); params.push(is_active); }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    updates.push('updated_at = NOW()');

    const { rows } = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $1 RETURNING id, email, plan, is_active`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/admin/usage/realtime — Live request rate (last 5 min) */
router.get('/usage/realtime', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         DATE_TRUNC('minute', created_at)  AS minute,
         COUNT(*)                          AS requests,
         AVG(latency_ms)::int             AS avg_ms,
         SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) AS cache_hits,
         SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS errors
       FROM usage_logs
       WHERE created_at >= NOW() - INTERVAL '5 minutes'
       GROUP BY 1 ORDER BY 1 ASC`
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/admin/geo/coverage — Data coverage summary per state */
router.get('/geo/coverage', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         s.id, s.code, s.name AS state,
         COUNT(DISTINCT d.id)   AS districts,
         COUNT(DISTINCT sd.id)  AS sub_districts,
         COUNT(DISTINCT v.id)   AS villages
       FROM states s
       LEFT JOIN districts d     ON d.state_id    = s.id
       LEFT JOIN sub_districts sd ON sd.district_id = d.id
       LEFT JOIN villages v       ON v.sub_district_id = sd.id
       GROUP BY s.id, s.code, s.name
       ORDER BY villages DESC`
    );
    res.json({ data: rows, meta: { total_states: rows.length } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
