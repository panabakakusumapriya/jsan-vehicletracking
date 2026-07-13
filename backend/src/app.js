const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const env = require('./config/env');

function createApp() {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "unpkg.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "unpkg.com", "cdnjs.cloudflare.com", "fonts.googleapis.com"],
        fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
        imgSrc: ["'self'", "data:", "*.tile.openstreetmap.org", "unpkg.com"],
        connectSrc: ["'self'", "ws:", "wss:"],
      },
    },
  }));
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
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
  app.use('/api/app', require('./routes/appVersion.routes'));

  // SPA fallback — serve index.html for non-API routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/health')) return next();
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(require('./middleware/error'));

  return app;
}

module.exports = { createApp };
