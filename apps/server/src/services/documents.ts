import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  attributeEdit,
  authorshipLength,
  normalizeName,
  parseDocument,
  rewriteWikiLinks,
  uniform,
  type Authorship,
  type ParsedDocument,
  type Span,
} from '@folio/markdown';
import type { AppContext, AuthUser } from '../context.js';
import { tx, one, many, type Queryable } from '../db.js';
import { keys } from '../storage/index.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { documentAccess, can } from '../access.js';
import { notify } from './notifications.js';
import { actorOf } from './users.js';
import { isRestricted, newDataKey, protect, protectComment, reveal, revealComment, type Classification, type KeyedDoc } from './restricted.js';
import { safely, syncDocument } from './library.js';
import { authorshipOf, userAuthor } from './authorship.js';
import { dekContext, parse as parseEnvelope } from '../crypto/envelope.js';

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
  classification: Classification;
  dek_wrapped: string | null;
  kek_id: string | null;
  authorship: Authorship | null;
}

export interface SaveOptions {
  /** Verified spans of AI-generated text among the inserted characters. */
  claims?: Span[];
  /** Use this attribution instead of diffing (restoring a revision with its authorship). */
  authorshipOverride?: Authorship;
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
    classification: d.classification,
  };
}

export async function getDoc(q: Queryable, id: string): Promise<DocRow> {
  const d = await one<DocRow>(q, 'SELECT * FROM documents WHERE id = $1', [id]);
  if (!d) throw notFound('Document not found');
  return d;
}

/** Current content of a document, decrypted if it is stored encrypted. */
export async function readContent(ctx: AppContext, d: Pick<DocRow, 'id' | 'storage_key'>): Promise<string> {
  return readBlob(ctx, d.id, d.storage_key);
}

/** Any stored version (current or a revision) of a document, decrypted if needed. */
export async function readBlob(ctx: AppContext, docId: string, key: string): Promise<string> {
  return (await reveal(ctx, docId, await ctx.storage.get(key))).toString('utf8');
}

class ClassificationChanged extends Error {}

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
async function recordRevision(
  c: pg.PoolClient,
  doc: DocRow,
  blobKey: string,
  size: number,
  version: number,
  authorId: string,
  authorship: Authorship,
): Promise<string | null> {
  const last = await one<{ id: string; author_id: string; created_at: Date; storage_key: string }>(
    c,
    `SELECT id, author_id, created_at, storage_key FROM revisions WHERE document_id = $1 ORDER BY version DESC LIMIT 1`,
    [doc.id],
  );
  if (last && last.author_id === authorId && Date.now() - new Date(last.created_at).getTime() < REVISION_COALESCE_MINUTES * 60_000) {
    await c.query('UPDATE revisions SET version = $2, size = $3, storage_key = $4, authorship = $5 WHERE id = $1', [
      last.id,
      version,
      size,
      blobKey,
      authorship,
    ]);
    return last.storage_key;
  }
  await c.query('INSERT INTO revisions (document_id, version, storage_key, size, author_id, authorship) VALUES ($1, $2, $3, $4, $5, $6)', [
    doc.id,
    version,
    blobKey,
    size,
    authorId,
    authorship,
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

/** Write a new immutable blob for this content (encrypted when the document is restricted). */
async function putBlob(ctx: AppContext, doc: KeyedDoc & { workspace_id: string }, content: string): Promise<string> {
  const key = keys.blob(doc.workspace_id, doc.id, randomUUID());
  const body = await protect(ctx, doc, content);
  await ctx.storage.put(key, body, isRestricted(doc) ? 'application/json' : 'text/markdown; charset=utf-8');
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
      // restricted content never leaves the system in notifications or e-mails
      await notify(ctx, u.id, 'mention', {
        actor: actorOf(user),
        documentId: doc.id,
        documentName: doc.title ?? doc.name,
        excerpt: isRestricted(doc) ? undefined : excerpt,
      });
    } else if (u.id !== user.id) {
      without.push(u);
    }
  }
  await ctx.bus.publish({ type: 'doc-updated', docId: doc.id, version: doc.version, by: user.id, byName: user.displayName });
  await safely(ctx, 'sync', () => syncDocument(ctx, doc.id));
  return { doc, mentionedWithoutAccess: without };
}

export async function createDocument(
  ctx: AppContext,
  user: AuthUser,
  input: { workspaceId: string; folderId: string | null; name: string; content: string; classification?: Classification; authorship?: Authorship },
): Promise<SaveResult> {
  const name = validateName(input.name);
  const id = randomUUID();
  const classification = input.classification ?? 'standard';
  const parsed = parseDocument(input.content);
  const size = Buffer.byteLength(input.content);
  const dataKey = classification === 'restricted' ? await newDataKey(ctx, id) : null;
  const keyed = { id, workspace_id: input.workspaceId, classification, dek_wrapped: dataKey?.wrapped ?? null, kek_id: dataKey?.kekId ?? null };
  const key = await putBlob(ctx, keyed, input.content);
  const authorship =
    input.authorship && authorshipLength(input.authorship) === input.content.length ? input.authorship : uniform(input.content.length, userAuthor(user.id));
  const { doc, fresh } = await tx(ctx.db, async (c) => {
    if (input.folderId) {
      const f = await one(c, 'SELECT 1 FROM folders WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL', [input.folderId, input.workspaceId]);
      if (!f) throw badRequest('folder not found in this workspace');
    }
    let doc: DocRow;
    try {
      doc = (await one<DocRow>(
        c,
        `INSERT INTO documents (id, workspace_id, folder_id, name, title, storage_key, size, search_text, created_by, updated_by, classification, dek_wrapped, kek_id, authorship)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12, $13) RETURNING *`,
        [
          id,
          input.workspaceId,
          input.folderId,
          name,
          classification === 'restricted' ? null : parsed.title,
          key,
          size,
          classification === 'restricted' ? '' : parsed.text,
          user.id,
          classification,
          keyed.dek_wrapped,
          keyed.kek_id,
          authorship,
        ],
      ))!;
    } catch (e) {
      uniqueViolation(e, 'A document');
    }
    await recordRevision(c, doc, key, size, 1, user.id, authorship);
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

export async function saveContent(
  ctx: AppContext,
  user: AuthUser,
  docId: string,
  content: string,
  baseVersion: number | null,
  opts: SaveOptions = {},
): Promise<SaveResult> {
  // A concurrent classification change can make the pre-written blob the wrong kind
  // (plaintext for a now-restricted document); detect that under the row lock and retry.
  for (let attempt = 0; ; attempt++) {
    try {
      return await saveOnce(ctx, user, docId, content, baseVersion, opts);
    } catch (e) {
      if (!(e instanceof ClassificationChanged) || attempt >= 2) throw e;
    }
  }
}

async function saveOnce(ctx: AppContext, user: AuthUser, docId: string, content: string, baseVersion: number | null, opts: SaveOptions): Promise<SaveResult> {
  const parsed = parseDocument(content);
  const size = Buffer.byteLength(content);
  const meta = await one<KeyedDoc & { workspace_id: string }>(
    ctx.db,
    'SELECT id, workspace_id, classification, dek_wrapped, kek_id FROM documents WHERE id = $1',
    [docId],
  );
  if (!meta) throw notFound('Document not found');
  const restricted = isRestricted(meta);
  // write the new content first; the row only points at it once the transaction commits
  const key = await putBlob(ctx, meta, content);
  let replaced: (string | null)[] = [];
  const result = await tx(ctx.db, async (c) => {
    const cur = await one<DocRow>(c, 'SELECT * FROM documents WHERE id = $1 FOR UPDATE', [docId]);
    if (!cur || cur.deleted_at) throw notFound('Document not found');
    if (cur.classification !== meta.classification || cur.dek_wrapped !== meta.dek_wrapped) throw new ClassificationChanged();
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
    // who wrote what: surviving text keeps its author, new text is the saver's (or verified AI)
    const oldText = await readContent(ctx, cur);
    const authorship =
      opts.authorshipOverride && authorshipLength(opts.authorshipOverride) === content.length
        ? opts.authorshipOverride
        : attributeEdit(authorshipOf(cur, oldText.length, user.id), oldText, content, userAuthor(user.id), opts.claims);
    // restricted documents keep no plaintext in the database: no derived title, no search text
    const doc = (await one<DocRow>(
      c,
      `UPDATE documents SET version = $2, title = $3, size = $4, search_text = $5, storage_key = $6, updated_by = $7, authorship = $8, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [docId, version, restricted ? null : parsed.title, size, restricted ? '' : parsed.text, key, user.id, authorship],
    ))!;
    const coalesced = await recordRevision(c, doc, key, size, version, user.id, authorship);
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
  await safely(ctx, 'sync', () => syncDocument(ctx, docId));
  return doc;
}

export async function trashDocument(ctx: AppContext, docId: string) {
  const d = await one<DocRow>(ctx.db, 'UPDATE documents SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [docId]);
  if (!d) throw notFound();
  await ctx.db.query('UPDATE links SET target_id = NULL WHERE target_id = $1', [docId]);
  await ctx.bus.publish({ type: 'tree-changed', workspaceId: d.workspace_id });
  await safely(ctx, 'sync', () => syncDocument(ctx, docId));
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
  await safely(ctx, 'sync', () => syncDocument(ctx, docId));
  return d;
}

export async function deleteDocumentPermanently(ctx: AppContext, docId: string) {
  const d = await getDoc(ctx.db, docId);
  const revs = await many<{ storage_key: string }>(ctx.db, 'SELECT storage_key FROM revisions WHERE document_id = $1', [docId]);
  const atts = await many<{ storage_key: string }>(ctx.db, 'SELECT storage_key FROM attachments WHERE document_id = $1', [docId]);
  await ctx.db.query('DELETE FROM attachments WHERE document_id = $1', [docId]);
  await ctx.db.query('DELETE FROM documents WHERE id = $1', [docId]);
  await safely(ctx, 'sync', () => syncDocument(ctx, docId));
  for (const a of atts) await ctx.storage.delete(a.storage_key).catch(() => {});
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

/**
 * Change a document between standard and restricted. Every stored version (current content,
 * revisions), its attachments and its comments are re-written encrypted (or decrypted) in one
 * transaction; the superseded copies are deleted after commit. Restricting also removes the
 * public link and drops the plaintext search index and derived title.
 */
export async function setClassification(ctx: AppContext, user: AuthUser, docId: string, target: Classification): Promise<DocRow> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await reclassifyOnce(ctx, user, docId, target);
    } catch (e) {
      // someone saved while we were re-encrypting: start over from the new state
      if (!(e instanceof ClassificationChanged) || attempt >= 2) throw e;
    }
  }
}

async function reclassifyOnce(ctx: AppContext, user: AuthUser, docId: string, target: Classification): Promise<DocRow> {
  const cur = await getDoc(ctx.db, docId);
  if (cur.deleted_at) throw notFound('Document not found');
  if (cur.classification === target) return cur;

  const dataKey = target === 'restricted' ? await newDataKey(ctx, docId) : null;
  const keyed = { id: docId, workspace_id: cur.workspace_id, classification: target, dek_wrapped: dataKey?.wrapped ?? null, kek_id: dataKey?.kekId ?? null };
  const written: string[] = [];
  const blobMap = new Map<string, string>();
  try {
    const revs = await many<{ storage_key: string }>(ctx.db, 'SELECT storage_key FROM revisions WHERE document_id = $1', [docId]);
    for (const old of new Set([cur.storage_key, ...revs.map((r) => r.storage_key)])) {
      const next = await putBlob(ctx, keyed, await readBlob(ctx, docId, old));
      written.push(next);
      blobMap.set(old, next);
    }
    const atts = await many<{ id: string; storage_key: string; mime: string }>(ctx.db, 'SELECT id, storage_key, mime FROM attachments WHERE document_id = $1', [
      docId,
    ]);
    const attMap = new Map<string, string>();
    for (const a of atts) {
      const plain = await reveal(ctx, docId, await ctx.storage.get(a.storage_key));
      const next = `${keys.attachment(cur.workspace_id, a.id)}.${randomUUID()}`;
      await ctx.storage.put(next, await protect(ctx, keyed, plain, 'attachment'), target === 'restricted' ? 'application/json' : a.mime);
      written.push(next);
      attMap.set(a.id, next);
    }
    const comments = await many<{ id: string; body: string; anchor_text: string | null; encrypted: boolean }>(
      ctx.db,
      'SELECT id, body, anchor_text, encrypted FROM comments WHERE document_id = $1',
      [docId],
    );
    const commentBodies = new Map<string, { body: string; anchor: string | null; encrypted: boolean }>();
    for (const c of comments) {
      const body = await protectComment(ctx, keyed, await revealComment(ctx, docId, c.body, c.encrypted));
      const anchor = c.anchor_text == null ? null : (await protectComment(ctx, keyed, await revealComment(ctx, docId, c.anchor_text, c.encrypted))).body;
      commentBodies.set(c.id, { body: body.body, anchor, encrypted: body.encrypted });
    }
    const currentText = target === 'standard' ? parseDocument(await readBlob(ctx, docId, cur.storage_key)) : null;

    const doc = await tx(ctx.db, async (c) => {
      const locked = await one<DocRow>(c, 'SELECT * FROM documents WHERE id = $1 FOR UPDATE', [docId]);
      if (!locked || locked.storage_key !== cur.storage_key || locked.classification !== cur.classification) throw new ClassificationChanged();
      const doc = (await one<DocRow>(
        c,
        `UPDATE documents SET classification = $2, dek_wrapped = $3, kek_id = $4, storage_key = $5, title = $6, search_text = $7,
           created_by = COALESCE(created_by, $8)
         WHERE id = $1 RETURNING *`,
        [docId, target, keyed.dek_wrapped, keyed.kek_id, blobMap.get(cur.storage_key), currentText?.title ?? null, currentText?.text ?? '', user.id],
      ))!;
      for (const [old, next] of blobMap) await c.query('UPDATE revisions SET storage_key = $3 WHERE document_id = $1 AND storage_key = $2', [docId, old, next]);
      for (const [id, next] of attMap)
        await c.query('UPDATE attachments SET storage_key = $2, encrypted = $3 WHERE id = $1', [id, next, target === 'restricted']);
      for (const [id, v] of commentBodies)
        await c.query('UPDATE comments SET body = $2, anchor_text = $3, encrypted = $4 WHERE id = $1', [id, v.body, v.anchor, v.encrypted]);
      if (target === 'restricted') {
        await c.query('DELETE FROM public_links WHERE document_id = $1', [docId]);
        // AI generations keep their prompt and output for provenance; for a restricted document
        // those would be plaintext copies of its content, so scrub them (attribution stays)
        await c.query(`UPDATE ai_generations SET output = '', prompt = '(removed: document restricted)' WHERE document_id = $1`, [docId]);
        // whoever restricts a document must keep access to it
        if (doc.created_by !== user.id) {
          await c.query(
            `INSERT INTO permissions (resource_type, resource_id, user_id, role, created_by) VALUES ('document', $1, $2, 'editor', $2)
             ON CONFLICT (resource_type, resource_id, user_id) DO UPDATE SET role = 'editor'`,
            [docId, user.id],
          );
        }
      }
      return doc;
    });
    // the old copies (plaintext when restricting) are no longer referenced
    await collectGarbage(ctx, [...blobMap.keys(), ...atts.map((a) => a.storage_key)]);
    for (const a of atts) await ctx.storage.delete(a.storage_key).catch(() => {});
    await ctx.bus.publish({ type: 'tree-changed', workspaceId: doc.workspace_id });
    await ctx.bus.publish({ type: 'doc-updated', docId, version: doc.version, by: user.id, byName: user.displayName });
    await safely(ctx, 'sync', () => syncDocument(ctx, docId));
    return doc;
  } catch (e) {
    await collectGarbage(ctx, written);
    for (const k of written) if (k.includes('/attachments/')) await ctx.storage.delete(k).catch(() => {});
    throw e;
  }
}

/**
 * Key rotation: re-wrap a restricted document's data key with the active key-encryption key
 * and rewrite the headers of its stored files (content, revisions, attachments, comments). The
 * ciphertext itself is unchanged, so this is cheap. Returns false if already up to date.
 */
export async function rewrapDocument(ctx: AppContext, docId: string): Promise<boolean> {
  const doc = await getDoc(ctx.db, docId);
  if (!isRestricted(doc) || !doc.dek_wrapped || !doc.kek_id || doc.kek_id === ctx.keys.activeKekId) return false;
  const dek = await ctx.keys.unwrap(doc.dek_wrapped, doc.kek_id, dekContext(docId));
  const next = await ctx.keys.wrap(dek, dekContext(docId));
  const rehead = (stored: string) => {
    const env = parseEnvelope(stored);
    return JSON.stringify({ ...env, kek: next.kekId, dek: next.wrapped });
  };
  const written: string[] = [];
  const blobMap = new Map<string, string>();
  try {
    const revs = await many<{ storage_key: string }>(ctx.db, 'SELECT storage_key FROM revisions WHERE document_id = $1', [docId]);
    for (const old of new Set([doc.storage_key, ...revs.map((r) => r.storage_key)])) {
      const key = keys.blob(doc.workspace_id, docId, randomUUID());
      await ctx.storage.put(key, rehead((await ctx.storage.get(old)).toString('utf8')), 'application/json');
      written.push(key);
      blobMap.set(old, key);
    }
    const atts = await many<{ id: string; storage_key: string }>(ctx.db, 'SELECT id, storage_key FROM attachments WHERE document_id = $1 AND encrypted', [
      docId,
    ]);
    const attMap = new Map<string, string>();
    for (const a of atts) {
      const key = `${keys.attachment(doc.workspace_id, a.id)}.${randomUUID()}`;
      await ctx.storage.put(key, rehead((await ctx.storage.get(a.storage_key)).toString('utf8')), 'application/json');
      written.push(key);
      attMap.set(a.id, key);
    }
    const comments = await many<{ id: string; body: string; anchor_text: string | null }>(
      ctx.db,
      'SELECT id, body, anchor_text FROM comments WHERE document_id = $1 AND encrypted',
      [docId],
    );
    await tx(ctx.db, async (c) => {
      const locked = await one<DocRow>(c, 'SELECT * FROM documents WHERE id = $1 FOR UPDATE', [docId]);
      if (!locked || locked.storage_key !== doc.storage_key || locked.dek_wrapped !== doc.dek_wrapped) throw new ClassificationChanged();
      await c.query('UPDATE documents SET dek_wrapped = $2, kek_id = $3, storage_key = $4 WHERE id = $1', [
        docId,
        next.wrapped,
        next.kekId,
        blobMap.get(doc.storage_key),
      ]);
      for (const [old, key] of blobMap) await c.query('UPDATE revisions SET storage_key = $3 WHERE document_id = $1 AND storage_key = $2', [docId, old, key]);
      for (const [id, key] of attMap) await c.query('UPDATE attachments SET storage_key = $2 WHERE id = $1', [id, key]);
      for (const cm of comments) {
        await c.query('UPDATE comments SET body = $2, anchor_text = $3 WHERE id = $1', [
          cm.id,
          rehead(cm.body),
          cm.anchor_text == null ? null : rehead(cm.anchor_text),
        ]);
      }
    });
    await collectGarbage(ctx, [...blobMap.keys()]);
    for (const a of atts) await ctx.storage.delete(a.storage_key).catch(() => {});
    await safely(ctx, 'sync', () => syncDocument(ctx, docId));
    return true;
  } catch (e) {
    await collectGarbage(ctx, written);
    for (const k of written) if (k.includes('/attachments/')) await ctx.storage.delete(k).catch(() => {});
    throw e;
  }
}
