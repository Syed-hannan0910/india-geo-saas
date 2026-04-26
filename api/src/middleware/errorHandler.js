'use strict';

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500;
  const isDev      = process.env.NODE_ENV !== 'production';

  if (statusCode >= 500) {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err);
  }

  res.status(statusCode).json({
    error:   err.message || 'Internal server error',
    code:    err.code,
    ...(isDev && { stack: err.stack }),
  });
}

module.exports = { errorHandler };
