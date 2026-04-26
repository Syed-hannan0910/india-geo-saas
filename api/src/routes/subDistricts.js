'use strict';

const { Router } = require('express');
const { query }  = require('../services/db');
const { cached, buildKey, TTL } = require('../services/cache');

const router = Router();

/**
 * GET /api/v1/sub-districts?district_id=1
 */
router.get('/', async (req, res, next) => {
  const district_id = parseInt(req.query.district_id, 10);
  if (!req.query.district_id || isNaN(district_id)) {
    return res.status(400).json({ error: 'district_id query parameter is required (integer)' });
  }

  try {
    const data = await cached(buildKey('subdists', district_id), TTL.SUB_DISTRICTS, async () => {
      const { rows } = await query(
        `SELECT sd.id, sd.code, sd.name,
                d.id AS district_id, d.name AS district_name,
                s.id AS state_id, s.name AS state_name
         FROM sub_districts sd
         JOIN districts d ON d.id = sd.district_id
         JOIN states s    ON s.id = d.state_id
         WHERE sd.district_id = $1
         ORDER BY sd.name ASC`,
        [district_id]
      );
      return rows;
    });

    if (!data.length) {
      const { rows } = await query('SELECT id FROM districts WHERE id = $1', [district_id]);
      if (!rows.length) return res.status(404).json({ error: 'District not found' });
    }

    res.json({ data, meta: { count: data.length, district_id } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/sub-districts/:id
 */
router.get('/:id', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid sub-district id' });

  try {
    const data = await cached(buildKey('subdist', id), TTL.SUB_DISTRICTS, async () => {
      const { rows } = await query(
        `SELECT sd.id, sd.code, sd.name,
                d.id AS district_id, d.name AS district_name,
                s.id AS state_id, s.name AS state_name,
                COUNT(v.id) AS village_count
         FROM sub_districts sd
         JOIN districts d ON d.id = sd.district_id
         JOIN states s    ON s.id = d.state_id
         LEFT JOIN villages v ON v.sub_district_id = sd.id
         WHERE sd.id = $1
         GROUP BY sd.id, sd.code, sd.name, d.id, d.name, s.id, s.name`,
        [id]
      );
      return rows[0] || null;
    });

    if (!data) return res.status(404).json({ error: 'Sub-district not found' });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
