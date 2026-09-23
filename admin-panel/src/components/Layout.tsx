import { AppIcon } from './AppIcon';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { syncExistingSubscription } from '../lib/push';
import { AlertsBell } from './AlertsBell';
import { AlertToaster } from './AlertToaster';
import { PwaBanner } from './PwaBanner';
import type { TabKey, TabPermission } from '../lib/types';
import { ADMIN_ONLY_TABS } from '../lib/types';

const MapIcon = () => <AppIcon name="map" size={19} />;
const TripIcon = () => <AppIcon name="route" size={19} />;
const DriverIcon = () => <AppIcon name="users" size={19} />;
const ReportIcon = () => <AppIcon name="report" size={19} />;
const VehicleIcon = () => <AppIcon name="vehicle" size={19} />;
const UpdateIcon = () => <AppIcon name="upload" size={19} />;
const ProjectIcon = () => <AppIcon name="folder" size={19} />;
const ManagerIcon = () => <AppIcon name="users" size={19} />;
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

const PhoneIcon = () => <AppIcon name="phone" size={19} />;

const WeatherIcon = () => <AppIcon name="weather" size={19} />;

const HealthIcon = () => <AppIcon name="health" size={19} />;

const HistoryIcon = () => <AppIcon name="history" size={19} />;

const BedIcon = () => <AppIcon name="hotel" size={19} />;
const PackageIcon = () => <AppIcon name="parcel" size={19} />;

const CoverageIcon = () => <AppIcon name="coverage" size={19} />;

const links: { to: string; label: string; end?: boolean; Icon: () => JSX.Element; tabKey: TabKey }[] = [
  { to: '/',         label: 'Live Map', end: true, Icon: MapIcon,    tabKey: 'live_map'      },
  { to: '/trips',    label: 'Trips',              Icon: TripIcon,   tabKey: 'trips'          },
  { to: '/drivers',  label: 'Drivers',            Icon: DriverIcon, tabKey: 'drivers'        },
  { to: '/mobiles',  label: 'Mobiles',            Icon: PhoneIcon,  tabKey: 'mobiles'        },
  { to: '/vehicles', label: 'Vehicles',           Icon: VehicleIcon,tabKey: 'vehicles'       },
  { to: '/weather',  label: 'Predictive Weather', Icon: WeatherIcon,tabKey: 'weather'        },
  { to: '/hotels',   label: 'Hotels',             Icon: BedIcon,    tabKey: 'hotels'         },
  { to: '/couriers', label: 'Couriers',           Icon: PackageIcon,tabKey: 'couriers'       },
  { to: '/coverage',   label: 'Coverage',           Icon: CoverageIcon,tabKey: 'coverage'       },
  { to: '/app-health', label: 'App Health',       Icon: HealthIcon, tabKey: 'app_health'     },
  { to: '/asset-history', label: 'Asset History',  Icon: HistoryIcon,tabKey: 'asset_history'  },
  { to: '/reports',  label: 'Reports',            Icon: ReportIcon, tabKey: 'reports'        },
];

const FlagIcon = () => <AppIcon name="pin" size={19} />;

const adminLinks: { to: string; label: string; Icon: () => JSX.Element; tabKey: TabKey }[] = [
  { to: '/managers',    label: 'Users',       Icon: ManagerIcon, tabKey: 'managers'    },
  { to: '/projects',    label: 'Projects',    Icon: ProjectIcon, tabKey: 'projects'    },
  { to: '/app-updates', label: 'App Updates', Icon: UpdateIcon,  tabKey: 'app_updates' },
  { to: '/markers',     label: 'Markers',     Icon: FlagIcon,    tabKey: 'markers'     },
];

const SsdsIcon = () => <AppIcon name="grid" size={19} />;
const TimesheetIcon = () => <AppIcon name="clock" size={19} />;
const DailyReportIcon = () => <AppIcon name="report" size={19} />;

const ssdsLinks: { to: string; label: string; Icon: () => JSX.Element; tabKey: TabKey }[] = [
  { to: '/ssds-portal',        label: 'SSDS Portal',         Icon: SsdsIcon,        tabKey: 'ssds_portal'         },
  { to: '/ssds-timesheets',    label: 'Timesheets',          Icon: TimesheetIcon,   tabKey: 'timesheets'          },
  { to: '/ssds-daily-reports', label: 'Daily Status Report', Icon: DailyReportIcon, tabKey: 'daily_status_report' },
];

/** Resolve a tab's effective permission for the current user. */
function getTabPermission(tabKey: TabKey, role: string, tabPermissions?: Partial<Record<TabKey, TabPermission>>): TabPermission {
  if (role === 'admin') return 'edit';
  if (tabPermissions?.[tabKey]) return tabPermissions[tabKey]!;
  if (ADMIN_ONLY_TABS.includes(tabKey)) return 'hidden';
  return 'edit';
}

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
            <div className="brand-product">ATLAS <span>OPS</span></div>
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
          {links
            .filter(({ tabKey }) => getTabPermission(tabKey, user?.role || '', user?.tabPermissions) !== 'hidden')
            .map(({ to, label, end, Icon }) => (
            <NavLink
              key={to} to={to} end={end}
              className={({ isActive }) => isActive ? 'active' : ''}
              title={label}
            >
              <Icon /><span className="nav-label">{label}</span>
            </NavLink>
          ))}

          {(() => {
            const visibleAdmin = adminLinks.filter(
              ({ tabKey }) => getTabPermission(tabKey, user?.role || '', user?.tabPermissions) !== 'hidden'
            );
            if (!visibleAdmin.length) return null;
            return (
              <>
                <div className="nav-section-label" style={{ marginTop: 8 }}>Admin</div>
                {visibleAdmin.map(({ to, label, Icon }) => (
                  <NavLink key={to} to={to} title={label} className={({ isActive }) => isActive ? 'active' : ''}>
                    <Icon /><span className="nav-label">{label}</span>
                  </NavLink>
                ))}
              </>
            );
          })()}

          {(() => {
            const visibleSsds = ssdsLinks.filter(
              ({ tabKey }) => getTabPermission(tabKey, user?.role || '', user?.tabPermissions) !== 'hidden'
            );
            if (!visibleSsds.length) return null;
            return (
              <>
                <div className="nav-section-label" style={{ marginTop: 8 }}>SSDS Tool</div>
                {visibleSsds.map(({ to, label, Icon }) => (
                  <NavLink key={to} to={to} title={label} className={({ isActive }) => isActive ? 'active' : ''}>
                    <Icon /><span className="nav-label">{label}</span>
                  </NavLink>
                ))}
              </>
            );
          })()}
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
