import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get } from './api';
import type { ClientConfig, Me } from './types';

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setMe: (m: Me | null) => void;
}

const Ctx = createContext<AuthState>({ me: null, loading: true, refresh: async () => {}, setMe: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();
  const refresh = async () => {
    try {
      const r = await get<{ user: Me }>('/api/auth/me');
      setMe(r.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  // drop cached data when a signed-in user signs out (not on anonymous pages, where
  // clearing would cancel in-flight public queries)
  const prevMe = useRef<Me | null>(null);
  useEffect(() => {
    if (prevMe.current && !me) qc.clear();
    prevMe.current = me;
  }, [me, qc]);
  useEffect(() => {
    const theme = me?.prefs.theme ?? 'system';
    document.documentElement.dataset.theme = theme;
  }, [me?.prefs.theme]);
  return <Ctx.Provider value={{ me, loading, refresh, setMe }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

export function useClientConfig(): ClientConfig | undefined {
  return useQuery({ queryKey: ['client-config'], queryFn: () => get<ClientConfig>('/api/client-config'), staleTime: Infinity }).data;
}
