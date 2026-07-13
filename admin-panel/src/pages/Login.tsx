import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const TruckSVG = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v9a2 2 0 0 1-2 2h-1"/>
    <circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>
    <path d="M9 3v5h6"/>
  </svg>
);
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
const PinSVG = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>
  </svg>
);
const RouteSVG = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="19" r="3"/>
    <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>
    <circle cx="18" cy="5" r="3"/>
  </svg>
);
const UsersSVG = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);
const ShieldSVG = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
);
const LockSmSVG = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
);

const features = [
  { SVG: PinSVG,    title: 'Live GPS Tracking',    desc: 'Real-time driver positions on an interactive map' },
  { SVG: RouteSVG,  title: 'Automated Trip Logs',  desc: 'Every journey recorded start-to-finish automatically' },
  { SVG: UsersSVG,  title: 'Fleet Management',      desc: 'Drivers, vehicles, and managers in one place' },
  { SVG: ShieldSVG, title: 'Role-based Access',     desc: 'Granular permissions across admin, manager & driver' },
];

export function Login() {
  const { signIn, token, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@jsan.local');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  if (token && user) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await signIn(email.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-bg">

      {/* ══ Left — dark brand panel ══ */}
      <div className="login-left">
        <div className="login-brand-row">
          <div className="login-brand-icon"><TruckSVG /></div>
          <div className="login-brand-name">JSAN<span>Fleet</span></div>
        </div>

        <div className="login-left-content">
          <div className="login-left-tag">Fleet Management Platform</div>
          <h2>
            Track every mile.<br />
            <em>One command center.</em>
          </h2>
          <p>
            Built for logistics teams that need real-time visibility,
            reliable GPS tracking, and smart fleet reporting.
          </p>
          <div className="login-feature-list">
            {features.map(({ SVG, title, desc }) => (
              <div className="login-feature" key={title}>
                <div className="login-feature-icon"><SVG /></div>
                <div className="login-feature-text">
                  <strong>{title}</strong>
                  <span>{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="login-left-foot">
          <LockSmSVG />
          End-to-end encrypted &nbsp;·&nbsp; Driver app on Android
        </div>
      </div>

      {/* ══ Right — clean form ══ */}
      <div className="login-right">
        <div className="login-card">

          <div className="login-card-header">
            <h1 className="login-title">Sign in</h1>
            <p className="login-sub">
              Enter your credentials to access the fleet dashboard.
            </p>
          </div>

          <form onSubmit={submit} noValidate>
            <div className="login-field">
              <label className="login-label" htmlFor="lg-email">Email</label>
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
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onFocus={() => setFocused('password')}
                  onBlur={() => setFocused(null)}
                />
              </div>
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

          <p className="login-card-foot">
            Secure admin access &nbsp;·&nbsp; Driver portal is a separate Android app
          </p>
        </div>
      </div>

    </div>
  );
}
