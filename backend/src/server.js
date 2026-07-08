const http = require('http');
const env = require('./config/env');
const { connectDB } = require('./config/db');
const { createApp } = require('./app');
const { initSocket } = require('./realtime/io');

async function start() {
  await connectDB();
  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);

  server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`\n🚚 JSAN tracking API listening on http://localhost:${env.PORT}`);
    console.log(`   Health: http://localhost:${env.PORT}/health`);
    console.log(`   Socket.IO live channel ready (event: "location")\n`);
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
