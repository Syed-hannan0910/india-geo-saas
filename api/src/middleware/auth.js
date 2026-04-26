'use strict';

const crypto = require('crypto');
const { query } = require('../services/db');
const { cached, buildKey, TTL } = require('../services/cache');

/**
 * Authenticates requests via X-API-Key header.
 * Key format: igk_<prefix8><secret48>   → total 60 chars
 *
 * Lookup strategy:
 *   1. Hash full key with SHA-256
 *   2. Cache check (1h TTL)
 *   3. DB lookup by hash if cache miss
 *   4. Attach plan + user info to req for downstream middleware
 */
async function apiKeyAuth(req, res, next) {
  const rawKey = req.headers['x-api-key'];

  if (!rawKey) {
    return res.status(401).json({
      error: 'Missing API key',
      hint:  'Include X-API-Key header. Get your key at https://india-geo.io/portal',
    });
  }

  if (!rawKey.startsWith('igk_') || rawKey.length < 20) {
    return res.status(401).json({ error: 'Invalid API key format' });
  }

  const keyHash   = crypto.createHash('sha256').update(rawKey).digest('hex');
  const cacheKey  = buildKey('apikey', keyHash);

  try {
    const keyData = await cached(cacheKey, TTL.API_KEY, async () => {
      const { rows } = await query(
        `SELECT
           ak.id, ak.user_id, ak.plan, ak.is_active, ak.expires_at, ak.key_prefix,
           u.email, u.is_active AS user_active, u.role,
           pq.daily_requests, pq.rpm, pq.search_results
         FROM api_keys ak
         JOIN users u        ON u.id   = ak.user_id
         JOIN plan_quotas pq ON pq.plan = ak.plan
         WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
        [keyHash]
      );
      return rows[0] || null;
    });

    if (!keyData) {
      return res.status(401).json({ error: 'Invalid or revoked API key' });
    }

    if (!keyData.is_active || !keyData.user_active) {
      return res.status(403).json({ error: 'API key or account is suspended' });
    }

    if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
      return res.status(403).json({ error: 'API key expired', expires_at: keyData.expires_at });
    }

    // Attach to request for downstream use
    req.apiKey = keyData;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { apiKeyAuth };
