import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { requireUser } from '../auth/plugin.js';
import { assertCan, can, documentAccess, workspaceRole, UUID_RE } from '../access.js';
import { one } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { keys } from '../storage/index.js';
import { getDoc } from '../services/documents.js';
import { isRestricted, protect, reveal } from '../services/restricted.js';
import { audit } from '../services/audit.js';

/** Upload allow-list. SVG and HTML are deliberately excluded (script injection). */
export const ALLOWED_MIME: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'text/csv': ['csv'],
  'text/plain': ['txt', 'log', 'tsv'],
  'application/json': ['json', 'ipynb'],
  'application/x-ipynb+json': ['ipynb'],
  'application/vnd.apache.parquet': ['parquet'],
  'application/octet-stream': ['parquet'],
};

const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

function detectMime(filename: string, declared: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'ipynb') return 'application/x-ipynb+json';
  if (ext === 'parquet') return 'application/vnd.apache.parquet';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'tsv') return 'text/plain';
  const allowed = ALLOWED_MIME[declared];
  if (allowed && allowed.includes(ext)) return declared;
  for (const [mime, exts] of Object.entries(ALLOWED_MIME)) if (exts.includes(ext) && mime !== 'application/octet-stream') return mime;
  return null;
}

/** Light magic-number check so a renamed executable can't pose as an image. */
function sniffOk(mime: string, buf: Buffer): boolean {
  const hex = buf.subarray(0, 8).toString('hex');
  switch (mime) {
    case 'image/png':
      return hex.startsWith('89504e47');
    case 'image/jpeg':
      return hex.startsWith('ffd8ff');
    case 'image/gif':
      return buf.subarray(0, 3).toString() === 'GIF';
    case 'image/webp':
      return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
    case 'application/pdf':
      return buf.subarray(0, 4).toString() === '%PDF';
    case 'application/vnd.apache.parquet':
      return buf.subarray(0, 4).toString() === 'PAR1';
    default:
      return !buf.subarray(0, 4096).includes(0); // text formats must not contain NUL bytes
  }
}

export async function registerAttachmentRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.post('/api/attachments', async (req, reply) => {
    const u = requireUser(req);
    const file = await req.file({ limits: { fileSize: ctx.cfg.MAX_UPLOAD_MB * 1024 * 1024 } });
    if (!file) throw badRequest('file is required');
    const fields = file.fields as Record<string, { value?: string } | undefined>;
    const workspaceId = fields.workspaceId?.value;
    const documentId = fields.documentId?.value || null;
    if (!workspaceId || !UUID_RE.test(workspaceId)) throw badRequest('workspaceId is required');
    if (documentId) {
      if (!UUID_RE.test(documentId)) throw badRequest('invalid documentId');
      const a = await documentAccess(ctx.db, u.id, documentId);
      if (!a || a.workspaceId !== workspaceId) throw notFound();
      assertCan(a.role, 'edit');
    } else {
      assertCan(await workspaceRole(ctx.db, u.id, workspaceId), 'edit');
    }
    const mime = detectMime(file.filename, file.mimetype);
    if (!mime) throw badRequest(`File type not allowed. Allowed: ${[...new Set(Object.values(ALLOWED_MIME).flat())].join(', ')}`);
    const buf = await file.toBuffer();
    if (file.file.truncated) throw badRequest(`File exceeds the ${ctx.cfg.MAX_UPLOAD_MB} MB limit`);
    if (!sniffOk(mime, buf)) throw badRequest('File contents do not match its type');
    const id = randomUUID();
    const key = keys.attachment(workspaceId, id);
    // attachments of restricted documents are encrypted with the document's key
    const owner = documentId ? await getDoc(ctx.db, documentId) : null;
    const restricted = !!owner && isRestricted(owner);
    await ctx.storage.put(key, owner ? await protect(ctx, owner, buf, 'attachment') : buf, restricted ? 'application/json' : mime);
    const filename = file.filename.replace(/[^\w.\- ()]+/g, '_').slice(0, 200) || 'file';
    await ctx.db.query(
      'INSERT INTO attachments (id, workspace_id, document_id, filename, mime, size, storage_key, created_by, encrypted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, workspaceId, documentId, filename, mime, buf.length, key, u.id, restricted],
    );
    const url = `/api/attachments/${id}/${encodeURIComponent(filename)}`;
    const markdown = mime.startsWith('image/') ? `![${filename}](${url})` : `[${filename}](${url})`;
    return reply.code(201).send({ id, url, filename, mime, size: buf.length, markdown });
  });

  /**
   * Attachments of a restricted document follow the document's (deny-by-default) access;
   * other attachments are readable by workspace members and by people who can read the document.
   */
  async function mayRead(userId: string | null, att: { workspace_id: string; document_id: string | null }): Promise<{ ok: boolean; restricted: boolean }> {
    const docAccess = att.document_id && userId ? await documentAccess(ctx.db, userId, att.document_id) : null;
    if (att.document_id) {
      const doc = await one<{ classification: string }>(ctx.db, 'SELECT classification FROM documents WHERE id = $1', [att.document_id]);
      if (doc?.classification === 'restricted') return { ok: can(docAccess?.role ?? null, 'read'), restricted: true };
    }
    if (!userId) return { ok: false, restricted: false };
    if (can(await workspaceRole(ctx.db, userId, att.workspace_id), 'read')) return { ok: true, restricted: false };
    return { ok: can(docAccess?.role ?? null, 'read'), restricted: false };
  }

  const serve = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const { p } = req.query as { p?: string };
    if (!UUID_RE.test(id)) throw notFound();
    const att = await one<{ workspace_id: string; document_id: string | null; filename: string; mime: string; storage_key: string }>(
      ctx.db,
      'SELECT workspace_id, document_id, filename, mime, storage_key FROM attachments WHERE id = $1',
      [id],
    );
    if (!att) throw notFound();
    const allowed = await mayRead(req.user?.id ?? null, att);
    if (!allowed.ok && p && att.document_id && !allowed.restricted) {
      // attachments embedded in a publicly shared document
      allowed.ok = !!(await one(ctx.db, 'SELECT 1 FROM public_links WHERE token = $1 AND document_id = $2', [p, att.document_id]));
    }
    if (!allowed.ok) throw notFound();
    const buf = att.document_id ? await reveal(ctx, att.document_id, await ctx.storage.get(att.storage_key)) : await ctx.storage.get(att.storage_key);
    if (allowed.restricted)
      await audit(ctx, req, {
        action: 'attachment.view',
        resourceType: 'attachment',
        resourceId: id,
        workspaceId: att.workspace_id,
        details: { documentId: att.document_id },
      });
    return reply
      .type(att.mime)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('cache-control', 'private, max-age=3600')
      .header('content-disposition', `${INLINE.has(att.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.filename)}`)
      .send(buf);
  };
  app.get('/api/attachments/:id', serve);
  app.get('/api/attachments/:id/:filename', serve);

  app.get('/api/attachments/:id/meta', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw notFound();
    const att = await one<{ workspace_id: string; document_id: string | null; filename: string; mime: string; size: number }>(
      ctx.db,
      'SELECT workspace_id, document_id, filename, mime, size FROM attachments WHERE id = $1',
      [id],
    );
    if (!att) throw notFound();
    if (!(await mayRead(u.id, att)).ok) throw notFound();
    return { id, filename: att.filename, mime: att.mime, size: att.size, workspaceId: att.workspace_id, documentId: att.document_id };
  });
}
