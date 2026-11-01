import type { Role } from './types';

const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, admin: 4, owner: 5 };
const NEED = { read: 'viewer', comment: 'commenter', edit: 'editor', share: 'editor', manage: 'admin' } as const;

export function can(role: Role | null | undefined, action: keyof typeof NEED): boolean {
  return !!role && RANK[role] >= RANK[NEED[action]];
}
