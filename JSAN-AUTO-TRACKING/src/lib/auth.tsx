import * as SecureStore from 'expo-secure-store';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

import * as VehicleTracker from '@/modules/vehicle-tracker';
import { apiLogin, type AuthUser } from './api';

type AuthState = {
  loading: boolean;
  token: string | null;
  user: AuthUser | null;
};

type AuthContextValue = AuthState & {
  signIn: (email: string, password: string) => Promise<AuthUser>;
  signOut: () => Promise<void>;
};

const TOKEN_KEY = 'jsan_token';
const USER_KEY = 'jsan_user';

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ loading: true, token: null, user: null });

  useEffect(() => {
    (async () => {
      const token = await SecureStore.getItemAsync(TOKEN_KEY);
      const userStr = await SecureStore.getItemAsync(USER_KEY);
      setState({
        loading: false,
        token: token ?? null,
        user: userStr ? (JSON.parse(userStr) as AuthUser) : null,
      });
    })();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { token, user } = await apiLogin(email, password);
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
    setState({ loading: false, token, user });
    return user;
  };

  const signOut = async () => {
    try {
      await VehicleTracker.stop();
    } catch {
      // ignore — module may be unavailable on this platform
    }
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
    setState({ loading: false, token: null, user: null });
  };

  const value = useMemo<AuthContextValue>(() => ({ ...state, signIn, signOut }), [state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
