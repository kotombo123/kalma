import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, refresh, setToken, type Session } from './api.ts';
import type { Me } from './types.ts';

interface AuthState {
  /** null while the first refresh is in flight */
  ready: boolean;
  me: Me | undefined;
  login(email: string, password: string): Promise<void>;
  register(body: { orgName: string; name: string; email: string; password: string }): Promise<void>;
  loginAs(email: string): Promise<void>;
  acceptInvite(token: string, body: { name?: string; password: string }): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    refresh().then((token) => {
      setSignedIn(Boolean(token));
      setReady(true);
    });
  }, []);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), enabled: signedIn });

  const start = useCallback(
    (s: Session) => {
      setToken(s.accessToken);
      qc.clear();
      setSignedIn(true);
    },
    [qc],
  );

  const value: AuthState = {
    ready: ready && (!signedIn || !me.isPending),
    me: signedIn ? me.data : undefined,
    login: async (email, password) =>
      start(await api<Session>('/auth/login', { method: 'POST', body: { email, password } })),
    register: async (body) => start(await api<Session>('/auth/register', { method: 'POST', body })),
    loginAs: async (email) => start(await api<Session>('/dev/login-as', { method: 'POST', body: { email } })),
    acceptInvite: async (token, body) =>
      start(await api<Session>(`/invites/${token}/accept`, { method: 'POST', body })),
    logout: async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
      setToken(null);
      setSignedIn(false);
      qc.clear();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
