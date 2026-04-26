'use strict';

const { Router }  = require('express');
const bcrypt      = require('bcrypt');
const jwt         = require('jsonwebtoken');
const { query }   = require('../services/db');
const { signTokens } = require('../middleware/jwtAuth');

const router = Router();
const SALT_ROUNDS = 12;

/**
 * POST /api/v1/auth/register
 */
router.post('/register', async (req, res, next) => {
  const { email, password, full_name, company_name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    const { rows: existing } = await query(
      'SELECT id FROM users WHERE email = $1', [email.toLowerCase()]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, full_name, company_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, full_name, company_name, role, plan, created_at`,
      [email.toLowerCase(), hash, full_name || null, company_name || null]
    );

    const user   = rows[0];
    const tokens = signTokens(user);

    res.status(201).json({ data: { user, ...tokens } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/auth/login
 */
router.post('/login', async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.plan,
              u.is_active, u.is_verified, u.company_name
       FROM users u WHERE u.email = $1`,
      [email.toLowerCase()]
    );

    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }

    const { password_hash, ...safeUser } = user;
    const tokens = signTokens(safeUser);
    res.json({ data: { user: safeUser, ...tokens } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/auth/refresh
 */
router.post('/refresh', async (req, res, next) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

  try {
    const payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    const { rows } = await query(
      'SELECT id, email, role, plan, is_active FROM users WHERE id = $1',
      [payload.sub]
    );
    const user = rows[0];
    if (!user || !user.is_active) return res.status(401).json({ error: 'User not found or suspended' });

    const tokens = signTokens(user);
    res.json({ data: tokens });
  } catch (err) {
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    next(err);
  }
});

/**
 * GET /api/v1/auth/me  (JWT protected inline)
 */
router.get('/me', require('../middleware/jwtAuth'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, email, full_name, company_name, role, plan, is_verified, created_at
       FROM users WHERE id = $1`,
      [req.user.sub]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
