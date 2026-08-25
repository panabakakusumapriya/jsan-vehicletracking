import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { syncExistingSubscription } from '../lib/push';
import { AlertsBell } from './AlertsBell';
import { AlertToaster } from './AlertToaster';
import { PwaBanner } from './PwaBanner';

const MapIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
    <line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/>
  </svg>
);
const TripIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12h18M3 6h18M3 18h12"/>
  </svg>
);
const DriverIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);
const ReportIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
  </svg>
);
const VehicleIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v9a2 2 0 0 1-2 2h-1"/>
    <circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>
    <path d="M9 3v5h6"/>
  </svg>
);
const UpdateIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/>
    <line x1="12" y1="3" x2="12" y2="15"/>
  </svg>
);
const ProjectIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
);
const ManagerIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);
/** The three-line hamburger. Always three lines — it never morphs into an X, so the control
 *  reads the same whatever state the menu is in. */
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

const PhoneIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>
  </svg>
);

const WeatherIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.6A3.7 3.7 0 0 0 6.5 19z"/>
    <line x1="8" y1="21" x2="8" y2="23"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="16" y1="21" x2="16" y2="23"/>
  </svg>
);

const UkmIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6L6 18"/><path d="M8 6h10v10"/>
  </svg>
);
const HealthIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
  </svg>
);

const HistoryIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v5h5"/>
    <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/>
    <path d="M12 7v5l4 2"/>
  </svg>
);

const BedIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>
  </svg>
);
const PackageIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
    <path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>
  </svg>
);

const CoverageIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 5.5 9 3l6 2.5L21 3v13l-6 2.5L9 16l-6 2.5z"/>
    <path d="M9 3v13M15 5.5v13"/>
    <path d="m7 12 2.5 2.5L15 9"/>
  </svg>
);

const links = [
  { to: '/',         label: 'Live Map', end: true, Icon: MapIcon    },
  { to: '/trips',    label: 'Trips',              Icon: TripIcon   },
  { to: '/drivers',  label: 'Drivers',            Icon: DriverIcon },
  { to: '/mobiles',  label: 'Mobiles',            Icon: PhoneIcon  },
  { to: '/vehicles', label: 'Vehicles',           Icon: VehicleIcon},
  { to: '/weather',  label: 'Predictive Weather',  Icon: WeatherIcon},
  { to: '/hotels',   label: 'Hotels',             Icon: BedIcon    },
  { to: '/couriers', label: 'Couriers',           Icon: PackageIcon},
  { to: '/ukm',        label: 'UKM',                 Icon: UkmIcon    },
  { to: '/coverage',   label: 'Coverage',            Icon: CoverageIcon },
  { to: '/app-health', label: 'App Health',         Icon: HealthIcon },
  { to: '/asset-history', label: 'Asset History', Icon: HistoryIcon },
  { to: '/reports',  label: 'Reports',             Icon: ReportIcon },
];

function getInitials(name: string) {
  return name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase();
}

/** Below this width the sidebar is a drawer rather than a column. Matches the CSS breakpoint. */
const DRAWER_BREAKPOINT = 820;
const isNarrow = () => typeof window !== 'undefined' && window.innerWidth <= DRAWER_BREAKPOINT;

export function Layout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Two separate states rather than one overloaded flag: `rail` is the desktop collapse,
  // `drawerOpen` is the mobile slide-in. They never interact, so neither breakpoint can
  // end up showing the opposite of what was asked for.
  const [rail, setRail] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Re-bind this browser's push subscription to whoever is signed in now. Covers a rotated
  // endpoint and a shared machine where a different manager logs in.
  useEffect(() => {
    if (user) syncExistingSubscription();
  }, [user]);

  // Navigating dismisses the drawer — otherwise it covers the page you just asked for.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Esc closes the drawer, the expected way out of any overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** The sidebar hamburger: rails the column on desktop, closes the drawer on mobile. */
  const toggleFromSidebar = () => {
    if (isNarrow()) setDrawerOpen(false);
    else setRail(v => !v);
  };

  return (
    <div className={`shell${rail ? ' rail' : ''}${drawerOpen ? ' drawer-open' : ''}`}>
      <aside className="sidebar">
        {/* Brand, with the hamburger on the right of the sidebar header. */}
        <div className="sidebar-top">
          <div className="brand">
            <div className="brand-logo">
              <img src="/brand/logo.png" alt="JSAN" />
            </div>
            <div className="brand-name">JSAN ATLAS <span>ops</span></div>
          </div>
          <button
            className="hamburger"
            onClick={toggleFromSidebar}
            aria-label={rail ? 'Expand menu' : 'Collapse menu'}
            title={rail ? 'Expand menu' : 'Collapse menu'}
          >
            <MenuIcon />
          </button>
        </div>

        {/* Nav */}
        <nav>
          <div className="nav-section-label">Main Menu</div>
          {links.map(({ to, label, end, Icon }) => (
            <NavLink
              key={to} to={to} end={end}
              className={({ isActive }) => isActive ? 'active' : ''}
              title={label}
            >
              {/* Wrapped so rail mode can hide the text and leave the icon. */}
              <Icon /><span className="nav-label">{label}</span>
            </NavLink>
          ))}

          {user?.role === 'admin' && (
            <>
              <div className="nav-section-label" style={{ marginTop: 8 }}>Admin</div>
              <NavLink to="/managers" title="Users" className={({ isActive }) => isActive ? 'active' : ''}>
                <ManagerIcon /><span className="nav-label">Users</span>
              </NavLink>
              <NavLink to="/projects" title="Projects" className={({ isActive }) => isActive ? 'active' : ''}>
                <ProjectIcon /><span className="nav-label">Projects</span>
              </NavLink>
              <NavLink to="/app-updates" title="App Updates" className={({ isActive }) => isActive ? 'active' : ''}>
                <UpdateIcon /><span className="nav-label">App Updates</span>
              </NavLink>
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="sidebar-foot">
          <div className="avatar">
            {user?.name ? getInitials(user.name) : '?'}
          </div>
          <div className="who">
            <div className="who-name">{user?.name}</div>
            <div className="who-role">{user?.role}</div>
          </div>
          <AlertsBell />
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

      {/* Scrim behind the mobile drawer; CSS keeps it inert on desktop. */}
      <div className="nav-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" />

      <main className="content">
        {/* Mobile only (CSS-gated): the drawer is off-screen, so it needs an opener out here. */}
        <div className="topbar">
          <button
            className="mobile-menu-btn"
            onClick={() => setDrawerOpen(true)}
            aria-label="Show menu"
            aria-expanded={drawerOpen}
          >
            <MenuIcon />
          </button>
          <img className="topbar-logo" src="/brand/logo.png" alt="JSAN" />
        </div>
        <Outlet />
      </main>

      {/* App-wide overlays: one-time install/alerts nudge and live alert toasts. */}
      <PwaBanner />
      <AlertToaster />
    </div>
  );
}
