import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocketEvent } from '../lib/socket';
import type { AlertEvent } from '../lib/types';

/**
 * In-panel half of the alert system.
 *
 * The same alert can arrive twice — over the live socket, and again from the service worker
 * when a push lands while the panel is open — so both paths funnel through `push()` which
 * drops a repeat of the same (tag, ts). This exists so a manager who denied notification
 * permission (or is mid-reconnect) still sees the alert while they're looking at the map.
 */
const DISMISS_MS: Record<string, number> = {
  'driver-offline': 14000,
  'driver-online': 7000,
  test: 7000,
};

interface Toast {
  id: number;
  alert: AlertEvent;
}

let nextId = 1;

export function AlertToaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const navigate = useNavigate();
  const seen = useRef(new Set<string>());
  const timers = useRef<number[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (alert: AlertEvent) => {
      if (!alert || !alert.title) return;
      const key = `${alert.tag || alert.type}:${alert.ts}`;
      if (seen.current.has(key)) return;
      seen.current.add(key);

      const id = nextId++;
      // Cap the stack: an offline sweep across a big fleet shouldn't bury the map.
      setToasts((prev) => [...prev.slice(-4), { id, alert }]);
      timers.current.push(
        window.setTimeout(() => dismiss(id), DISMISS_MS[alert.type] ?? 9000)
      );
    },
    [dismiss]
  );

  useSocketEvent<AlertEvent>('alert', push);

  // Messages from the service worker: a push that arrived with the panel open, and taps on
  // a system notification (routed here so React navigates instead of reloading the app).
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.source !== 'jsan-sw') return;
      if (data.kind === 'push' && data.alert) push(data.alert as AlertEvent);
      if (data.kind === 'navigate' && typeof data.url === 'string') navigate(data.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [push, navigate]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  if (!toasts.length) return null;

  return (
    <div className="toast-stack" role="region" aria-label="Fleet alerts">
      {toasts.map(({ id, alert }) => (
        <div
          key={id}
          className={`toast toast-${alert.type}`}
          role="alert"
          onClick={() => {
            if (alert.url) navigate(alert.url);
            dismiss(id);
          }}
        >
          <div className="toast-body">
            <strong>{alert.title}</strong>
            <span>{alert.body}</span>
          </div>
          <button
            className="toast-close"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
