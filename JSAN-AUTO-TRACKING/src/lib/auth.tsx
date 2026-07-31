import * as SecureStore from 'expo-secure-store';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import * as VehicleTracker from '@/modules/vehicle-tracker';
import { apiLogin, apiLogout, apiMe, apiUpdateTimezone, type AuthUser } from './api';
import { deviceTimezone } from './timezone';

type AuthState = {
  loading: boolean;
  token: string | null;
  user: AuthUser | null;
};

type AuthContextValue = AuthState & {
  signIn: (email: string, password: string) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
  syncTimezone: () => Promise<void>;
};

/**
 * Seed a timezone for an account that has none yet.
 *
 * THE SERVER DERIVES THE REAL ZONE FROM THE DRIVER'S COORDINATES on the first location it
 * receives, and that always wins — a handset can be pinned to the driver's home country while
 * they work abroad, so the phone is the weaker signal.
 *
 * This exists only to close the gap before the first GPS point arrives, so a driver who has
 * signed in but not yet driven is not a blank row on the panel. Once the account has any zone,
 * this stays out of the way rather than fighting the coordinate-derived one.
 *
 * The driver is never asked. Returns the user unchanged on failure.
 */
async function pushTimezone(token: string, user: AuthUser): Promise<AuthUser> {
  if (user.timezone) return user; // coordinates own it from here
  const tz = deviceTimezone();
  if (!tz) return user;
  try {
    const res = await apiUpdateTimezone(token, { timezone: tz });
    // Keep the native module in step, so sunrise/sunset is computed for where they now are.
    try { await VehicleTracker.setTimezone(tz); } catch { /* module absent on this platform */ }
    return res.user ?? { ...user, timezone: tz };
  } catch {
    return user; // offline or rejected — retried on the next foreground
  }
}

const TOKEN_KEY = 'jsan_token';
const USER_KEY = 'jsan_user';

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ loading: true, token: null, user: null });

  // The foreground listener below is registered once, so it would otherwise capture the very
  // first (signed-out) state forever. This ref keeps it reading the live values.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Holds the current syncTimezone so the once-registered listener always calls the live one.
  const syncTimezoneRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    (async () => {
      const token = await SecureStore.getItemAsync(TOKEN_KEY);
      const userStr = await SecureStore.getItemAsync(USER_KEY);
      const restored = userStr ? (JSON.parse(userStr) as AuthUser) : null;
      setState({ loading: false, token: token ?? null, user: restored });

      // Cold start with a saved session never passes through signIn, and AppState does not
      // fire on first mount — so without this, relaunching the app (the common case) would
      // never re-check the zone. Values are passed explicitly because the state set above
      // has not landed yet.
      if (token && restored) {
        const updated = await pushTimezone(token, restored);
        if (updated.timezone !== restored.timezone) {
          await SecureStore.setItemAsync(USER_KEY, JSON.stringify(updated));
          setState((prev) => ({ ...prev, user: updated }));
        }
      }
    })();
  }, []);

  // Re-check on every return to the foreground. A driver who crosses into another zone — or
  // whose phone only picks up the new one from the network hours later — reports the change
  // without anyone having to open a settings screen.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void syncTimezoneRef.current();
    });
    return () => sub.remove();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { token, user } = await apiLogin(email, password);
    // Detect and persist the timezone as part of signing in, awaited on purpose: the router
    // sends drivers without one to the manual setup screen, and resolving it here means that
    // screen simply never appears. Login already proved the network works.
    const synced = await pushTimezone(token, user);
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(synced));
    setState({ loading: false, token, user: synced });
    return synced;
  };

  const syncTimezone = async () => {
    const { token, user } = stateRef.current;
    if (!token || !user) return;
    const updated = await pushTimezone(token, user);
    if (updated.timezone !== user.timezone) {
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(updated));
      setState((prev) => ({ ...prev, user: updated }));
    }
  };
  syncTimezoneRef.current = syncTimezone;

  const refreshUser = async () => {
    if (!state.token) return;
    try {
      const { user } = await apiMe(state.token);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
      setState((prev) => ({ ...prev, user }));
    } catch { /* offline — keep local copy */ }
  };

  const signOut = async () => {
    try {
      await VehicleTracker.stop();
    } catch {
      // ignore — module may be unavailable on this platform
    }
    // Release the single-active-session lock so this driver can sign in again.
    if (state.token) {
      try { await apiLogout(state.token); } catch { /* offline — session frees on idle timeout */ }
    }
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
    setState({ loading: false, token: null, user: null });
  };

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, signIn, signOut, refreshUser, syncTimezone }),
    [state]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
