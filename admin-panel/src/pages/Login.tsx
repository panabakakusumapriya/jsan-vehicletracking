import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { API_URL } from '../lib/api';
import { isAdminRole } from '../lib/types';
import { StreetCapture, type DriveStats } from '../components/StreetCapture';

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

/** Line icons for the launch steps and the labels over the street, one stroke style throughout. */
const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const ICONS = {
  shield: 'M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3zM9 12l2 2 4-4',
  car: 'M5 17h14M6 17v2M18 17v2M3 13l2-5a2 2 0 0 1 1.9-1.4h10.2A2 2 0 0 1 19 8l2 5v4H3v-4zM7 14h.01M17 14h.01',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4V8zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  pin: 'M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.9V16h5v-.2c0-.8.4-1.5 1-1.9A6 6 0 0 0 12 3z',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  building: 'M4 21V5l8-2v18M12 21V9l8 2v10M3 21h18M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7',
};

/**
 * What follows a successful sign-in: "Initializing Atlas Ops", a progress bar and four steps that
 * tick off one after another, while the drive carries on behind — then the workspace opens. About
 * seven seconds in all, each step getting a clear beat of its own, and "Ready" held a moment at
 * 100%, so the screen can actually be read. The first step is real (the sign-in just succeeded);
 * the others mark the workspace coming up. Reduced motion shortens it to under a second.
 */
const LAUNCH_STEPS = [
  { icon: ICONS.shield, title: 'Verifying access', done: 0.18 },
  { icon: ICONS.car, title: 'Syncing fleet', desc: 'Connecting vehicles and their latest positions', done: 0.45 },
  { icon: ICONS.db, title: 'Loading trips & coverage', desc: 'Retrieving the field work', done: 0.72 },
  { icon: ICONS.map, title: 'Initializing map layers', desc: 'Preparing the live map and street-level data', done: 0.96 },
];

const LAUNCH_MS = 6500;
const READY_HOLD_MS = 900;

function LaunchPanel({ name, onDone }: { name: string; onDone: () => void }) {
  const [p, setP] = useState(0);
  // Pointer over the panel holds the sequence where it is, so the steps can be read; it carries
  // on from there when the pointer leaves. Even "Ready" waits, so nothing opens under the pointer.
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const quick = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const total = quick ? 800 : LAUNCH_MS;
    const hold = quick ? 150 : READY_HOLD_MS;
    let elapsed = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      if (!pausedRef.current) elapsed += now - last;
      last = now;
      const t = Math.min(1, elapsed / total);
      setP(t < 1 ? t * (1.15 - 0.15 * t) : 1); // nearly even, easing off a touch at the end
      if (elapsed >= total + hold) doneRef.current();
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const pct = Math.round(p * 100);
  return (
    <div
      className={`launch${paused ? ' is-paused' : ''}`}
      role="status"
      aria-live="polite"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      <h1 className="launch-title">Initializing <span>Atlas Ops</span></h1>
      <p className="launch-sub">Preparing your operational workspace</p>
      <div className="launch-progress">
        <div className="launch-bar"><div style={{ width: `${pct}%` }} /></div>
        <span className="launch-pct">{pct}%</span>
      </div>
      <div className="launch-note">
        {paused
          ? 'Paused — move the pointer away to continue'
          : pct < 100
          ? `${pct < 60 ? 'Getting things ready…' : 'Almost ready…'} (${Math.max(1, Math.ceil(((1 - p) * LAUNCH_MS) / 1000))} s)`
          : 'Ready — opening your workspace'}
      </div>
      <ol className="launch-steps">
        {LAUNCH_STEPS.map((s, i) => {
          const done = p >= s.done;
          const active = !done && (i === 0 || p >= LAUNCH_STEPS[i - 1].done);
          return (
            <li key={s.title} className={done ? 'is-done' : active ? 'is-active' : ''}>
              <span className="launch-step-icon"><Icon d={s.icon} size={17} /></span>
              <span className="launch-step-text">
                <strong>{s.title}</strong>
                <span>{i === 0 ? (name ? `Signed in as ${name}` : 'Authenticating your account') : s.desc}</span>
              </span>
              <span className="launch-step-state" aria-label={done ? 'done' : active ? 'in progress' : 'waiting'}>
                {done ? <Icon d={ICONS.check} size={13} /> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="launch-foot">
        <span className="launch-foot-icon"><Icon d={ICONS.bulb} size={18} /></span>
        <span><strong>Global visibility. Street-level detail.</strong>Turning field data into actionable insights.</span>
      </div>
    </div>
  );
}

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

  // After a sign-in made HERE, the launch sequence plays before the workspace opens. The ref is set
  // before signIn resolves: the auth state lands a render before setLaunch does, and without it
  // that render would redirect at once and the sequence would never show. Someone who arrives
  // already signed in goes straight through.
  const launchingRef = useRef(false);
  const [launch, setLaunch] = useState<{ home: string; name: string } | null>(null);
  // The drive behind the page, as numbers for the cards over the street.
  const [drive, setDrive] = useState<DriveStats>({ km: 0, kmh: 0, frames: 0, buildings: 0 });

  if (token && user && !launchingRef.current) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    launchingRef.current = true;
    try {
      const u = await signIn(email.trim(), password);
      setLaunch({ home: homeFor(u.role), name: u.name || '' });
    } catch (err) {
      launchingRef.current = false;
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const watchCaps = (e: React.KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState('CapsLock'));
  const feature = features[featureIdx];

  return (
    <div className={`login-bg${launch ? ' is-launching' : ''}`}>
      {/* The street-view capture drive, behind both columns; it lifts off once signed in. */}
      <StreetCapture launching={!!launch} onStats={setDrive} />

      {/* ══ Left — the capture drive ══ */}
      <div className="login-left">
        <div className="login-hero login-enter" style={stagger(0)}>
          <img className="login-hero-logo" src="/brand/logo.png" alt="JSAN" />
          <div className="login-hero-tag"><span>People</span><i /><span>Technology</span><i /><span>Places</span></div>
          <h2 className="login-hero-title">Atlas <span>Ops</span></h2>
          <p className="login-hero-sub">Collection Intelligence Platform</p>
        </div>
      </div>

      {/* Labels over the street: what the car is doing. */}
      <div className="login-tags" aria-hidden="true">
        <div className="login-tag login-tag--capture login-enter" style={stagger(3)}>
          <Icon d={ICONS.camera} size={14} /> Street View Capture
        </div>
        <div className="login-tag login-tag--live login-enter" style={stagger(4)}>
          <span className="login-tag-pin"><Icon d={ICONS.pin} size={15} /></span>
          <span><strong>Live Collection</strong>GPS · Imagery</span>
        </div>
        <div className="login-stat login-stat--captured login-enter" style={stagger(5)}>
          <div className="login-stat-head"><Icon d={ICONS.building} size={14} /> Captured this drive</div>
          <dl>
            <div><dt>Buildings</dt><dd>{drive.buildings}</dd></div>
            <div><dt>Frames</dt><dd>{drive.frames}</dd></div>
            <div><dt>Speed</dt><dd>{Math.round(drive.kmh)} km/h</dd></div>
          </dl>
        </div>
        <div className="login-stat login-stat--route login-enter" style={stagger(6)}>
          <div className="login-stat-head"><Icon d={ICONS.route} size={14} /> Route progress</div>
          <div className="login-stat-km">{drive.km.toFixed(2)} <small>km</small></div>
          <div className="login-stat-sub">Current segment</div>
          <div className="login-stat-track" aria-hidden="true">
            {[0, 1, 2, 3].map((k) => {
              const seg = Math.floor(drive.km / 0.05) % 4;
              return <i key={k} className={k < seg ? 'is-done' : k === seg ? 'is-on' : ''} />;
            })}
          </div>
        </div>
      </div>

      {/* ══ Right — sign in, then the launch sequence ══ */}
      <div className="login-right">
        {launch ? (
          <div className="login-card login-card--launch">
            <LaunchPanel name={launch.name} onDone={() => navigate(launch.home, { replace: true })} />
          </div>
        ) : (
        <div className="login-card">

          <div className="login-card-header">
            <div className="login-card-top">
              {/* Full-colour wordmark — the card is white, so it needs no tile. */}
              <img className="login-wordmark" src="/brand/logo.png" alt="ATLAS ops" />
              <span className={`login-server login-server--${server}`} role="status">{SERVER_TEXT[server]}</span>
            </div>
            <h1 className="login-title">Sign in to <span>Atlas Ops</span></h1>
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
        )}
      </div>

    </div>
  );
}
