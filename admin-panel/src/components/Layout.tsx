import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const links = [
  { to: '/', label: 'Live Map', end: true },
  { to: '/trips', label: 'Trips' },
  { to: '/drivers', label: 'Drivers' },
  { to: '/vehicles', label: 'Vehicles' },
];

export function Layout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const onSignOut = () => {
    signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          JSAN<span>Fleet</span>
        </div>
        <nav>
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              {l.label}
            </NavLink>
          ))}
          {user?.role === 'admin' && (
            <NavLink to="/managers" className={({ isActive }) => (isActive ? 'active' : '')}>
              Managers
            </NavLink>
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="who">
            <div className="who-name">{user?.name}</div>
            <div className="who-role">{user?.role}</div>
          </div>
          <button className="btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
