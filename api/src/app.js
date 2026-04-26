require('dotenv').config();
'use strict';
const { Pool } = require('pg');
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const morgan      = require('morgan');

const { connectDB }       = require('./services/db');
const { connectRedis }    = require('./services/cache');
const { apiKeyAuth }      = require('./middleware/auth');
const { rateLimiter }     = require('./middleware/rateLimiter');
const { usageTracker }    = require('./middleware/usageTracker');
const { errorHandler }    = require('./middleware/errorHandler');

const statesRouter       = require('./routes/states');
const districtsRouter    = require('./routes/districts');
const subDistrictsRouter = require('./routes/subDistricts');
const villagesRouter     = require('./routes/villages');
const searchRouter       = require('./routes/search');
const authRouter         = require('./routes/auth');
const adminRouter        = require('./routes/admin');
const keysRouter         = require('./routes/keys');
const analyticsRouter    = require('./routes/analytics');
const healthRouter       = require('./routes/health');

const app = express();

const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000, // Wait up to 10 seconds to connect
      idleTimeoutMillis: 30000,      // Keep idle connections open for 30s
    });
// ─── Security & Middleware ────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(compression());
app.use(express.json({ limit: '10kb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── Health (no auth) ────────────────────────────────────────────────────────
app.use('/health', healthRouter);

// ─── Public Auth Routes ───────────────────────────────────────────────────────
app.use('/api/v1/auth', authRouter);

// ─── Protected API Routes ────────────────────────────────────────────────────
// All geo endpoints require a valid API key
const apiRouter = express.Router();
apiRouter.use(apiKeyAuth);
apiRouter.use(rateLimiter);
apiRouter.use(usageTracker);

apiRouter.use('/states',        statesRouter);
apiRouter.use('/districts',     districtsRouter);
apiRouter.use('/sub-districts', subDistrictsRouter);
apiRouter.use('/villages',      villagesRouter);
apiRouter.use('/search',        searchRouter);

app.use('/api/v1', apiRouter);

// ─── Client Portal Routes (JWT auth) ──────────────────────────────────────
app.use('/api/v1/keys',      require('./middleware/jwtAuth'), keysRouter);
app.use('/api/v1/analytics', require('./middleware/jwtAuth'), analyticsRouter);

// ─── Admin Routes ─────────────────────────────────────────────────────────
app.use('/api/v1/admin', require('./middleware/jwtAuth'), require('./middleware/adminOnly'), adminRouter);

// ─── 404 & Error Handler ──────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
app.use(errorHandler);

// ─── Boot ─────────────────────────────────────────────────────────────────
async function start() {
  await connectDB();
  await connectRedis();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 India Geo API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

module.exports = app; // for testing
