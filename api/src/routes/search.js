'use strict';

const { Router } = require('express');
const { query }  = require('../services/db');
const { cached, buildKey, TTL } = require('../services/cache');

const router = Router();

/**
 * Normalize a search query the same way we normalize stored data.
 * unaccent + lowercase + collapse spaces.
 */
function normalizeQuery(q) {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * GET /api/v1/search?q=mumbai&type=village&state_id=27&limit=10
 *
 * Unified search across all geo levels with:
 *   - Trigram similarity (handles typos: "mumabi" → "Mumbai")
 *   - Prefix match boost (faster, prioritised)
 *   - Optional state/district scope filter
 *   - Result count capped by plan (search_results quota)
 *
 * Two-stage search:
 *   Stage 1: Exact prefix match (ultra-fast, covers 80% of autocomplete use-cases)
 *   Stage 2: Trigram similarity fallback for typos (similarity >= 0.3)
 */
router.get('/', async (req, res, next) => {
  const q        = (req.query.q || '').trim();
  const type     = req.query.type || 'village';   // village|sub_district|district|state|all
  const state_id    = req.query.state_id    ? parseInt(req.query.state_id,    10) : null;
  const district_id = req.query.district_id ? parseInt(req.query.district_id, 10) : null;
  const maxResults  = Math.min(
    req.apiKey?.search_results || 10,
    parseInt(req.query.limit || '10', 10)
  );

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'q must be at least 2 characters' });
  }
  if (q.length > 100) {
    return res.status(400).json({ error: 'q too long (max 100 chars)' });
  }

  const normalized = normalizeQuery(q);
  const validTypes = ['village', 'sub_district', 'district', 'state', 'all'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }

  // Cache key includes all discriminating params
  const cacheKey = buildKey('search', type, normalized, state_id || 'any', district_id || 'any', maxResults);

  try {
    const results = await cached(cacheKey, TTL.SEARCH, async () => {
      return runSearch({ normalized, type, state_id, district_id, maxResults });
    });

    res.json({
      data: results,
      meta: { query: q, type, count: results.length, limit: maxResults },
    });
  } catch (err) {
    next(err);
  }
});

async function runSearch({ normalized, type, state_id, district_id, maxResults }) {
  const results = [];

  if (type === 'village' || type === 'all') {
    const rows = await searchVillages(normalized, state_id, district_id, maxResults);
    results.push(...rows.map(r => ({ ...r, type: 'village' })));
  }

  if (type === 'sub_district' || type === 'all') {
    const rows = await searchSubDistricts(normalized, state_id, district_id, Math.ceil(maxResults / 2));
    results.push(...rows.map(r => ({ ...r, type: 'sub_district' })));
  }

  if (type === 'district' || type === 'all') {
    const rows = await searchDistricts(normalized, state_id, Math.ceil(maxResults / 3));
    results.push(...rows.map(r => ({ ...r, type: 'district' })));
  }

  if (type === 'state' || type === 'all') {
    const rows = await searchStates(normalized, Math.ceil(maxResults / 4));
    results.push(...rows.map(r => ({ ...r, type: 'state' })));
  }

  // For 'all', sort by similarity descending
  if (type === 'all') {
    results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    return results.slice(0, maxResults);
  }

  return results;
}

async function searchVillages(q, state_id, district_id, limit) {
  // Two-stage: prefix first, then trigram
  const params = [q, `${q}%`, limit];
  const stateFilter    = state_id    ? `AND vh.state_id = ${state_id}`    : '';
  const districtFilter = district_id ? `AND vh.district_id = ${district_id}` : '';

  const { rows } = await query(
    `SELECT
       village_id AS id, village_code AS code, village_name AS name,
       sub_district_name, district_name, state_name, full_address,
       CASE
         WHEN village_normalized LIKE $2 THEN 1.0
         ELSE similarity(village_normalized, $1)
       END AS similarity
     FROM village_hierarchy
     WHERE (
       village_normalized LIKE $2
       OR similarity(village_normalized, $1) > 0.25
     )
     ${stateFilter}
     ${districtFilter}
     ORDER BY
       village_normalized LIKE $2 DESC,
       similarity(village_normalized, $1) DESC,
       village_name ASC
     LIMIT $3`,
    params
  );
  return rows;
}

async function searchSubDistricts(q, state_id, district_id, limit) {
  const stateFilter    = state_id    ? `AND d.state_id = ${state_id}`    : '';
  const districtFilter = district_id ? `AND sd.district_id = ${district_id}` : '';

  const { rows } = await query(
    `SELECT
       sd.id, sd.code, sd.name,
       d.name AS district_name, s.name AS state_name,
       CASE WHEN sd.normalized_name LIKE $2 THEN 1.0
            ELSE similarity(sd.normalized_name, $1) END AS similarity
     FROM sub_districts sd
     JOIN districts d ON d.id = sd.district_id
     JOIN states s    ON s.id = d.state_id
     WHERE (sd.normalized_name LIKE $2 OR similarity(sd.normalized_name, $1) > 0.3)
     ${stateFilter} ${districtFilter}
     ORDER BY sd.normalized_name LIKE $2 DESC, similarity DESC, sd.name ASC
     LIMIT $3`,
    [q, `${q}%`, limit]
  );
  return rows;
}

async function searchDistricts(q, state_id, limit) {
  const stateFilter = state_id ? `AND d.state_id = ${state_id}` : '';
  const { rows } = await query(
    `SELECT d.id, d.code, d.name, s.name AS state_name,
            CASE WHEN d.normalized_name LIKE $2 THEN 1.0
                 ELSE similarity(d.normalized_name, $1) END AS similarity
     FROM districts d JOIN states s ON s.id = d.state_id
     WHERE (d.normalized_name LIKE $2 OR similarity(d.normalized_name, $1) > 0.35)
     ${stateFilter}
     ORDER BY d.normalized_name LIKE $2 DESC, similarity DESC, d.name ASC
     LIMIT $3`,
    [q, `${q}%`, limit]
  );
  return rows;
}

async function searchStates(q, limit) {
  const { rows } = await query(
    `SELECT id, code, name,
            CASE WHEN normalized_name LIKE $2 THEN 1.0
                 ELSE similarity(normalized_name, $1) END AS similarity
     FROM states
     WHERE (normalized_name LIKE $2 OR similarity(normalized_name, $1) > 0.4)
     ORDER BY normalized_name LIKE $2 DESC, similarity DESC, name ASC
     LIMIT $3`,
    [q, `${q}%`, limit]
  );
  return rows;
}

module.exports = router;
