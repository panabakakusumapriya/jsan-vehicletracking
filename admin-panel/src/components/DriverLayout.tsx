import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const SsdsIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>
  </svg>
);
const TimesheetIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
  </svg>
);
const DailyReportIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>
  </svg>
);
const MenuIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);
const SignOutIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </svg>
);

const links = [
  { to: '/driver',              label: 'My SSDS',           end: true, Icon: SsdsIcon       },
  { to: '/driver/timesheets',   label: 'My Timesheets',               Icon: TimesheetIcon   },
  { to: '/driver/daily-reports',label: 'My Daily Reports',            Icon: DailyReportIcon },
];

function getInitials(name: string) {
  return name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase();
}

const DRAWER_BREAKPOINT = 820;
const isNarrow = () => typeof window !== 'undefined' && window.innerWidth <= DRAWER_BREAKPOINT;

export function DriverLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [rail, setRail] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleFromSidebar = () => {
    if (isNarrow()) setDrawerOpen(false);
    else setRail(v => !v);
  };

  return (
    <div className={`shell${rail ? ' rail' : ''}${drawerOpen ? ' drawer-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <div className="brand-logo"><img src="/brand/logo.png" alt="JSAN" /></div>
            <div className="brand-name">JSAN ATLAS <span>driver</span></div>
          </div>
          <button className="hamburger" onClick={toggleFromSidebar} aria-label={rail ? 'Expand' : 'Collapse'}>
            <MenuIcon />
          </button>
        </div>

        <nav>
          <div className="nav-section-label">Driver Portal</div>
          {links.map(({ to, label, end, Icon }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? 'active' : ''} title={label}>
              <Icon /><span className="nav-label">{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="avatar">{user?.name ? getInitials(user.name) : '?'}</div>
          <div className="who">
            <div className="who-name">{user?.name}</div>
            <div className="who-role">Driver</div>
          </div>
          <button
            className="btn-ghost"
            onClick={() => { signOut(); navigate('/login', { replace: true }); }}
            title="Sign out"
            style={{ padding: '6px 9px', flexShrink: 0 }}
          >
            <SignOutIcon />
          </button>
        </div>
      </aside>

      <div className="nav-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" />

      <main className="content">
        <div className="topbar">
          <button className="mobile-menu-btn" onClick={() => setDrawerOpen(true)} aria-label="Show menu" aria-expanded={drawerOpen}>
            <MenuIcon />
          </button>
          <img className="topbar-logo" src="/brand/logo.png" alt="JSAN" />
        </div>
        <Outlet />
      </main>
    </div>
  );
}
