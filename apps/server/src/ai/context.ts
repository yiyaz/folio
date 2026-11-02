import type { AppContext, AuthUser } from '../context.js';
import { ACCESSIBLE_DOCS_CTE, can, documentAccess } from '../access.js';
import { many } from '../db.js';
import { getDoc, readContent } from '../services/documents.js';
import type { ContextDocument } from './provider.js';

export interface ContextSelection {
  /** Specific documents, in priority order. */
  documentIds?: string[];
  /** Every document in this folder and its sub-folders. */
  folderId?: string;
  /** Every document in the workspace the user can read. */
  workspace?: boolean;
}

export interface OmittedDocument {
  id: string | null;
  name: string | null;
  reason: 'restricted' | 'no-access' | 'too-large' | 'limit';
}

const MAX_DOCUMENTS = 200;

/**
 * Assemble the documents to share with the model. Only documents the user can read are used,
 * restricted documents never are, and anything left out (budget, limits) is reported back to
 * the caller rather than silently dropped.
 */
export async function buildContext(
  ctx: AppContext,
  user: AuthUser,
  workspaceId: string,
  sel: ContextSelection,
  budgetChars = ctx.cfg.AI_CONTEXT_MAX_CHARS,
): Promise<{ docs: ContextDocument[]; omitted: OmittedDocument[]; chars: number }> {
  const ids: string[] = [...new Set(sel.documentIds ?? [])];
  if (sel.folderId) {
    const rows = await many<{ id: string }>(
      ctx.db,
      `WITH RECURSIVE sub AS (SELECT id FROM folders WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
         UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id WHERE f.deleted_at IS NULL)
       SELECT d.id FROM documents d WHERE d.folder_id IN (SELECT id FROM sub) AND d.deleted_at IS NULL ORDER BY d.updated_at DESC`,
      [sel.folderId, workspaceId],
    );
    ids.push(...rows.map((r) => r.id));
  }
  if (sel.workspace) {
    const rows = await many<{ id: string }>(
      ctx.db,
      `WITH RECURSIVE ${ACCESSIBLE_DOCS_CTE}
       SELECT d.id FROM documents d WHERE d.workspace_id = $2 AND d.deleted_at IS NULL AND d.id IN (SELECT id FROM acc) ORDER BY d.updated_at DESC`,
      [user.id, workspaceId],
    );
    ids.push(...rows.map((r) => r.id));
  }

  const docs: ContextDocument[] = [];
  const omitted: OmittedDocument[] = [];
  let chars = 0;
  for (const id of [...new Set(ids)]) {
    const a = await documentAccess(ctx.db, user.id, id).catch(() => null);
    if (!a || a.deleted || !can(a.role, 'read')) {
      omitted.push({ id: null, name: null, reason: 'no-access' }); // don't reveal what it was
      continue;
    }
    const d = await getDoc(ctx.db, id);
    if (a.restricted) {
      omitted.push({ id, name: d.name, reason: 'restricted' });
      continue;
    }
    if (docs.length >= MAX_DOCUMENTS) {
      omitted.push({ id, name: d.name, reason: 'limit' });
      continue;
    }
    const content = await readContent(ctx, d);
    if (chars + content.length > budgetChars) {
      omitted.push({ id, name: d.name, reason: 'too-large' });
      continue;
    }
    chars += content.length;
    docs.push({ id, name: d.name, content });
  }
  return { docs, omitted, chars };
}
