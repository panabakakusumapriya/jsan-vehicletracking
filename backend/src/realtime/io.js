const { Server } = require('socket.io');
const { verifyToken } = require('../utils/jwt');
const User = require('../models/User');
const env = require('../config/env');

let io = null;

function initSocket(server) {
  io = new Server(server, {
    cors: { origin: env.CORS_ORIGIN, methods: ['GET', 'POST'] },
  });

  // Authenticate every socket with the same JWT used for REST.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('unauthorized'));
      const payload = verifyToken(token);
      const user = await User.findById(payload.sub);
      if (!user || !user.active) return next(new Error('unauthorized'));
      socket.user = user;
      return next();
    } catch (err) {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const u = socket.user;
    // Watchers subscribe to rooms; the ingest path fans out to them.
    if (u.role === 'admin') socket.join('admins');
    if (u.role === 'manager') socket.join(`manager:${u._id}`);
  });

  return io;
}

// Broadcast a live position update to every watcher who may see this driver.
function emitLocation(payload) {
  if (!io) return;
  io.to('admins').emit('location', payload);
  if (payload.managerId) io.to(`manager:${payload.managerId}`).emit('location', payload);
}

// Push a fleet alert (driver offline / back online) to any panel that is open right now.
// This is the in-app half of an alert; the web-push half reaches closed panels. Both are
// sent so a manager watching the map sees it instantly even if they denied notifications.
function emitAlert(payload) {
  if (!io) return;
  io.to('admins').emit('alert', payload);
  if (payload.managerId) io.to(`manager:${payload.managerId}`).emit('alert', payload);
}

module.exports = { initSocket, emitLocation, emitAlert, getIO: () => io };
