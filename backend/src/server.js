const http = require('http');
const env = require('./config/env');
const { connectDB } = require('./config/db');
const { createApp } = require('./app');
const { initSocket } = require('./realtime/io');
const { startWatchdog } = require('./services/driverWatchdog');
const { startMapMatcher } = require('./services/mapMatcher');
const { startExportRunner } = require('./services/exportRunner');
const { startImportRunner } = require('./services/importRunner');
const { seedDefaultCategories } = require('./controllers/marker.controller');

async function start() {
  await connectDB();
  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);

  server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`\n🚚 JSAN tracking API listening on http://localhost:${env.PORT}`);
    console.log(`   Health: http://localhost:${env.PORT}/health`);
    console.log(`   Socket.IO live channel ready (events: "location", "alert")`);
    // Started after listen so the socket layer exists before the first sweep can emit.
    startWatchdog();
    startMapMatcher();
    startExportRunner();
    startImportRunner();
    seedDefaultCategories();
    console.log('');
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled rejection:', reason);
});
