import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import type { Tree } from './types';

export const useTree = (wsId: string | undefined) =>
  useQuery({ queryKey: ['tree', wsId], queryFn: () => get<Tree>(`/api/workspaces/${wsId}/tree`), enabled: !!wsId });

export const useNames = (wsId: string | undefined) =>
  useQuery({
    queryKey: ['names', wsId],
    queryFn: () => get<{ id: string; name: string; title: string; restricted?: boolean }[]>(`/api/workspaces/${wsId}/names`),
    enabled: !!wsId,
  });

export const useTags = (wsId: string | undefined) =>
  useQuery({ queryKey: ['tags', wsId], queryFn: () => get<{ tag: string; count: number }[]>(`/api/workspaces/${wsId}/tags`), enabled: !!wsId });
