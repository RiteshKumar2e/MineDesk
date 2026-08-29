import type { LoginResult, PublicUser } from '@minedesk/types';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, bootstrapSession, setAccessToken } from './apiClient';

interface AuthContextValue {
  user: PublicUser | null;
  /** True while the initial silent-refresh bootstrap is in flight. */
  loading: boolean;
  login: (email: string, password: string, totp?: string) => Promise<LoginResult>;
  completeTwoFactor: (challengeToken: string, code: string) => Promise<void>;
  register: (email: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    const res = await api.get<{ user: PublicUser }>('/api/v1/auth/me');
    setUser(res.user);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hasSession = await bootstrapSession();
      if (hasSession && !cancelled) {
        try {
          await refreshUser();
        } catch {
          setUser(null);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshUser]);

  const login = useCallback(async (email: string, password: string, totp?: string) => {
    const res = await api.post<LoginResult>('/api/v1/auth/login', { email, password, totp });
    if (res.accessToken) {
      setAccessToken(res.accessToken);
      if (res.user) setUser(res.user);
    }
    return res;
  }, []);

  const completeTwoFactor = useCallback(async (challengeToken: string, code: string) => {
    const res = await api.post<{ user: PublicUser; accessToken: string }>('/api/v1/auth/login/2fa', {
      challengeToken,
      code,
    });
    setAccessToken(res.accessToken);
    setUser(res.user);
  }, []);

  const register = useCallback(async (email: string, name: string, password: string) => {
    const res = await api.post<{ user: PublicUser; accessToken: string }>('/api/v1/auth/register', {
      email,
      name,
      password,
    });
    setAccessToken(res.accessToken);
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } finally {
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, completeTwoFactor, register, logout, refreshUser }),
    [user, loading, login, completeTwoFactor, register, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
