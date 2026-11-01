import type { Queryable } from './db.js';
import { one } from './db.js';
import { forbidden, notFound } from './errors.js';

export type Role = 'viewer' | 'commenter' | 'editor' | 'admin' | 'owner';
export const ROLE_RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, admin: 4, owner: 5 };

export type Action = 'read' | 'comment' | 'edit' | 'share' | 'manage';
const NEED: Record<Action, Role> = { read: 'viewer', comment: 'commenter', edit: 'editor', share: 'editor', manage: 'admin' };

export function maxRole(roles: (string | null | undefined)[]): Role | null {
  let best: Role | null = null;
  for (const r of roles) {
    if (!r || !(r in ROLE_RANK)) continue;
    if (!best || ROLE_RANK[r as Role] > ROLE_RANK[best]) best = r as Role;
  }
  return best;
}

export function can(role: Role | null, action: Action): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[NEED[action]];
}

export function assertCan(role: Role | null, action: Action) {
  if (!role) throw notFound();
  if (!can(role, action)) throw forbidden();
}

export async function workspaceRole(db: Queryable, userId: string, workspaceId: string): Promise<Role | null> {
  const r = await one<{ owner_id: string; role: string | null }>(
    db,
    `SELECT w.owner_id, m.role FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2 WHERE w.id = $1`,
    [workspaceId, userId],
  );
  if (!r) return null;
  if (r.owner_id === userId) return 'owner';
  return maxRole([r.role]);
}

export interface DocAccess {
  role: Role | null;
  workspaceId: string;
  folderId: string | null;
  deleted: boolean;
  /** true when access comes only from a direct share (not workspace membership). */
  sharedOnly: boolean;
}

const ANCESTORS_CTE = `anc AS (
    SELECT f.id, f.parent_id FROM folders f WHERE f.id = (SELECT folder_id FROM target)
    UNION ALL
    SELECT f.id, f.parent_id FROM folders f JOIN anc ON f.id = anc.parent_id
  )`;

async function resolveAccess(db: Queryable, userId: string, kind: 'document' | 'folder', id: string): Promise<DocAccess | null> {
  const targetSql =
    kind === 'document'
      ? `SELECT id, workspace_id, folder_id, deleted_at FROM documents WHERE id = $1`
      : `SELECT id, workspace_id, parent_id AS folder_id, deleted_at FROM folders WHERE id = $1`;
  const r = await one<{ workspace_id: string; folder_id: string | null; deleted_at: Date | null; owner: boolean; member: string | null; perms: string[] }>(
    db,
    `WITH RECURSIVE target AS (${targetSql}), ${ANCESTORS_CTE}
     SELECT t.workspace_id, t.folder_id, t.deleted_at,
       (SELECT w.owner_id = $2 FROM workspaces w WHERE w.id = t.workspace_id) AS owner,
       (SELECT role FROM workspace_members WHERE workspace_id = t.workspace_id AND user_id = $2) AS member,
       ARRAY(SELECT role FROM permissions WHERE user_id = $2 AND (
         (resource_type = $3 AND resource_id = t.id) OR
         (resource_type = 'folder' AND resource_id IN (SELECT id FROM anc))
       )) AS perms
     FROM target t`,
    [id, userId, kind],
  );
  if (!r) return null;
  const memberRole = r.owner ? 'owner' : r.member;
  return {
    role: maxRole([memberRole, ...r.perms]),
    workspaceId: r.workspace_id,
    folderId: r.folder_id,
    deleted: !!r.deleted_at,
    sharedOnly: !memberRole && r.perms.length > 0,
  };
}

export const documentAccess = (db: Queryable, userId: string, docId: string) => resolveAccess(db, userId, 'document', docId);
export const folderAccess = (db: Queryable, userId: string, folderId: string) => resolveAccess(db, userId, 'folder', folderId);

/**
 * SQL fragment (a CTE named `acc`) listing every document id the user ($1) can read.
 * Use as: `WITH RECURSIVE ${ACCESSIBLE_DOCS_CTE} SELECT ... WHERE d.id IN (SELECT id FROM acc)`
 */
export const ACCESSIBLE_DOCS_CTE = `
  pf AS (
    SELECT resource_id AS id FROM permissions WHERE user_id = $1 AND resource_type = 'folder'
    UNION
    SELECT f.id FROM folders f JOIN pf ON f.parent_id = pf.id
  ),
  acc AS (
    SELECT d.id FROM documents d
      WHERE d.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $1)
    UNION SELECT resource_id FROM permissions WHERE user_id = $1 AND resource_type = 'document'
    UNION SELECT d.id FROM documents d JOIN pf ON d.folder_id = pf.id
  )`;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(id: string) {
  if (!UUID_RE.test(id)) throw notFound();
}
