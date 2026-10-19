import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { isAdminRole } from '../lib/types';
import { FleetField } from '../components/FleetField';

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
const MapSVG = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>
  </svg>
);
const ClockSVG = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
  </svg>
);
const RoadSVG = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 21 9 3M20 21 15 3M12 5v2M12 11v2M12 17v2"/>
  </svg>
);
const PhoneSVG = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>
  </svg>
);

/** What this platform actually does — the same words the panel's own pages use. */
const features = [
  { SVG: MapSVG,   title: 'Live map',               desc: 'Every vehicle on one map, as it drives' },
  { SVG: ClockSVG, title: 'Trips & working hours',  desc: 'Start, end, km and hours — recorded automatically' },
  { SVG: RoadSVG,  title: 'UKM & road coverage',    desc: 'New road driven, measured against customer networks' },
  { SVG: PhoneSVG, title: 'Driver app',             desc: 'Keeps recording offline, syncs when back in signal' },
];

/** Entrance order for the panel's content: each piece rises a beat after the one before. */
const stagger = (i: number) => ({ '--i': i } as React.CSSProperties);

/** Lets a feature card's glow follow the pointer (the CSS reads --mx / --my). */
function spotlight(e: React.MouseEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${e.clientX - r.left}px`);
  el.style.setProperty('--my', `${e.clientY - r.top}px`);
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

  return (
    <div className="login-bg">

      {/* ══ Left — the fleet ══ */}
      <div className="login-left">
        <FleetField className="login-field-canvas" />
        <div className="login-brand-row login-enter" style={stagger(0)}>
          <div className="login-brand-icon">
            <img src="/brand/logo.png" alt="JSAN" />
          </div>
          <div className="login-brand-name">JSAN ATLAS <span>ops</span></div>
        </div>

        <div className="login-left-content">
          <div className="login-left-tag login-enter" style={stagger(1)}>Live fleet tracking &amp; road coverage</div>
          <h2 className="login-enter" style={stagger(2)}>
            Every road driven.<br />
            <em>Every kilometre counted.</em>
          </h2>
          <p className="login-enter" style={stagger(3)}>
            Live positions, trip logs, UKM and customer road coverage for every vehicle
            in the field — from the driver&rsquo;s phone to this dashboard.
          </p>

          <div className="login-feature-list">
            {features.map(({ SVG, title, desc }, i) => (
              <div className="login-feature login-enter" key={title} style={stagger(4 + i)} onMouseMove={spotlight}>
                <div className="login-feature-icon"><SVG /></div>
                <div className="login-feature-text">
                  <strong>{title}</strong>
                  <span>{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* ══ Right — sign in ══ */}
      <div className="login-right">
        <div className="login-card">

          <div className="login-card-header">
            {/* Full-colour wordmark — this half of the screen is white, so it needs no tile. */}
            <img className="login-wordmark" src="/brand/logo.png" alt="ATLAS ops" />
            <h1 className="login-title">Sign in to the fleet dashboard</h1>
            <p className="login-sub">
              Live map, trips, coverage and reports for your projects.
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

          
        </div>
      </div>

    </div>
  );
}
