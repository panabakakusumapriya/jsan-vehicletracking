const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const env = require('./config/env');

function createApp() {
  const app = express();

  app.use(helmet({
    // This API is consumed cross-origin (the panel is deployed on Vercel, the API on
    // Railway). Helmet's default CORP of `same-origin` is meant for a site serving its own
    // assets and can block cross-origin delivery of responses; `cross-origin` is the correct
    // setting for a public API. CORS itself still decides who is allowed in.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "unpkg.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "unpkg.com", "cdnjs.cloudflare.com", "fonts.googleapis.com"],
        fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
        // cf.bstatic.com serves Booking.com property photos on the Hotels tab.
        imgSrc: ["'self'", "data:", "*.tile.openstreetmap.org", "unpkg.com", "cf.bstatic.com"],
        connectSrc: ["'self'", "ws:", "wss:"],
      },
    },
  }));
  // exposedHeaders lets the admin panel read the server-chosen filename off
  // Content-Disposition when it calls the API cross-origin (prod deploys
  // with no dev proxy) -- browsers hide response headers by default in CORS.
  app.use(cors({ origin: env.CORS_ORIGIN, exposedHeaders: ['Content-Disposition'] }));
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
  app.use('/api/push', require('./routes/push.routes'));
  app.use('/api/mobiles', require('./routes/mobile.routes'));
  app.use('/api/assignments', require('./routes/assignment.routes'));
  app.use('/api/reports', require('./routes/report.routes'));
  app.use('/api/hotels', require('./routes/hotel.routes'));

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
