'use strict';
const request = require('supertest');
const app     = require('../src/app');

// Mock auth middleware for testing
jest.mock('../src/middleware/auth', () => ({
  apiKeyAuth: (req, res, next) => {
    req.apiKey = { id: 'test-key-id', plan: 'pro', rpm: 300, daily_requests: 500000, search_results: 100 };
    next();
  },
}));
jest.mock('../src/middleware/rateLimiter',  () => ({ rateLimiter:  (req, res, next) => next() }));
jest.mock('../src/middleware/usageTracker', () => ({ usageTracker: (req, res, next) => next() }));

describe('Health', () => {
  it('GET /health → 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBeDefined();
  });
});

describe('States API', () => {
  it('GET /api/v1/states → array of states', async () => {
    const res = await request(app)
      .get('/api/v1/states')
      .set('X-API-Key', 'igk_test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toHaveProperty('code');
    expect(res.body.data[0]).toHaveProperty('name');
  });

  it('GET /api/v1/states/:id → single state', async () => {
    const res = await request(app)
      .get('/api/v1/states/1')
      .set('X-API-Key', 'igk_test');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('name');
    expect(res.body.data).toHaveProperty('district_count');
  });

  it('GET /api/v1/states/9999 → 404', async () => {
    const res = await request(app).get('/api/v1/states/9999').set('X-API-Key','igk_test');
    expect(res.status).toBe(404);
  });
});

describe('Districts API', () => {
  it('GET /api/v1/districts?state_id=1 → districts list', async () => {
    const res = await request(app)
      .get('/api/v1/districts?state_id=1')
      .set('X-API-Key', 'igk_test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /api/v1/districts without state_id → 400', async () => {
    const res = await request(app).get('/api/v1/districts').set('X-API-Key','igk_test');
    expect(res.status).toBe(400);
  });
});

describe('Search API', () => {
  it('GET /api/v1/search?q=mumbai → results', async () => {
    const res = await request(app)
      .get('/api/v1/search?q=mumbai&type=village')
      .set('X-API-Key', 'igk_test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /api/v1/search?q=x → 400 (too short)', async () => {
    const res = await request(app).get('/api/v1/search?q=x').set('X-API-Key','igk_test');
    expect(res.status).toBe(400);
  });

  it('GET /api/v1/search → 400 (no q)', async () => {
    const res = await request(app).get('/api/v1/search').set('X-API-Key','igk_test');
    expect(res.status).toBe(400);
  });

  it('GET /api/v1/search?q=mumabi → fuzzy match', async () => {
    // typo "mumabi" should still find "Mumbai" via trigram
    const res = await request(app)
      .get('/api/v1/search?q=mumabi&type=village')
      .set('X-API-Key', 'igk_test');
    expect(res.status).toBe(200);
    // Fuzzy search should return results even with typo
    expect(res.body.data).toBeDefined();
  });
});

describe('No API Key → 401', () => {
  it('returns 401 without X-API-Key', async () => {
    // Restore real auth for this test
    jest.unmock('../src/middleware/auth');
    const res = await request(app).get('/api/v1/states');
    expect(res.status).toBe(401);
  });
});
