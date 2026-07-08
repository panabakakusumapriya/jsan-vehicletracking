// Central error handler. Keep last in the middleware chain.
// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('[error]', err.message);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);

  if (err.code === 11000) {
    return res.status(409).json({ error: 'Duplicate key', keyValue: err.keyValue });
  }
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ error: `Invalid ${err.path}` });
  }
  return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
};
