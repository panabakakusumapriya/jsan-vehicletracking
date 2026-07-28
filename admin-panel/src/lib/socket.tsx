import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';
import { useAuth } from './auth';

// Connect to the backend's authenticated Socket.IO channel.
// In dev, API_URL is '' -> same origin, proxied by vite (ws: true).
export function createSocket(token: string): Socket {
  return io(API_URL || '/', {
    auth: { token },
    transports: ['websocket', 'polling'],
  });
}

interface SocketValue {
  socket: Socket | null;
  connected: boolean;
}

const SocketContext = createContext<SocketValue>({ socket: null, connected: false });

/**
 * One authenticated connection for the whole app.
 *
 * Both the live map and the alert toaster listen to it; before this existed the map owned
 * its own socket, and adding a second consumer would have meant a second connection (and a
 * second entry in the backend's `admins` room) per open tab.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!token) {
      setSocket(null);
      setConnected(false);
      return;
    }
    const s = createSocket(token);
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    setSocket(s);
    return () => {
      s.close();
      setSocket(null);
      setConnected(false);
    };
  }, [token]);

  const value = useMemo<SocketValue>(() => ({ socket, connected }), [socket, connected]);
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketValue {
  return useContext(SocketContext);
}

/**
 * Subscribe to a server event for the life of the component. The handler is held in a ref
 * so a re-render with a fresh closure doesn't churn the listener.
 */
export function useSocketEvent<T>(event: string, handler: (payload: T) => void): void {
  const { socket } = useSocket();
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!socket) return;
    const fn = (payload: T) => ref.current(payload);
    socket.on(event, fn);
    return () => {
      socket.off(event, fn);
    };
  }, [socket, event]);
}
