const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

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
  // Wildcard, always. The API is public-by-token: every route is guarded by a Bearer JWT,
  // never by cookies, so the origin is not what protects anything here. Making it a config
  // knob only created a way to deploy a backend the panel could not talk to.
  // NOTE: '*' and credentialed requests are mutually exclusive per the CORS spec — if cookie
  // auth is ever introduced, this has to become an explicit origin list again.
  app.use(cors({ origin: '*', exposedHeaders: ['Content-Disposition'] }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.json({ limit: '5mb' })); // offline batches can be large
  app.use(morgan('dev'));

  /**
   * Health, plus what this particular build can do.
   *
   * `features` exists because of a genuinely confusing incident: during a rolling deploy the OLD
   * container was still accepting uploads while the NEW one served everything else, so a 36 MB
   * archive was written to a filesystem that was about to be discarded, and the failure only
   * surfaced afterwards. There was no way to ask "which build am I actually talking to". Now there
   * is — check this before starting a long upload after a deploy.
   */
  app.get('/health', (req, res) =>
    res.json({
      ok: true,
      service: 'jsan-tracking-api',
      time: new Date().toISOString(),
      features: {
        // Uploads are stored in MongoDB (GridFS) and survive a redeploy. When false, this build
        // still writes them to the container's ephemeral disk.
        durableUploads: true,
        // Work areas can be imported without a road-network layer.
        optionalRoadLayer: true,
      },
    })
  );

  app.use('/api/auth', require('./routes/auth.routes'));
  app.use('/api/users', require('./routes/user.routes'));
  app.use('/api/projects', require('./routes/project.routes'));
  app.use('/api/vehicles', require('./routes/vehicle.routes'));
  app.use('/api/trips', require('./routes/trip.routes'));
  app.use('/api/tracking', require('./routes/tracking.routes'));
  app.use('/api/app', require('./routes/appVersion.routes'));
  app.use('/api/push', require('./routes/push.routes'));
  app.use('/api/mobiles', require('./routes/mobile.routes'));
  app.use('/api/assignments', require('./routes/assignment.routes'));
  app.use('/api/app-activity', require('./routes/appActivity.routes'));
  app.use('/api/reports', require('./routes/report.routes'));
  app.use('/api/weather', require('./routes/weather.routes'));
  app.use('/api/hotels', require('./routes/hotel.routes'));
  app.use('/api/couriers', require('./routes/courier.routes'));
  app.use('/api/network', require('./routes/network.routes'));

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
