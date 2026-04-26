'use strict';

const { Router } = require('express');
const { query }  = require('../services/db');
const { cached, buildKey, TTL } = require('../services/cache');

const router = Router();

/**
 * GET /api/v1/states
 * Returns all Indian states sorted alphabetically.
 *
 * Query params: none
 * Cache: 24h (states list is essentially immutable)
 * Response time target: <5ms (cache hit) / <30ms (DB)
 */
router.get('/', async (req, res, next) => {
  try {
    const data = await cached(buildKey('states', 'all'), TTL.STATES, async () => {
      const { rows } = await query(
        `SELECT id, code, name
         FROM states
         ORDER BY name ASC`
      );
      return rows;
    });

    res.locals.cacheHit = true; // may be true on Redis hit
    res.json({
      data,
      meta: { count: data.length, cached: true },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/states/:id
 * Returns a single state with its districts count.
 */
router.get('/:id', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid state id' });

  try {
    const data = await cached(buildKey('state', id), TTL.STATES, async () => {
      const { rows } = await query(
        `SELECT s.id, s.code, s.name,
                COUNT(DISTINCT d.id) AS district_count
         FROM states s
         LEFT JOIN districts d ON d.state_id = s.id
         WHERE s.id = $1
         GROUP BY s.id, s.code, s.name`,
        [id]
      );
      return rows[0] || null;
    });

    if (!data) return res.status(404).json({ error: 'State not found' });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
