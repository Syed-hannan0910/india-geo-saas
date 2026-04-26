'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_REFRESH = process.env.JWT_REFRESH_SECRET;

function jwtAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function signTokens(user) {
  const payload = { sub: user.id, email: user.email, role: user.role, plan: user.plan };
  const access  = jwt.sign(payload, JWT_SECRET,  { expiresIn: '15m' });
  const refresh = jwt.sign({ sub: user.id }, JWT_REFRESH, { expiresIn: '30d' });
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 900 };
}

module.exports = jwtAuth;
module.exports.adminOnly  = adminOnly;
module.exports.signTokens = signTokens;
