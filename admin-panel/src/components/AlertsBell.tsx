import { useEffect, useRef, useState } from 'react';
import {
  disablePush,
  enablePush,
  getPushState,
  sendTestNotification,
  type PushState,
} from '../lib/push';

/**
 * Sidebar control for driver alerts — the permanent home for what the one-time banner asks.
 * Someone who dismissed the banner (or switched laptops) turns alerts on from here.
 */
const BellIcon = ({ off }: { off: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    {off && <line x1="2" y1="2" x2="22" y2="22" />}
  </svg>
);

export function AlertsBell() {
  const [state, setState] = useState<PushState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    getPushState().then((s) => alive && setState(s));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Nothing to offer on a browser without push, or a server with no VAPID keys configured.
  if (state === null || state === 'unsupported' || state === 'unconfigured') return null;

  const on = state === 'on';

  const handleClick = async () => {
    if (state === 'denied') {
      setOpen((v) => !v);
      return;
    }
    if (on) {
      setOpen((v) => !v);
      return;
    }
    setBusy(true);
    try {
      setState(await enablePush());
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setNote(null);
    try {
      await sendTestNotification();
      setNote('Sent — check your notifications');
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      setState(await disablePush());
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="alerts-bell" ref={wrapRef}>
      <button
        className="btn-ghost"
        onClick={handleClick}
        disabled={busy}
        title={on ? 'Driver alerts are on' : 'Turn on driver alerts'}
        aria-label={on ? 'Driver alerts are on' : 'Turn on driver alerts'}
        style={{ padding: '6px 9px', flexShrink: 0, position: 'relative' }}
      >
        <BellIcon off={!on} />
        {on && <span className="alerts-bell-dot" />}
      </button>

      {open && (
        <div className="alerts-pop">
          {state === 'denied' ? (
            <>
              <strong>Notifications are blocked</strong>
              <p>
                Your browser is blocking notifications for this site. Allow them in the site
                settings (the icon next to the address bar), then reload.
              </p>
            </>
          ) : (
            <>
              <strong>Driver alerts are on</strong>
              <p>You'll be notified when one of your drivers stops reporting.</p>
              {note && <p className="alerts-pop-note">{note}</p>}
              <div className="alerts-pop-actions">
                <button className="btn-ghost" onClick={runTest} disabled={busy}>
                  Send test
                </button>
                <button className="btn-danger" onClick={turnOff} disabled={busy}>
                  Turn off
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
