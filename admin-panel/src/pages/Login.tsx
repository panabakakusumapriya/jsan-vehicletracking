import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { API_URL } from '../lib/api';
import { isAdminRole } from '../lib/types';
import { StreetCapture } from '../components/StreetCapture';

const MailSVG = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2"/>
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
  </svg>
);
const LockSVG = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
);
const ArrowSVG = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M12 5l7 7-7 7"/>
  </svg>
);
const EyeSVG = ({ off }: { off?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>
    {off && <path d="M3 3l18 18"/>}
  </svg>
);

/** What this platform actually does — the same words the panel's own pages use. Shown one at a time under the form. */
const features = [
  { title: 'Live map',              desc: 'Every capture vehicle on one map, as it drives' },
  { title: 'Trips & working hours', desc: 'Start, end, km and hours, recorded automatically' },
  { title: 'UKM & road coverage',   desc: 'New road captured, measured against the customer network' },
  { title: 'Driver app',            desc: 'Keeps recording offline, syncs when back in signal' },
];

/** Entrance order for the panel's content: each piece rises a beat after the one before. */
const stagger = (i: number) => ({ '--i': i } as React.CSSProperties);

type ServerState = 'checking' | 'online' | 'offline';
const SERVER_TEXT: Record<ServerState, string> = { checking: 'Checking server…', online: 'Server online', offline: 'Server unreachable' };

/** Whether the API answers, checked on open and every 30 s, so a sign-in failure isn't a mystery. */
function useServerState(): ServerState {
  const [state, setState] = useState<ServerState>('checking');
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch(`${API_URL}/health`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (alive) setState(res.ok ? 'online' : 'offline');
      } catch {
        if (alive) setState('offline');
      }
    };
    check();
    const id = setInterval(check, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return state;
}

/** The feature shown under the form, moving on every few seconds (held still with reduced motion). */
function useRotatingFeature() {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setI((n) => (n + 1) % features.length), 4500);
    return () => clearInterval(id);
  }, []);
  return i;
}

export function Login() {
  const { signIn, token, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const server = useServerState();
  const featureIdx = useRotatingFeature();

  // A driver sent here from a shared link (e.g. /academy) goes back to it after signing in.
  const nextParam = new URLSearchParams(window.location.search).get('next');
  const driverHome = nextParam && nextParam.startsWith('/driver') ? nextParam : '/driver';

  /**
   * Where a signed-in account lands. Admins and superadmins open the fleet Dashboard; managers and
   * team leads open the Live Map, because the Dashboard is admin-only (panel and API alike) and
   * would only bounce them there. Drivers go to the driver portal, or back to a shared link.
   */
  const homeFor = (role: string) => (role === 'user' ? driverHome : isAdminRole(role) ? '/dashboard' : '/');

  if (token && user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const u = await signIn(email.trim(), password);
      navigate(homeFor(u.role), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const watchCaps = (e: React.KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState('CapsLock'));
  const feature = features[featureIdx];

  return (
    <div className="login-bg">
      {/* The street-view capture drive behind both columns, with its HUD over the left one. */}
      <StreetCapture />

      {/* ══ Left — the capture drive ══ */}
      <div className="login-left">
        <div className="login-brand-row login-enter" style={stagger(0)}>
          <div className="login-brand-icon">
            <img src="/brand/logo.png" alt="JSAN" />
          </div>
          <div className="login-brand-name">ATLAS <span>ops</span></div>
        </div>
        <div className="login-scene-label login-enter" style={stagger(1)}>
          <strong>Street-level capture</strong>
          <span>360° imagery · road coverage · QC</span>
        </div>
      </div>

      {/* ══ Right — sign in ══ */}
      <div className="login-right">
        <div className="login-card">

          <div className="login-card-header">
            <div className="login-card-top">
              {/* Full-colour wordmark — the card is white, so it needs no tile. */}
              <img className="login-wordmark" src="/brand/logo.png" alt="ATLAS ops" />
              <span className={`login-server login-server--${server}`} role="status">{SERVER_TEXT[server]}</span>
            </div>
            <h1 className="login-title">Sign in to the fleet dashboard</h1>
            <p className="login-sub">
              Live map, trips, road coverage and reports for every capture drive.
            </p>
          </div>

          <form onSubmit={submit} noValidate>
            <div className="login-field">
              <label className="login-label" htmlFor="lg-email">Work email</label>
              <div className={`login-input-wrap${focused === 'email' ? ' focused' : ''}`}>
                <span className="login-input-icon"><MailSVG /></span>
                <input
                  id="lg-email"
                  className="login-input"
                  type="email"
                  autoComplete="username"
                  placeholder="you@company.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  onFocus={() => setFocused('email')}
                  onBlur={() => setFocused(null)}
                />
              </div>
            </div>

            <div className="login-field" style={{ marginBottom: 0 }}>
              <label className="login-label" htmlFor="lg-pass">Password</label>
              <div className={`login-input-wrap${focused === 'password' ? ' focused' : ''}`}>
                <span className="login-input-icon"><LockSVG /></span>
                <input
                  id="lg-pass"
                  className="login-input"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyUp={watchCaps}
                  onKeyDown={watchCaps}
                  onFocus={() => setFocused('password')}
                  onBlur={() => { setFocused(null); setCapsLock(false); }}
                />
                <button
                  type="button"
                  className="login-eye"
                  onClick={() => setShowPassword(v => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  <EyeSVG off={showPassword} />
                </button>
              </div>
              {capsLock && <div className="login-caps">Caps Lock is on</div>}
            </div>

            {error && (
              <div className="error-text" style={{ marginTop: 16 }}>
                <span>⚠</span> {error}
              </div>
            )}

            <button className="login-btn" type="submit" disabled={busy} style={{ marginTop: 28 }}>
              {busy ? <span className="login-spinner" /> : (
                <><span>Continue to dashboard</span><ArrowSVG /></>
              )}
            </button>
          </form>

          <div className="login-inside">
            <span className="login-inside-tag">Inside</span>
            <span className="login-inside-text" key={featureIdx}><strong>{feature.title}</strong> · {feature.desc}</span>
          </div>
        </div>
      </div>

    </div>
  );
}
