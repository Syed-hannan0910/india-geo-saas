'use strict';

const { Router } = require('express');
const { query }  = require('../services/db');
const { cached, buildKey, TTL } = require('../services/cache');

const router = Router();

/**
 * GET /api/v1/villages?sub_district_id=1&page=1&limit=200
 *
 * Returns paginated village list for a sub-district.
 * Served from materialized view (village_hierarchy) for single-table speed.
 *
 * Cache: 6h — village data changes only on schema refresh
 */
router.get('/', async (req, res, next) => {
  const sd_id = parseInt(req.query.sub_district_id, 10);
  if (!req.query.sub_district_id || isNaN(sd_id)) {
    return res.status(400).json({ error: 'sub_district_id query parameter is required (integer)' });
  }

  const page  = Math.max(1, parseInt(req.query.page  || '1',   10));
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '200', 10)));
  const offset = (page - 1) * limit;

  try {
    const cacheKey = buildKey('villages', sd_id, page, limit);
    const data = await cached(cacheKey, TTL.VILLAGES, async () => {
      const [listRes, countRes] = await Promise.all([
        query(
          `SELECT
             village_id AS id, village_code AS code, village_name AS name,
             sub_district_name, district_name, state_name, full_address
           FROM village_hierarchy
           WHERE sub_district_id = $1
           ORDER BY village_name ASC
           LIMIT $2 OFFSET $3`,
          [sd_id, limit, offset]
        ),
        query(
          'SELECT COUNT(*) AS total FROM village_hierarchy WHERE sub_district_id = $1',
          [sd_id]
        ),
      ]);

      const total = parseInt(countRes.rows[0]?.total || '0', 10);
      return {
        rows:  listRes.rows,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      };
    });

    if (!data.rows.length && page === 1) {
      const { rows } = await query('SELECT id FROM sub_districts WHERE id = $1', [sd_id]);
      if (!rows.length) return res.status(404).json({ error: 'Sub-district not found' });
    }

    res.json({
      data: data.rows,
      meta: {
        sub_district_id: sd_id,
        total:   data.total,
        page:    data.page,
        limit:   data.limit,
        pages:   data.pages,
        count:   data.rows.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/villages/:id
 * Returns full hierarchy for a single village.
 */
router.get('/:id', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid village id' });

  try {
    const data = await cached(buildKey('village', id), TTL.VILLAGES, async () => {
      const { rows } = await query(
        `SELECT
           village_id AS id, village_code AS code, village_name AS name,
           sub_district_id, sub_district_code, sub_district_name,
           district_id, district_code, district_name,
           state_id, state_code, state_name, full_address
         FROM village_hierarchy WHERE village_id = $1`,
        [id]
      );
      return rows[0] || null;
    });

    if (!data) return res.status(404).json({ error: 'Village not found' });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/villages/code/:code
 * Lookup by MDDS PLCN code (6-digit Census code).
 */
router.get('/code/:code', async (req, res, next) => {
  const code = String(req.params.code).padStart(6, '0');

  try {
    const data = await cached(buildKey('village_code', code), TTL.VILLAGES, async () => {
      const { rows } = await query(
        `SELECT
           village_id AS id, village_code AS code, village_name AS name,
           sub_district_id, sub_district_code, sub_district_name,
           district_id, district_code, district_name,
           state_id, state_code, state_name, full_address
         FROM village_hierarchy WHERE village_code = $1`,
        [code]
      );
      return rows;
    });

    res.json({ data, meta: { count: data.length, code } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
