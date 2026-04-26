'use strict';

const { Router } = require('express');
const { query }  = require('../services/db');
const { cached, buildKey, TTL } = require('../services/cache');

const router = Router();

/**
 * GET /api/v1/districts?state_id=1
 * Returns all districts for a given state.
 */
router.get('/', async (req, res, next) => {
  const state_id = parseInt(req.query.state_id, 10);
  if (!req.query.state_id || isNaN(state_id)) {
    return res.status(400).json({ error: 'state_id query parameter is required (integer)' });
  }

  try {
    const data = await cached(buildKey('districts', state_id), TTL.DISTRICTS, async () => {
      const { rows } = await query(
        `SELECT d.id, d.code, d.name, s.name AS state_name, s.id AS state_id
         FROM districts d
         JOIN states s ON s.id = d.state_id
         WHERE d.state_id = $1
         ORDER BY d.name ASC`,
        [state_id]
      );
      return rows;
    });

    if (!data.length) {
      // Verify state exists
      const { rows } = await query('SELECT id FROM states WHERE id = $1', [state_id]);
      if (!rows.length) return res.status(404).json({ error: 'State not found' });
    }

    res.json({ data, meta: { count: data.length, state_id } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/districts/:id
 */
router.get('/:id', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid district id' });

  try {
    const data = await cached(buildKey('district', id), TTL.DISTRICTS, async () => {
      const { rows } = await query(
        `SELECT d.id, d.code, d.name,
                s.id AS state_id, s.name AS state_name,
                COUNT(DISTINCT sd.id) AS sub_district_count
         FROM districts d
         JOIN states s ON s.id = d.state_id
         LEFT JOIN sub_districts sd ON sd.district_id = d.id
         WHERE d.id = $1
         GROUP BY d.id, d.code, d.name, s.id, s.name`,
        [id]
      );
      return rows[0] || null;
    });

    if (!data) return res.status(404).json({ error: 'District not found' });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
