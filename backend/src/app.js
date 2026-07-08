const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const env = require('./config/env');

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: '5mb' })); // offline batches can be large
  app.use(morgan('dev'));

  app.get('/health', (req, res) =>
    res.json({ ok: true, service: 'jsan-tracking-api', time: new Date().toISOString() })
  );

  app.use('/api/auth', require('./routes/auth.routes'));
  app.use('/api/users', require('./routes/user.routes'));
  app.use('/api/vehicles', require('./routes/vehicle.routes'));
  app.use('/api/trips', require('./routes/trip.routes'));
  app.use('/api/tracking', require('./routes/tracking.routes'));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(require('./middleware/error'));

  return app;
}

module.exports = { createApp };
