import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';

// Connect to the backend's authenticated Socket.IO channel.
// In dev, API_URL is '' -> same origin, proxied by vite (ws: true).
export function createSocket(token: string): Socket {
  return io(API_URL || '/', {
    auth: { token },
    transports: ['websocket', 'polling'],
  });
}
