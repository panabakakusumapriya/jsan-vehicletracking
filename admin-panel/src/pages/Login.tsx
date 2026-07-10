import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const FleetIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v9a2 2 0 0 1-2 2h-1" />
    <circle cx="7" cy="17" r="2" />
    <circle cx="17" cy="17" r="2" />
    <path d="M9 3v5h6" />
  </svg>
);

const LockIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

export function Login() {
  const { signIn, token, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@jsan.local');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (token && user) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
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
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">
          <FleetIcon />
        </div>
        <h1 className="login-title">Welcome back</h1>
        <p className="login-sub">Sign in to the JSANFleet admin panel</p>

        <div className="field">
          <label>Email address</label>
          <input
            className="input"
            type="email"
            autoComplete="username"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <div className="error-text">
            <span>⚠</span>
            {error}
          </div>
        )}

        <button className="btn" type="submit" disabled={busy} style={{ width: '100%', marginTop: 8, justifyContent: 'center', padding: '13px' }}>
          <LockIcon />
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--muted)', marginTop: 20, marginBottom: 0 }}>
          Driver app available on Android
        </p>
      </form>
    </div>
  );
}
