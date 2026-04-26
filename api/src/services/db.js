'use strict';

const { Pool } = require('pg');

let pool;

function connectDB() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,                    // max connections in pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CERT }
      : false,
  });

  pool.on('error', (err) => {
    console.error('PG pool error:', err.message);
  });

  return pool.connect().then(client => {
    console.log('✅ PostgreSQL connected');
    client.release();
    return pool;
  });
}

function getDB() {
  if (!pool) throw new Error('DB not initialized. Call connectDB() first.');
  return pool;
}

/**
 * Execute a query with optional named-parameter substitution.
 * Returns { rows, rowCount }.
 */
async function query(sql, params = []) {
  const start = Date.now();
  const result = await getDB().query(sql, params);
  const duration = Date.now() - start;

  if (duration > 200) {
    console.warn(`[SLOW QUERY] ${duration}ms: ${sql.substring(0, 120)}`);
  }
  return result;
}

/**
 * Transactional helper - pass a callback that receives a client.
 */
async function withTransaction(callback) {
  const client = await getDB().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { connectDB, getDB, query, withTransaction };
