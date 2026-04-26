'use strict';

const { Router } = require('express');
const crypto     = require('crypto');
const { query }  = require('../services/db');
const { invalidate } = require('../services/cache');

const router = Router();

function generateApiKey() {
  // Format: igk_<8-char-prefix><48-char-secret>  → total 60 chars
  const prefix = crypto.randomBytes(6).toString('base64url').slice(0, 8);
  const secret = crypto.randomBytes(36).toString('base64url').slice(0, 48);
  const fullKey = `igk_${prefix}${secret}`;
  const hash    = crypto.createHash('sha256').update(fullKey).digest('hex');
  return { fullKey, prefix, hash };
}

/**
 * GET /api/v1/keys
 * List all API keys for current user.
 */
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, key_prefix, name, plan, is_active, last_used_at, expires_at, created_at,
              (SELECT COUNT(*) FROM usage_logs WHERE api_key_id = ak.id) AS total_requests
       FROM api_keys ak
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [req.user.sub]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/keys
 * Create a new API key.
 */
router.post('/', async (req, res, next) => {
  const { name, expires_in_days } = req.body;
  const userId = req.user.sub;
  const plan   = req.user.plan;

  try {
    // Enforce max 5 active keys per user
    const { rows: existing } = await query(
      "SELECT COUNT(*) AS cnt FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL AND is_active = TRUE",
      [userId]
    );
    if (parseInt(existing[0].cnt, 10) >= 5) {
      return res.status(400).json({ error: 'Maximum 5 active API keys allowed. Revoke an existing key first.' });
    }

    const { fullKey, prefix, hash } = generateApiKey();
    const expiresAt = expires_in_days
      ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
      : null;

    const { rows } = await query(
      `INSERT INTO api_keys (user_id, key_prefix, key_hash, name, plan, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, key_prefix, name, plan, is_active, expires_at, created_at`,
      [userId, prefix, hash, name || 'Default', plan, expiresAt]
    );

    // Return the full key ONCE - it cannot be retrieved again
    res.status(201).json({
      data: {
        ...rows[0],
        api_key: fullKey,
        warning: 'Store this key securely. It will not be shown again.',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/keys/:id
 * Revoke an API key.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE api_keys
       SET revoked_at = NOW(), is_active = FALSE
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id, key_prefix, key_hash`,
      [req.params.id, req.user.sub]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Key not found or already revoked' });

    // Bust the cache for this key
    await invalidate(`apikey:${rows[0].key_hash}`);

    res.json({ data: { message: 'API key revoked successfully', id: rows[0].id } });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/keys/:id
 * Update key name or toggle active status.
 */
router.patch('/:id', async (req, res, next) => {
  const { name, is_active } = req.body;
  try {
    const updates = [];
    const params  = [req.params.id, req.user.sub];
    let   p       = 3;
    if (name      !== undefined) { updates.push(`name = $${p++}`);      params.push(name); }
    if (is_active !== undefined) { updates.push(`is_active = $${p++}`); params.push(is_active); }

    if (!updates.length) return res.status(400).json({ error: 'No updatable fields provided' });

    const { rows } = await query(
      `UPDATE api_keys SET ${updates.join(', ')}
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id, key_prefix, name, plan, is_active, expires_at`,
      params
    );

    if (!rows[0]) return res.status(404).json({ error: 'Key not found' });
    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
