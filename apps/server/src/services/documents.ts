import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { parseDocument, rewriteWikiLinks, normalizeName, type ParsedDocument } from '@folio/markdown';
import type { AppContext, AuthUser } from '../context.js';
import { tx, one, many, type Queryable } from '../db.js';
import { keys } from '../storage/index.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { documentAccess, can } from '../access.js';
import { notify } from './notifications.js';
import { actorOf } from './users.js';

export interface DocRow {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  name: string;
  title: string | null;
  version: number;
  storage_key: string;
  size: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/** Revisions by the same author within this window are coalesced into one. */
const REVISION_COALESCE_MINUTES = 10;

export function validateName(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('name is required');
  const name = raw.replace(/\.md$/i, '').trim();
  if (!name) throw badRequest('name must not be empty');
  if (name.length > 200) throw badRequest('name is too long (max 200 characters)');
  if (/[\/\\\u0000-\u001f]|^\.+$|[\[\]|#^]/.test(name)) throw badRequest('name contains invalid characters (/ \\ [ ] | # ^)');
  return name;
}

export function serializeDoc(d: DocRow) {
  return {
    id: d.id,
    workspaceId: d.workspace_id,
    folderId: d.folder_id,
    name: d.name,
    title: d.title ?? d.name,
    version: d.version,
    size: d.size,
    createdBy: d.created_by,
    updatedBy: d.updated_by,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    deletedAt: d.deleted_at,
  };
}

export async function getDoc(q: Queryable, id: string): Promise<DocRow> {
  const d = await one<DocRow>(q, 'SELECT * FROM documents WHERE id = $1', [id]);
  if (!d) throw notFound('Document not found');
  return d;
}

export async function readContent(ctx: AppContext, d: DocRow): Promise<string> {
  return (await ctx.storage.get(d.storage_key)).toString('utf8');
}

function uniqueViolation(e: any, what: string): never {
  if (e?.code === '23505') throw conflict(`${what} with this name already exists here`);
  throw e;
}

/**
 * Refresh link/tag/mention index rows for a document. Returns the user ids of
 * users who were mentioned for the first time in this save.
 */
async function reindex(c: pg.PoolClient, doc: { id: string; workspace_id: string }, parsed: ParsedDocument): Promise<{ id: string; username: string }[]> {
  await c.query('DELETE FROM links WHERE source_id = $1', [doc.id]);
  if (parsed.links.length) {
    const names = parsed.links.map((l) => l.target || '');
    await c.query(
      `INSERT INTO links (source_id, target_name, target_id, anchor, position)
       SELECT $1, t.name, (SELECT d.id FROM documents d WHERE d.workspace_id = $2 AND d.deleted_at IS NULL AND lower(d.name) = lower(t.name) ORDER BY d.created_at LIMIT 1), t.anchor, t.pos
       FROM unnest($3::text[], $4::text[], $5::int[]) AS t(name, anchor, pos)
       WHERE t.name <> ''`,
      [doc.id, doc.workspace_id, names, parsed.links.map((l) => l.anchor), parsed.links.map((l) => l.start)],
    );
  }
  await c.query('DELETE FROM doc_tags WHERE document_id = $1', [doc.id]);
  if (parsed.tags.length) {
    await c.query('INSERT INTO doc_tags (document_id, tag) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [doc.id, parsed.tags]);
  }
  const mentioned = parsed.mentions.length
    ? await many<{ id: string; username: string }>(c, 'SELECT id, username FROM users WHERE lower(username) = ANY($1) AND disabled_at IS NULL', [
        parsed.mentions,
      ])
    : [];
  const existing = new Set((await many<{ user_id: string }>(c, 'SELECT user_id FROM mentions WHERE document_id = $1', [doc.id])).map((r) => r.user_id));
  const fresh = mentioned.filter((u) => !existing.has(u.id));
  const keep = mentioned.map((u) => u.id);
  await c.query('DELETE FROM mentions WHERE document_id = $1 AND NOT (user_id = ANY($2::uuid[]))', [doc.id, keep]);
  if (fresh.length) {
    await c.query('INSERT INTO mentions (document_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING', [doc.id, fresh.map((u) => u.id)]);
  }
  return fresh;
}

/** Point dangling links that reference `name` at this document. */
async function adoptDanglingLinks(c: pg.PoolClient, doc: { id: string; workspace_id: string; name: string }) {
  await c.query(
    `UPDATE links l SET target_id = $1 FROM documents s
     WHERE l.source_id = s.id AND s.workspace_id = $2 AND l.target_id IS NULL AND lower(l.target_name) = lower($3)`,
    [doc.id, doc.workspace_id, doc.name],
  );
}

/**
 * Record the blob a save produced as a revision. Saves by the same author within the coalescing
 * window replace the latest revision instead of adding one; the blob it pointed to is returned so
 * the caller can delete it once the transaction has committed.
 */
async function recordRevision(c: pg.PoolClient, doc: DocRow, blobKey: string, size: number, version: number, authorId: string): Promise<string | null> {
  const last = await one<{ id: string; author_id: string; created_at: Date; storage_key: string }>(
    c,
    `SELECT id, author_id, created_at, storage_key FROM revisions WHERE document_id = $1 ORDER BY version DESC LIMIT 1`,
    [doc.id],
  );
  if (last && last.author_id === authorId && Date.now() - new Date(last.created_at).getTime() < REVISION_COALESCE_MINUTES * 60_000) {
    await c.query('UPDATE revisions SET version = $2, size = $3, storage_key = $4 WHERE id = $1', [last.id, version, size, blobKey]);
    return last.storage_key;
  }
  await c.query('INSERT INTO revisions (document_id, version, storage_key, size, author_id) VALUES ($1, $2, $3, $4, $5)', [
    doc.id,
    version,
    blobKey,
    size,
    authorId,
  ]);
  return null;
}

/** Delete blobs that are no longer referenced by any document or revision (best effort). */
async function collectGarbage(ctx: AppContext, candidates: (string | null | undefined)[]) {
  for (const key of new Set(candidates.filter((k): k is string => !!k))) {
    try {
      const used = await one(ctx.db, 'SELECT 1 FROM documents WHERE storage_key = $1 UNION ALL SELECT 1 FROM revisions WHERE storage_key = $1 LIMIT 1', [key]);
      if (!used) await ctx.storage.delete(key);
    } catch (err) {
      ctx.log.warn({ err, key }, 'failed to delete unreferenced blob');
    }
  }
}

/** Write a new immutable blob for this content. */
async function putBlob(ctx: AppContext, workspaceId: string, docId: string, content: string): Promise<string> {
  const key = keys.blob(workspaceId, docId, randomUUID());
  await ctx.storage.put(key, content, 'text/markdown; charset=utf-8');
  return key;
}

export interface SaveResult {
  doc: DocRow;
  mentionedWithoutAccess: { id: string; username: string }[];
}

async function afterSave(ctx: AppContext, user: AuthUser, doc: DocRow, fresh: { id: string; username: string }[], excerptSource: string): Promise<SaveResult> {
  const without: { id: string; username: string }[] = [];
  for (const u of fresh) {
    const access = await documentAccess(ctx.db, u.id, doc.id);
    if (access && can(access.role, 'read')) {
      const idx = excerptSource.toLowerCase().indexOf(`@${u.username.toLowerCase()}`);
      const excerpt =
        idx >= 0
          ? excerptSource
              .slice(Math.max(0, idx - 60), idx + 80)
              .replace(/\s+/g, ' ')
              .trim()
          : undefined;
      await notify(ctx, u.id, 'mention', { actor: actorOf(user), documentId: doc.id, documentName: doc.title ?? doc.name, excerpt });
    } else if (u.id !== user.id) {
      without.push(u);
    }
  }
  await ctx.bus.publish({ type: 'doc-updated', docId: doc.id, version: doc.version, by: user.id, byName: user.displayName });
  return { doc, mentionedWithoutAccess: without };
}

export async function createDocument(
  ctx: AppContext,
  user: AuthUser,
  input: { workspaceId: string; folderId: string | null; name: string; content: string },
): Promise<SaveResult> {
  const name = validateName(input.name);
  const id = randomUUID();
  const parsed = parseDocument(input.content);
  const size = Buffer.byteLength(input.content);
  const key = await putBlob(ctx, input.workspaceId, id, input.content);
  const { doc, fresh } = await tx(ctx.db, async (c) => {
    if (input.folderId) {
      const f = await one(c, 'SELECT 1 FROM folders WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL', [input.folderId, input.workspaceId]);
      if (!f) throw badRequest('folder not found in this workspace');
    }
    let doc: DocRow;
    try {
      doc = (await one<DocRow>(
        c,
        `INSERT INTO documents (id, workspace_id, folder_id, name, title, storage_key, size, search_text, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
        [id, input.workspaceId, input.folderId, name, parsed.title, key, size, parsed.text, user.id],
      ))!;
    } catch (e) {
      uniqueViolation(e, 'A document');
    }
    await recordRevision(c, doc, key, size, 1, user.id);
    const fresh = await reindex(c, doc, parsed);
    await adoptDanglingLinks(c, doc);
    return { doc, fresh };
  }).catch(async (e) => {
    await collectGarbage(ctx, [key]);
    throw e;
  });
  await ctx.bus.publish({ type: 'tree-changed', workspaceId: doc.workspace_id });
  return afterSave(ctx, user, doc, fresh, input.content);
}

export async function saveContent(ctx: AppContext, user: AuthUser, docId: string, content: string, baseVersion: number | null): Promise<SaveResult> {
  const parsed = parseDocument(content);
  const size = Buffer.byteLength(content);
  const meta = await one<{ workspace_id: string }>(ctx.db, 'SELECT workspace_id FROM documents WHERE id = $1', [docId]);
  if (!meta) throw notFound('Document not found');
  // write the new content first; the row only points at it once the transaction commits
  const key = await putBlob(ctx, meta.workspace_id, docId, content);
  let replaced: (string | null)[] = [];
  const result = await tx(ctx.db, async (c) => {
    const cur = await one<DocRow>(c, 'SELECT * FROM documents WHERE id = $1 FOR UPDATE', [docId]);
    if (!cur || cur.deleted_at) throw notFound('Document not found');
    if (baseVersion != null && cur.version !== baseVersion) {
      const current = await readContent(ctx, cur);
      throw conflict('The document was changed by someone else', {
        version: cur.version,
        content: current,
        updatedBy: cur.updated_by,
        updatedAt: cur.updated_at,
      });
    }
    const version = cur.version + 1;
    const doc = (await one<DocRow>(
      c,
      `UPDATE documents SET version = $2, title = $3, size = $4, search_text = $5, storage_key = $6, updated_by = $7, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [docId, version, parsed.title, size, parsed.text, key, user.id],
    ))!;
    const coalesced = await recordRevision(c, doc, key, size, version, user.id);
    replaced = [cur.storage_key, coalesced];
    const fresh = await reindex(c, doc, parsed);
    return { doc, fresh };
  }).catch(async (e) => {
    await collectGarbage(ctx, [key]);
    throw e;
  });
  await collectGarbage(ctx, replaced);
  return afterSave(ctx, user, result.doc, result.fresh, content);
}

/**
 * Rename and/or move a document. On rename, every `[[Old Name]]` reference in
 * other documents of the workspace is rewritten to the new name.
 */
export async function updateDocumentMeta(ctx: AppContext, user: AuthUser, docId: string, patch: { name?: string; folderId?: string | null }): Promise<DocRow> {
  const cur = await getDoc(ctx.db, docId);
  if (cur.deleted_at) throw notFound('Document not found');
  const newName = patch.name !== undefined ? validateName(patch.name) : cur.name;
  const newFolder = patch.folderId !== undefined ? patch.folderId : cur.folder_id;
  if (newFolder) {
    const f = await one(ctx.db, 'SELECT 1 FROM folders WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL', [newFolder, cur.workspace_id]);
    if (!f) throw badRequest('folder not found in this workspace');
  }
  let doc: DocRow;
  try {
    doc = (await one<DocRow>(ctx.db, 'UPDATE documents SET name = $2, folder_id = $3, updated_at = now() WHERE id = $1 RETURNING *', [
      docId,
      newName,
      newFolder,
    ]))!;
  } catch (e) {
    uniqueViolation(e, 'A document');
  }
  if (normalizeName(newName) !== normalizeName(cur.name)) {
    const sources = await many<{ id: string }>(
      ctx.db,
      `SELECT DISTINCT l.source_id AS id FROM links l JOIN documents s ON s.id = l.source_id
       WHERE l.target_id = $1 AND s.deleted_at IS NULL AND s.id <> $1`,
      [docId],
    );
    for (const s of sources) {
      const sd = await getDoc(ctx.db, s.id);
      const before = await readContent(ctx, sd);
      const after = rewriteWikiLinks(before, cur.name, newName);
      if (after !== before) await saveContent(ctx, user, sd.id, after, null);
    }
    // links that still carry the old name (e.g. from the doc itself) keep pointing at the id
    await ctx.db.query('UPDATE links SET target_name = $2 WHERE target_id = $1', [docId, newName]);
    await tx(ctx.db, (c) => adoptDanglingLinks(c, doc));
  } else if (cur.name !== newName) {
    await ctx.db.query('UPDATE links SET target_name = $2 WHERE target_id = $1', [docId, newName]);
  }
  await ctx.bus.publish({ type: 'tree-changed', workspaceId: doc.workspace_id });
  return doc;
}

export async function trashDocument(ctx: AppContext, docId: string) {
  const d = await one<DocRow>(ctx.db, 'UPDATE documents SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [docId]);
  if (!d) throw notFound();
  await ctx.db.query('UPDATE links SET target_id = NULL WHERE target_id = $1', [docId]);
  await ctx.bus.publish({ type: 'tree-changed', workspaceId: d.workspace_id });
}

export async function restoreDocument(ctx: AppContext, docId: string): Promise<DocRow> {
  const cur = await getDoc(ctx.db, docId);
  if (!cur.deleted_at) return cur;
  // restore into the root if the original folder is gone or trashed
  const folderOk = cur.folder_id ? await one(ctx.db, 'SELECT 1 FROM folders WHERE id = $1 AND deleted_at IS NULL', [cur.folder_id]) : true;
  let d: DocRow;
  try {
    d = (await one<DocRow>(ctx.db, 'UPDATE documents SET deleted_at = NULL, folder_id = $2 WHERE id = $1 RETURNING *', [
      docId,
      folderOk ? cur.folder_id : null,
    ]))!;
  } catch (e) {
    uniqueViolation(e, 'A document');
  }
  await tx(ctx.db, (c) => adoptDanglingLinks(c, d));
  await ctx.bus.publish({ type: 'tree-changed', workspaceId: d.workspace_id });
  return d;
}

export async function deleteDocumentPermanently(ctx: AppContext, docId: string) {
  const d = await getDoc(ctx.db, docId);
  const revs = await many<{ storage_key: string }>(ctx.db, 'SELECT storage_key FROM revisions WHERE document_id = $1', [docId]);
  await ctx.db.query('DELETE FROM documents WHERE id = $1', [docId]);
  const blobs = [...new Set([d.storage_key, ...revs.map((r) => r.storage_key)])];
  const results = await Promise.allSettled(blobs.map((k) => ctx.storage.delete(k)));
  for (const r of results) if (r.status === 'rejected') ctx.log.warn({ err: r.reason, docId }, 'failed to delete blob of a deleted document');
}

/** Find a free document name in a folder: "Name", "Name 2", "Name 3", ... */
export async function freeName(q: Queryable, workspaceId: string, folderId: string | null, base: string): Promise<string> {
  const rows = await many<{ name: string }>(
    q,
    `SELECT lower(name) AS name FROM documents WHERE workspace_id = $1 AND folder_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL AND lower(name) LIKE lower($3) || '%'`,
    [workspaceId, folderId, base],
  );
  const taken = new Set(rows.map((r) => r.name));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}
