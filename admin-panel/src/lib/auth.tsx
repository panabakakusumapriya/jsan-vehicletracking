import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, tokenStore } from './api';
import { TIMED_OUT_MESSAGE, idleTooLong, markActive, noteSignedOut } from './session';
import type { TabKey, TabPermission, User } from './types';
import { isAdminRole } from './types';
import { ADMIN_ONLY_TABS } from './types';

interface AuthValue {
  loading: boolean;
  token: string | null;
  user: User | null;
  signIn: (email: string, password: string) => Promise<User>;
  signOut: () => void;
}

const AuthContext = createContext<AuthValue | undefined>(undefined);
const USER_KEY = 'jsan_admin_user';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(tokenStore.get());
  const [user, setUser] = useState<User | null>(() => {
    const s = localStorage.getItem(USER_KEY);
    return s ? (JSON.parse(s) as User) : null;
  });
  const [loading, setLoading] = useState(true);

  // Validate the stored token on boot.
  useEffect(() => {
    (async () => {
      // A panel user back after more than the idle limit: signed out before anything loads.
      if (token && user && user.role !== 'user' && idleTooLong()) {
        tokenStore.clear();
        localStorage.removeItem(USER_KEY);
        noteSignedOut(TIMED_OUT_MESSAGE);
        setToken(null);
        setUser(null);
        setLoading(false);
        return;
      }
      if (token) {
        try {
          const { user: fresh } = await api.get<{ user: User }>('/api/auth/me');
          setUser(fresh);
          localStorage.setItem(USER_KEY, JSON.stringify(fresh));
        } catch {
          setToken(null);
          setUser(null);
        }
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = async (email: string, password: string) => {
    const { token: t, user: u } = await api.post<{ token: string; user: User }>('/api/auth/login', {
      email,
      password,
    });
    if (!['superadmin', 'admin', 'manager', 'team_lead', 'user'].includes(u.role)) {
      throw new Error('Invalid account role.');
    }
    tokenStore.set(t);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    markActive(true);
    setToken(t);
    setUser(u);
    return u;
  };

  const signOut = () => {
    tokenStore.clear();
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  };

  /**
   * The idle sign-out (lib/session.ts) — for the admin panel only: managers, team leads, admins.
   * A driver (role 'user', the web driver pages) stays signed in as before, like the phone app.
   * Activity in any tab counts; the check runs every minute and when a tab comes back into view.
   */
  const panelUser = Boolean(token && user && user.role !== 'user');
  useEffect(() => {
    if (!panelUser) return undefined;
    const active = () => markActive();
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, active, { passive: true, capture: true });
    const check = () => {
      if (!idleTooLong()) return;
      noteSignedOut(TIMED_OUT_MESSAGE);
      tokenStore.clear();
      localStorage.removeItem(USER_KEY);
      window.location.href = '/login';
    };
    const timer = window.setInterval(check, 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    // Signed out in another tab (idle or by hand): this tab follows.
    const onStorage = () => {
      if (!tokenStore.get()) window.location.href = '/login';
    };
    window.addEventListener('storage', onStorage);
    return () => {
      for (const e of events) window.removeEventListener(e, active, { capture: true });
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
    };
  }, [panelUser]);

  const value = useMemo<AuthValue>(
    () => ({ loading, token, user, signIn, signOut }),
    [loading, token, user]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Returns the effective permission for a given tab key for the current user. */
export function useTabPermission(tabKey: TabKey): TabPermission {
  const { user } = useAuth();
  if (!user) return 'hidden';
  if (isAdminRole(user.role)) return 'edit';
  if (user.tabPermissions?.[tabKey]) return user.tabPermissions[tabKey]!;
  if (ADMIN_ONLY_TABS.includes(tabKey)) return 'hidden';
  return 'edit';
}
