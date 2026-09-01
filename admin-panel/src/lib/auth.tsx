import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, tokenStore } from './api';
import type { TabKey, TabPermission, User } from './types';
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
    if (!['admin', 'manager', 'team_lead', 'user'].includes(u.role)) {
      throw new Error('Invalid account role.');
    }
    tokenStore.set(t);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
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
  if (user.role === 'admin') return 'edit';
  if (user.tabPermissions?.[tabKey]) return user.tabPermissions[tabKey]!;
  if (ADMIN_ONLY_TABS.includes(tabKey)) return 'hidden';
  return 'edit';
}
