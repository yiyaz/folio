import JSZip from 'jszip';
import { setFrontmatterField, splitFrontmatter } from '@folio/markdown';
import type { AppContext, AuthUser } from '../context.js';
import { many, one } from '../db.js';
import { createDocument, freeName, getDoc, readContent, saveContent, validateName } from './documents.js';

export interface TreeFolder {
  id: string;
  parent_id: string | null;
  name: string;
}

export function folderPaths(folders: TreeFolder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const cache = new Map<string, string>();
  const pathOf = (id: string, depth = 0): string => {
    if (cache.has(id)) return cache.get(id)!;
    const f = byId.get(id);
    if (!f || depth > 64) return '';
    const p = f.parent_id ? `${pathOf(f.parent_id, depth + 1)}/${f.name}` : f.name;
    cache.set(id, p);
    return p;
  };
  for (const f of folders) pathOf(f.id);
  return cache;
}

export interface ExportedFile {
  path: string;
  content: string;
  docId: string;
}

/**
 * Materialise a workspace as `relative/path.md` files. The stable document id is
 * written into each file's front matter so re-imports and git pulls can match
 * files back to documents even after renames.
 */
export async function exportWorkspaceFiles(ctx: AppContext, workspaceId: string, opts: { folderId?: string; docIds?: string[] } = {}): Promise<ExportedFile[]> {
  const folders = await many<TreeFolder>(ctx.db, 'SELECT id, parent_id, name FROM folders WHERE workspace_id = $1 AND deleted_at IS NULL', [workspaceId]);
  const paths = folderPaths(folders);
  let docs = await many<{ id: string; folder_id: string | null; name: string }>(
    ctx.db,
    // restricted documents never leave Folio in bulk (zip exports, Git sync); they can be
    // exported one at a time by people with access, which is audited
    `SELECT id, folder_id, name FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL AND classification = 'standard' ORDER BY name`,
    [workspaceId],
  );
  if (opts.docIds) {
    const allow = new Set(opts.docIds);
    docs = docs.filter((d) => allow.has(d.id));
  }
  let prefix = '';
  if (opts.folderId) {
    prefix = paths.get(opts.folderId) ?? '';
    docs = docs.filter((d) => d.folder_id && (paths.get(d.folder_id) === prefix || (paths.get(d.folder_id) ?? '').startsWith(prefix + '/')));
  }
  const out: ExportedFile[] = [];
  for (const d of docs) {
    const dir = d.folder_id ? (paths.get(d.folder_id) ?? '') : '';
    const rel = prefix ? dir.slice(prefix.length).replace(/^\//, '') : dir;
    const content = await readContent(ctx, await getDoc(ctx.db, d.id));
    out.push({ path: `${rel ? rel + '/' : ''}${d.name}.md`, content: setFrontmatterField(content, 'id', d.id), docId: d.id });
  }
  return out;
}

export async function zipFiles(files: { path: string; content: string | Buffer }[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export interface ImportReport {
  created: number;
  updated: number;
  unchanged: number;
  skipped: string[];
}

async function ensureFolderPath(ctx: AppContext, user: AuthUser, workspaceId: string, rootFolderId: string | null, segments: string[]): Promise<string | null> {
  let parent = rootFolderId;
  for (const raw of segments) {
    const name = raw.trim();
    if (!name || name === '.' || name === '..' || name.startsWith('.')) continue;
    const existing = await one<{ id: string }>(
      ctx.db,
      'SELECT id FROM folders WHERE workspace_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND lower(name) = lower($3) AND deleted_at IS NULL',
      [workspaceId, parent, name],
    );
    if (existing) parent = existing.id;
    else {
      const created = await one<{ id: string }>(
        ctx.db,
        'INSERT INTO folders (workspace_id, parent_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [workspaceId, parent, name.slice(0, 200), user.id],
      );
      parent = created!.id;
    }
  }
  return parent;
}

/** Import Markdown files (from a zip, an upload or a git checkout) into a workspace. */
export async function importFiles(
  ctx: AppContext,
  user: AuthUser,
  workspaceId: string,
  files: { path: string; content: string }[],
  opts: { folderId?: string | null; matchByPath?: boolean } = {},
): Promise<ImportReport> {
  const report: ImportReport = { created: 0, updated: 0, unchanged: 0, skipped: [] };
  const folders = await many<TreeFolder>(ctx.db, 'SELECT id, parent_id, name FROM folders WHERE workspace_id = $1 AND deleted_at IS NULL', [workspaceId]);
  const paths = folderPaths(folders);
  for (const f of files) {
    const norm = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const segs = norm.split('/');
    if (!/\.(md|markdown)$/i.test(norm) || segs.some((s) => s === '..' || s.startsWith('.') || s === '__MACOSX')) {
      report.skipped.push(f.path);
      continue;
    }
    const fileName = segs.pop()!.replace(/\.(md|markdown)$/i, '');
    let name: string;
    try {
      name = validateName(fileName.replace(/[\[\]|#^]/g, '-'));
    } catch {
      report.skipped.push(f.path);
      continue;
    }
    const { data } = splitFrontmatter(f.content);
    const content = typeof data.id === 'string' ? setFrontmatterField(f.content, 'id', undefined) : f.content;
    // 1. match by stable id in front matter
    let existing: { id: string; folder_id: string | null; name: string } | null = null;
    if (typeof data.id === 'string' && /^[0-9a-f-]{36}$/i.test(data.id)) {
      existing = await one(ctx.db, 'SELECT id, folder_id, name FROM documents WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL', [
        data.id,
        workspaceId,
      ]);
    }
    const folderId = await ensureFolderPath(ctx, user, workspaceId, opts.folderId ?? null, segs);
    // 2. optionally match by path (git pulls of files that never had an id)
    if (!existing && opts.matchByPath) {
      existing = await one(
        ctx.db,
        'SELECT id, folder_id, name FROM documents WHERE workspace_id = $1 AND folder_id IS NOT DISTINCT FROM $2 AND lower(name) = lower($3) AND deleted_at IS NULL',
        [workspaceId, folderId, name],
      );
    }
    if (existing) {
      const doc = await getDoc(ctx.db, existing.id);
      const current = await readContent(ctx, doc);
      if (current === content) report.unchanged++;
      else {
        await saveContent(ctx, user, doc.id, content, null);
        report.updated++;
      }
      continue;
    }
    void paths;
    const finalName = await freeName(ctx.db, workspaceId, folderId, name);
    await createDocument(ctx, user, { workspaceId, folderId, name: finalName, content });
    report.created++;
  }
  return report;
}

export async function unzipMarkdown(buf: Buffer): Promise<{ path: string; content: string }[]> {
  const zip = await JSZip.loadAsync(buf);
  const out: { path: string; content: string }[] = [];
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (!/\.(md|markdown)$/i.test(entry.name)) continue;
    const content = await entry.async('string');
    total += content.length;
    if (total > 200 * 1024 * 1024) throw new Error('archive too large when extracted');
    out.push({ path: entry.name, content });
  }
  return out;
}
