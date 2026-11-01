import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import type { Workspace } from './types';

interface WsState {
  workspaces: Workspace[];
  current: Workspace | null;
  setCurrentId: (id: string) => void;
}

const Ctx = createContext<WsState>({ workspaces: [], current: null, setCurrentId: () => {} });
const KEY = 'folio.workspace';

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { data: workspaces = [] } = useQuery({ queryKey: ['workspaces'], queryFn: () => get<Workspace[]>('/api/workspaces') });
  const [currentId, setCurrentIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const setCurrentId = (id: string) => {
    setCurrentIdState(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* private mode */
    }
  };
  const current = useMemo(() => workspaces.find((w) => w.id === currentId) ?? workspaces[0] ?? null, [workspaces, currentId]);
  useEffect(() => {
    if (current && current.id !== currentId) setCurrentIdState(current.id);
  }, [current, currentId]);
  return <Ctx.Provider value={{ workspaces, current, setCurrentId }}>{children}</Ctx.Provider>;
}

export const useWorkspace = () => useContext(Ctx);
