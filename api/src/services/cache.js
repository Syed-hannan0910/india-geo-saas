'use strict';

const { createClient } = require('redis');

let redis;

// TTL strategy: static geo data cached aggressively, user data less so
const TTL = {
  STATES:       86400,   // 24h  — virtually never changes
  DISTRICTS:    86400,   // 24h
  SUB_DISTRICTS: 43200,  // 12h
  VILLAGES:     21600,   //  6h
  SEARCH:        3600,   //  1h  — search results vary
  API_KEY:       3600,   //  1h  — key metadata
  QUOTA:           60,   //  1m  — usage count (tight for rate-limit accuracy)
};

const PREFIX = 'igeo:';

async function connectRedis() {
  redis = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 3000) },
  });

  redis.on('error', (err) => console.error('Redis error:', err.message));
  redis.on('reconnecting', () => console.warn('Redis reconnecting...'));

  await redis.connect();
  console.log('✅ Redis connected');
  return redis;
}

function getRedis() {
  return redis;
}

function buildKey(...parts) {
  return PREFIX + parts.join(':');
}

/**
 * Cache-aside helper.
 * Checks cache first; on miss, calls fetcher(), stores result, returns it.
 */
async function cached(key, ttl, fetcher) {
  if (!redis?.isReady) return fetcher();           // graceful degradation

  const hit = await redis.get(key);
  if (hit !== null) {
    return JSON.parse(hit);
  }

  const data = await fetcher();
  if (data !== null && data !== undefined) {
    // Fire-and-forget — don't block the response
    redis.setEx(key, ttl, JSON.stringify(data)).catch(console.error);
  }
  return data;
}

/**
 * Invalidate a cache key or pattern (uses SCAN, not KEYS, for safety).
 */
async function invalidate(pattern) {
  if (!redis?.isReady) return;
  let cursor = 0;
  do {
    const { cursor: next, keys } = await redis.scan(cursor, { MATCH: PREFIX + pattern, COUNT: 100 });
    if (keys.length) await redis.del(keys);
    cursor = next;
  } while (cursor !== 0);
}

/**
 * Sliding-window rate limit check using Redis sorted sets.
 * Returns { allowed: bool, remaining: int, resetIn: seconds }
 */
async function checkRateLimit(keyId, windowSec, maxRequests) {
  if (!redis?.isReady) return { allowed: true, remaining: maxRequests, resetIn: windowSec };

  const now    = Date.now();
  const window = now - windowSec * 1000;
  const rk     = buildKey('rl', keyId);

  const pipe = redis.multi();
  pipe.zRemRangeByScore(rk, '-inf', window);               // evict stale
  pipe.zCard(rk);                                          // current count
  pipe.zAdd(rk, [{ score: now, value: `${now}` }]);        // add current
  pipe.expire(rk, windowSec + 10);

  const results = await pipe.exec();
  const count   = results[1] ?? 0;
  const allowed = count < maxRequests;

  return {
    allowed,
    remaining: Math.max(0, maxRequests - count - 1),
    resetIn:   windowSec,
  };
}

module.exports = {
  connectRedis, getRedis, buildKey, cached, invalidate,
  checkRateLimit, TTL,
};
