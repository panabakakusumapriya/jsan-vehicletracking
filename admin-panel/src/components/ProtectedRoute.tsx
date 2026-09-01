import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import type { TabKey, TabPermission } from '../lib/types';
import { ADMIN_ONLY_TABS } from '../lib/types';

function getTabPerm(tabKey: TabKey | undefined, role: string, perms?: Partial<Record<TabKey, TabPermission>>): TabPermission {
  if (!tabKey) return 'edit';
  if (role === 'admin') return 'edit';
  if (perms?.[tabKey]) return perms[tabKey]!;
  if (ADMIN_ONLY_TABS.includes(tabKey)) return 'hidden';
  return 'edit';
}

export function ProtectedRoute({ children, adminOnly, tabKey }: {
  children: ReactNode;
  adminOnly?: boolean;
  tabKey?: TabKey;
}) {
  const { loading, token, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="center-screen">Loading…</div>;
  }
  if (!token || !user) {
    return <Navigate to="/login" replace />;
  }

  const isDriver = user.role === 'user';
  const onDriverRoute = location.pathname.startsWith('/driver');

  // Drivers accessing non-driver routes → redirect to driver portal
  if (isDriver && !onDriverRoute) {
    return <Navigate to="/driver" replace />;
  }

  // Non-drivers: normal permission checks
  if (!isDriver) {
    if (adminOnly && user.role !== 'admin') {
      if (!tabKey || getTabPerm(tabKey, user.role, user.tabPermissions) === 'hidden') {
        return <Navigate to="/" replace />;
      }
    }
    if (tabKey && getTabPerm(tabKey, user.role, user.tabPermissions) === 'hidden') {
      return <Navigate to="/" replace />;
    }
  }

  return <>{children}</>;
}
