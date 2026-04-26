'use strict';

const { Router } = require('express');
const { getDB }  = require('../services/db');
const { getRedis } = require('../services/cache');

const router = Router();
const START  = Date.now();

router.get('/', async (req, res) => {
  const uptime = Math.floor((Date.now() - START) / 1000);

  let dbStatus = 'ok', dbLatency = null;
  try {
    const t = Date.now();
    await getDB().query('SELECT 1');
    dbLatency = Date.now() - t;
  } catch { dbStatus = 'error'; }

  let redisStatus = 'ok', redisLatency = null;
  try {
    const t = Date.now();
    await getRedis()?.ping();
    redisLatency = Date.now() - t;
  } catch { redisStatus = 'error'; }

  const healthy = dbStatus === 'ok';
  res.status(healthy ? 200 : 503).json({
    status:   healthy ? 'healthy' : 'degraded',
    uptime_s: uptime,
    version:  process.env.npm_package_version || '1.0.0',
    services: {
      database: { status: dbStatus, latency_ms: dbLatency },
      cache:    { status: redisStatus, latency_ms: redisLatency },
    },
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
