import { createHash } from 'node:crypto';
import type { AppContext } from '../context.js';
import { many, one } from '../db.js';
import { renderLibraryEntry } from './restricted.js';

/**
 * The library is a human-readable mirror of every workspace in storage:
 *
 *   library/<Workspace name> (<id8>)/_manifest.json
 *   library/<Workspace name> (<id8>)/<Folder>/<Sub folder>/<Document>.md
 *
 * Each file holds the latest content of a document with its stable id in the front matter, so
 * the folder can be read, copied, re-imported (`folio push`) or restored without the
 * application or its database. Restricted documents are written encrypted
 * (`*.md.folio-encrypted`, see services/restricted.ts).
 *
 * The authoritative content stays in the immutable blobs (workspaces/<id>/blobs/...). The
 * library is derived: it is updated after every change and reconciled periodically, so it heals
 * itself after crashes or partial failures.
 */
export const LIBRARY_ROOT = 'library/';
export const MANIFEST = '_manifest.json';
const MAX_SEGMENT = 120;

/** Make a name safe as a path segment on Linux, macOS, Windows and S3 consoles. */
export function sanitizeSegment(name: string): string {
  let s = name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, ''); // Windows forbids trailing dots and spaces
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  if (!s || s === '.' || s === '..') s = '_';
  return s.length > MAX_SEGMENT ? s.slice(0, MAX_SEGMENT).trimEnd() : s;
}

export function workspaceDir(workspace: { id: string; name: string }): string {
  return `${LIBRARY_ROOT}${sanitizeSegment(workspace.name)} (${workspace.id.slice(0, 8)})/`;
}

interface DocInfo {
  id: string;
  workspace_id: string;
  ws_name: string;
  name: string;
  folder_id: string | null;
  storage_key: string;
  deleted_at: Date | null;
  classification: string;
}

async function folderPath(ctx: AppContext, folderId: string | null): Promise<string[]> {
  if (!folderId) return [];
  const rows = await many<{ name: string }>(
    ctx.db,
    `WITH RECURSIVE anc AS (SELECT id, parent_id, name, 0 AS depth FROM folders WHERE id = $1
       UNION ALL SELECT f.id, f.parent_id, f.name, anc.depth + 1 FROM folders f JOIN anc ON f.id = anc.parent_id)
     SELECT name FROM anc ORDER BY depth DESC`,
    [folderId],
  );
  return rows.map((r) => sanitizeSegment(r.name));
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type SyncResult = 'created' | 'updated' | 'moved' | 'unchanged' | 'removed' | 'skipped';

/** Bring one document's library file up to date (or remove it if the document is gone). */
export async function syncDocument(ctx: AppContext, docId: string): Promise<SyncResult> {
  if (!ctx.cfg.LIBRARY_ENABLED) return 'skipped';
  const doc = await one<DocInfo>(
    ctx.db,
    `SELECT d.id, d.workspace_id, w.name AS ws_name, d.name, d.folder_id, d.storage_key, d.deleted_at, d.classification
     FROM documents d JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = $1`,
    [docId],
  );
  const entry = await one<{ key: string; source_hash: string; workspace_id: string }>(
    ctx.db,
    'SELECT key, source_hash, workspace_id FROM library_entries WHERE document_id = $1',
    [docId],
  );

  if (!doc || doc.deleted_at) {
    if (!entry) return 'unchanged';
    await ctx.storage.delete(entry.key);
    await ctx.db.query('DELETE FROM library_entries WHERE document_id = $1', [docId]);
    await writeManifest(ctx, entry.workspace_id);
    return 'removed';
  }

  const content = (await ctx.storage.get(doc.storage_key)).toString('utf8');
  const plain = await renderLibraryEntry(ctx, doc, content);
  const sourceHash = sha256(`${doc.classification}\u0000${content}`);
  const dir = workspaceDir({ id: doc.workspace_id, name: doc.ws_name });
  const segments = await folderPath(ctx, doc.folder_id);
  const base = `${dir}${segments.map((s) => `${s}/`).join('')}${sanitizeSegment(doc.name)}`;
  let key = `${base}${plain.suffix}`;
  // sanitising can make two names collide ("a:b" and "a_b"); disambiguate with the id
  const clash = await one(ctx.db, 'SELECT 1 FROM library_entries WHERE workspace_id = $1 AND lower(key) = lower($2) AND document_id <> $3', [
    doc.workspace_id,
    key,
    doc.id,
  ]);
  if (clash) key = `${base} (${doc.id.slice(0, 8)})${plain.suffix}`;

  if (entry && entry.key === key && entry.source_hash === sourceHash) return 'unchanged';
  await ctx.storage.put(key, plain.body, plain.contentType);
  if (entry && entry.key !== key) await ctx.storage.delete(entry.key);
  await ctx.db.query(
    `INSERT INTO library_entries (document_id, workspace_id, key, source_hash, synced_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (document_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, key = EXCLUDED.key, source_hash = EXCLUDED.source_hash, synced_at = now()`,
    [doc.id, doc.workspace_id, key, sourceHash],
  );
  const result: SyncResult = !entry ? 'created' : entry.key !== key ? 'moved' : 'updated';
  if (result !== 'updated') await writeManifest(ctx, doc.workspace_id);
  return result;
}

/** Write the workspace's _manifest.json: what every library file is and how to restore it. */
export async function writeManifest(ctx: AppContext, workspaceId: string) {
  const ws = await one<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM workspaces WHERE id = $1', [workspaceId]);
  if (!ws) return;
  const dir = workspaceDir(ws);
  const docs = await many<{ id: string; name: string; title: string | null; key: string; classification: string; folder_id: string | null }>(
    ctx.db,
    `SELECT d.id, d.name, d.title, e.key, d.classification, d.folder_id FROM library_entries e JOIN documents d ON d.id = e.document_id
     WHERE e.workspace_id = $1 AND d.deleted_at IS NULL ORDER BY e.key`,
    [workspaceId],
  );
  const manifest = {
    format: 'folio-library/1',
    workspace: { id: ws.id, name: ws.name },
    generatedAt: new Date().toISOString(),
    about:
      'Human-readable copy of every document in this workspace (latest version). Files carry their document id in front matter, ' +
      'so this folder can be re-imported with "folio push" or the workspace import. Version history lives in the application. ' +
      'Restricted documents are stored as *.md.folio-encrypted; decrypt them with "node dist/admin-cli.js decrypt <file>" and the deployment\'s key.',
    documents: docs.map((d) => ({
      id: d.id,
      name: d.name,
      title: d.classification === 'restricted' ? null : (d.title ?? d.name),
      path: d.key.startsWith(dir) ? d.key.slice(dir.length) : d.key,
      restricted: d.classification === 'restricted',
    })),
  };
  await ctx.storage.put(`${dir}${MANIFEST}`, JSON.stringify(manifest, null, 2), 'application/json');
  // remember where this workspace's files are; only a successful reconcile moves this pointer,
  // so after a rename the old folder can always be found and cleaned up
  await ctx.db.query('UPDATE workspaces SET library_dir = $2 WHERE id = $1 AND library_dir IS NULL', [workspaceId, dir]);
}

/**
 * Re-sync every document of a workspace and delete anything in its library folder that doesn't
 * belong there (leftovers from renames, moves, deletions or interrupted syncs).
 */
export async function reconcileWorkspace(ctx: AppContext, workspaceId: string): Promise<{ synced: number; removed: number }> {
  if (!ctx.cfg.LIBRARY_ENABLED) return { synced: 0, removed: 0 };
  const ws = await one<{ id: string; name: string; library_dir: string | null }>(ctx.db, 'SELECT id, name, library_dir FROM workspaces WHERE id = $1', [
    workspaceId,
  ]);
  if (!ws) return { synced: 0, removed: 0 };
  const dir = workspaceDir(ws);
  let synced = 0;
  // files deleted or lost behind our back: forget their recorded state so they are rewritten
  const present = new Set(await ctx.storage.list(dir));
  const recorded = await many<{ document_id: string; key: string }>(ctx.db, 'SELECT document_id, key FROM library_entries WHERE workspace_id = $1', [
    workspaceId,
  ]);
  const missing = recorded.filter((e) => e.key.startsWith(dir) && !present.has(e.key)).map((e) => e.document_id);
  if (missing.length) await ctx.db.query('DELETE FROM library_entries WHERE document_id = ANY($1::uuid[])', [missing]);
  const ids = await many<{ id: string }>(
    ctx.db,
    `SELECT id FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL
     UNION SELECT document_id FROM library_entries WHERE workspace_id = $1`,
    [workspaceId],
  );
  for (const { id } of ids) if ((await syncDocument(ctx, id)) !== 'unchanged') synced++;
  await writeManifest(ctx, workspaceId);

  // remove strays in the current folder and everything in a previous folder (workspace renamed)
  const expected = new Set((await many<{ key: string }>(ctx.db, 'SELECT key FROM library_entries WHERE workspace_id = $1', [workspaceId])).map((r) => r.key));
  expected.add(`${dir}${MANIFEST}`);
  let removed = 0;
  const dirs = [dir, ...(ws.library_dir && ws.library_dir !== dir ? [ws.library_dir] : [])];
  for (const d of dirs) {
    for (const key of await ctx.storage.list(d)) {
      if (!expected.has(key)) {
        await ctx.storage.delete(key);
        removed++;
      }
    }
  }
  await ctx.db.query('UPDATE workspaces SET library_dir = $2, library_synced_at = now() WHERE id = $1', [workspaceId, dir]);
  return { synced, removed };
}

/** Remove a deleted workspace's library folder. */
export async function deleteWorkspaceLibrary(ctx: AppContext, workspace: { id: string; name: string; library_dir?: string | null }) {
  const dirs = new Set([workspaceDir(workspace), ...(workspace.library_dir ? [workspace.library_dir] : [])]);
  for (const d of dirs) for (const key of await ctx.storage.list(d)) await ctx.storage.delete(key);
  await ctx.db.query('DELETE FROM library_entries WHERE workspace_id = $1', [workspace.id]);
}

/** Reconcile every workspace; only one replica at a time does this. */
export async function reconcileAllLibraries(ctx: AppContext): Promise<number | null> {
  if (!ctx.cfg.LIBRARY_ENABLED) return 0;
  const c = await ctx.db.connect();
  try {
    if (!(await c.query('SELECT pg_try_advisory_lock(727276) AS ok')).rows[0].ok) return null;
    try {
      const wss = await many<{ id: string }>(ctx.db, 'SELECT id FROM workspaces ORDER BY library_synced_at NULLS FIRST');
      for (const w of wss) await reconcileWorkspace(ctx, w.id);
      return wss.length;
    } finally {
      await c.query('SELECT pg_advisory_unlock(727276)');
    }
  } finally {
    c.release();
  }
}

/** Never let a library problem fail a user's request: log it; reconciliation repairs it later. */
export async function safely(ctx: AppContext, what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    ctx.log.warn({ err }, `library ${what} failed; it will be repaired by the next reconcile`);
  }
}
