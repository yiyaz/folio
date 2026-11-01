import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyTemplate, BUILTIN_TEMPLATES, setFrontmatterField } from '@folio/markdown';
import { requireUser } from '../auth/plugin.js';
import { assertCan, assertUuid, can, documentAccess, folderAccess, type DocAccess } from '../access.js';
import { many, one } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { randomToken } from '../crypto.js';
import {
  createDocument,
  deleteDocumentPermanently,
  freeName,
  getDoc,
  readContent,
  restoreDocument,
  saveContent,
  serializeDoc,
  trashDocument,
  updateDocumentMeta,
} from '../services/documents.js';
import { notify } from '../services/notifications.js';
import { actorOf, PUBLIC_USER_SQL } from '../services/users.js';
import type { AuthUser } from '../context.js';

export async function registerDocumentRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  async function access(user: AuthUser, docId: string, action: 'read' | 'comment' | 'edit' | 'share', opts: { allowDeleted?: boolean } = {}): Promise<DocAccess> {
    assertUuid(docId);
    const a = await documentAccess(ctx.db, user.id, docId);
    if (!a || (a.deleted && !opts.allowDeleted)) throw notFound('Document not found');
    assertCan(a.role, action);
    return a;
  }

  app.get('/api/templates', async (req) => {
    requireUser(req);
    return BUILTIN_TEMPLATES.map(({ body: _b, ...t }) => t);
  });

  app.post('/api/documents', async (req, reply) => {
    const u = requireUser(req);
    const body = z
      .object({
        workspaceId: z.uuid(),
        folderId: z.uuid().nullable().optional(),
        name: z.string().optional(),
        content: z.string().max(5_000_000).optional(),
        templateId: z.string().optional(),
      })
      .parse(req.body);
    await app.canEditTarget(u.id, body.workspaceId, body.folderId ?? null);
    const base = body.name?.trim() || 'Untitled';
    const name = body.name?.trim() ? base : await freeName(ctx.db, body.workspaceId, body.folderId ?? null, base);
    let content = body.content ?? `# ${name}\n\n`;
    if (body.templateId) {
      const t = BUILTIN_TEMPLATES.find((x) => x.id === body.templateId);
      if (!t) throw badRequest('unknown template');
      content = applyTemplate(t.body, { title: name, author: u.username });
    }
    const r = await createDocument(ctx, u, { workspaceId: body.workspaceId, folderId: body.folderId ?? null, name, content });
    return reply.code(201).send({ ...serializeDoc(r.doc), mentionedWithoutAccess: r.mentionedWithoutAccess });
  });

  app.get('/api/documents/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const a = await access(u, id, 'read', { allowDeleted: true });
    const d = await getDoc(ctx.db, id);
    const [content, ws, publicLink, folderPath, authors] = await Promise.all([
      readContent(ctx, d),
      one<{ name: string }>(ctx.db, 'SELECT name FROM workspaces WHERE id = $1', [d.workspace_id]),
      can(a.role, 'share') ? one<{ token: string }>(ctx.db, 'SELECT token FROM public_links WHERE document_id = $1', [id]) : null,
      many<{ id: string; name: string }>(
        ctx.db,
        `WITH RECURSIVE anc AS (SELECT id, parent_id, name, 0 AS depth FROM folders WHERE id = $1 UNION ALL SELECT f.id, f.parent_id, f.name, anc.depth + 1 FROM folders f JOIN anc ON f.id = anc.parent_id)
         SELECT id, name FROM anc ORDER BY depth DESC`,
        [d.folder_id],
      ),
      many(ctx.db, `SELECT ${PUBLIC_USER_SQL} AS u FROM users u WHERE u.id = ANY($1::uuid[])`, [[d.created_by, d.updated_by].filter(Boolean)]),
    ]);
    const byId = new Map(authors.map((r: any) => [r.u.id, r.u]));
    return {
      ...serializeDoc(d),
      content,
      role: a.role,
      sharedOnly: a.sharedOnly,
      workspaceName: ws?.name,
      folderPath,
      publicToken: publicLink?.token ?? null,
      createdByUser: byId.get(d.created_by) ?? null,
      updatedByUser: byId.get(d.updated_by) ?? null,
    };
  });

  app.put('/api/documents/:id/content', { bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await access(u, id, 'edit');
    const body = z.object({ content: z.string().max(5_000_000), baseVersion: z.number().int().nullable() }).parse(req.body);
    const r = await saveContent(ctx, u, id, body.content, body.baseVersion);
    return { ...serializeDoc(r.doc), mentionedWithoutAccess: r.mentionedWithoutAccess };
  });

  app.patch('/api/documents/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const a = await access(u, id, 'edit');
    const body = z.object({ name: z.string().optional(), folderId: z.uuid().nullable().optional() }).parse(req.body);
    if (body.folderId !== undefined) await app.canEditTarget(u.id, a.workspaceId, body.folderId);
    return serializeDoc(await updateDocumentMeta(ctx, u, id, body));
  });

  app.delete('/api/documents/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await access(u, id, 'edit');
    await trashDocument(ctx, id);
    return { ok: true };
  });

  app.post('/api/documents/:id/restore', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await access(u, id, 'edit', { allowDeleted: true });
    return serializeDoc(await restoreDocument(ctx, id));
  });

  app.delete('/api/documents/:id/permanent', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const a = await access(u, id, 'edit', { allowDeleted: true });
    if (!a.deleted) throw badRequest('Move the document to the trash first');
    await deleteDocumentPermanently(ctx, id);
    return { ok: true };
  });

  app.post('/api/documents/:id/duplicate', async (req, reply) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const a = await access(u, id, 'read');
    const d = await getDoc(ctx.db, id);
    await app.canEditTarget(u.id, a.workspaceId, d.folder_id);
    const name = await freeName(ctx.db, d.workspace_id, d.folder_id, `${d.name} copy`);
    const r = await createDocument(ctx, u, { workspaceId: d.workspace_id, folderId: d.folder_id, name, content: await readContent(ctx, d) });
    return reply.code(201).send(serializeDoc(r.doc));
  });

  app.get('/api/documents/:id/export', async (req, reply) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await access(u, id, 'read');
    const d = await getDoc(ctx.db, id);
    const content = setFrontmatterField(await readContent(ctx, d), 'id', d.id);
    return reply
      .type('text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}.md`)
      .send(content);
  });

  app.get('/api/documents/:id/backlinks', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await access(u, id, 'read');
    const rows = await many<{ id: string; name: string; title: string; anchors: (string | null)[]; storage_key: string; positions: number[] }>(
      ctx.db,
      `SELECT s.id, s.name, COALESCE(s.title, s.name) AS title, s.storage_key, array_agg(l.anchor) AS anchors, array_agg(l.position ORDER BY l.position) AS positions
       FROM links l JOIN documents s ON s.id = l.source_id
       WHERE l.target_id = $1 AND s.deleted_at IS NULL AND s.id <> $1
       GROUP BY s.id ORDER BY s.updated_at DESC`,
      [id],
    );
    // only reveal backlinks from documents this user can read, with a context excerpt
    const out = [];
    for (const r of rows) {
      const a = await documentAccess(ctx.db, u.id, r.id);
      if (!a || !can(a.role, 'read')) continue;
      let excerpt = '';
      try {
        const text = (await ctx.storage.get(r.storage_key)).toString('utf8');
        const p = r.positions[0] ?? 0;
        const start = Math.max(0, text.lastIndexOf('\n', p) + 1);
        const endNl = text.indexOf('\n', p);
        excerpt = text.slice(start, endNl === -1 ? undefined : endNl).trim().slice(0, 240);
      } catch {
        /* missing blob */
      }
      out.push({ id: r.id, name: r.name, title: r.title, anchors: [...new Set(r.anchors.filter(Boolean))], excerpt });
    }
    return out;
  });

  app.get('/api/documents/:id/links', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await access(u, id, 'read');
    return many(
      ctx.db,
      `SELECT l.target_name AS "targetName", l.target_id AS "targetId", l.anchor, COALESCE(t.title, t.name) AS "targetTitle"
       FROM links l LEFT JOIN documents t ON t.id = l.target_id WHERE l.source_id = $1 ORDER BY l.position`,
      [id],
    );
  });

  // ---- revisions ----
  app.get('/api/documents/:id/revisions', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await access(u, id, 'read');
    return many(
      ctx.db,
      `SELECT r.id, r.version, r.size, r.created_at AS "createdAt", ${PUBLIC_USER_SQL} AS author
       FROM revisions r LEFT JOIN users u ON u.id = r.author_id WHERE r.document_id = $1 ORDER BY r.version DESC LIMIT 200`,
      [id],
    );
  });

  app.get('/api/documents/:id/revisions/:revId', async (req) => {
    const u = requireUser(req);
    const { id, revId } = req.params as { id: string; revId: string };
    await access(u, id, 'read');
    assertUuid(revId);
    const r = await one<{ storage_key: string; version: number; created_at: Date }>(ctx.db, 'SELECT storage_key, version, created_at FROM revisions WHERE id = $1 AND document_id = $2', [revId, id]);
    if (!r) throw notFound('Revision not found');
    return { id: revId, version: r.version, createdAt: r.created_at, content: (await ctx.storage.get(r.storage_key)).toString('utf8') };
  });

  app.post('/api/documents/:id/revisions/:revId/restore', async (req) => {
    const u = requireUser(req);
    const { id, revId } = req.params as { id: string; revId: string };
    await access(u, id, 'edit');
    assertUuid(revId);
    const r = await one<{ storage_key: string }>(ctx.db, 'SELECT storage_key FROM revisions WHERE id = $1 AND document_id = $2', [revId, id]);
    if (!r) throw notFound('Revision not found');
    const content = (await ctx.storage.get(r.storage_key)).toString('utf8');
    const res = await saveContent(ctx, u, id, content, null);
    return serializeDoc(res.doc);
  });

  // ---- sharing ----
  async function resourceAccess(u: AuthUser, type: 'document' | 'folder', id: string) {
    assertUuid(id);
    const a = type === 'document' ? await documentAccess(ctx.db, u.id, id) : await folderAccess(ctx.db, u.id, id);
    if (!a || a.deleted) throw notFound();
    return a;
  }

  for (const type of ['document', 'folder'] as const) {
    const base = type === 'document' ? '/api/documents/:id/permissions' : '/api/folders/:id/permissions';

    app.get(base, async (req) => {
      const u = requireUser(req);
      const { id } = req.params as { id: string };
      const a = await resourceAccess(u, type, id);
      assertCan(a.role, 'read');
      const direct = await many(
        ctx.db,
        `SELECT p.id, p.role, p.resource_type AS "resourceType", p.resource_id AS "resourceId", ${PUBLIC_USER_SQL} AS user
         FROM permissions p JOIN users u ON u.id = p.user_id WHERE p.resource_type = $1 AND p.resource_id = $2 ORDER BY u.username`,
        [type, id],
      );
      // permissions inherited from parent folders
      const inherited = a.folderId
        ? await many(
            ctx.db,
            `WITH RECURSIVE anc AS (SELECT id, parent_id, name FROM folders WHERE id = $1 UNION ALL SELECT f.id, f.parent_id, f.name FROM folders f JOIN anc ON f.id = anc.parent_id)
             SELECT p.id, p.role, anc.name AS "fromFolder", anc.id AS "fromFolderId", ${PUBLIC_USER_SQL} AS user
             FROM permissions p JOIN anc ON p.resource_type = 'folder' AND p.resource_id = anc.id JOIN users u ON u.id = p.user_id`,
            [a.folderId],
          )
        : [];
      const members = await many(
        ctx.db,
        `SELECT CASE WHEN w.owner_id = u.id THEN 'owner' ELSE m.role END AS role, ${PUBLIC_USER_SQL} AS user
         FROM workspace_members m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = $1 ORDER BY u.username`,
        [a.workspaceId],
      );
      return { direct, inherited, members, canShare: can(a.role, 'share') };
    });

    app.post(base, async (req, reply) => {
      const u = requireUser(req);
      const { id } = req.params as { id: string };
      const a = await resourceAccess(u, type, id);
      assertCan(a.role, 'share');
      const body = z.object({ user: z.string().trim().min(1), role: z.enum(['viewer', 'commenter', 'editor']) }).parse(req.body);
      const target = await one<{ id: string }>(ctx.db, 'SELECT id FROM users WHERE (lower(username) = lower($1) OR lower(email) = lower($1) OR id::text = $1) AND disabled_at IS NULL', [
        body.user.replace(/^@/, ''),
      ]);
      if (!target) throw notFound('No user with that username or e-mail');
      await ctx.db.query(
        `INSERT INTO permissions (resource_type, resource_id, user_id, role, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (resource_type, resource_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [type, id, target.id, body.role, u.id],
      );
      const name =
        type === 'document'
          ? (await one<{ n: string }>(ctx.db, 'SELECT COALESCE(title, name) AS n FROM documents WHERE id = $1', [id]))!.n
          : (await one<{ n: string }>(ctx.db, 'SELECT name AS n FROM folders WHERE id = $1', [id]))!.n;
      await notify(ctx, target.id, 'share', { actor: actorOf(u), documentId: type === 'document' ? id : undefined, documentName: type === 'document' ? name : `folder "${name}"`, role: body.role });
      return reply.code(201).send({ ok: true });
    });

    app.delete(`${base}/:userId`, async (req) => {
      const u = requireUser(req);
      const { id, userId } = req.params as { id: string; userId: string };
      const a = await resourceAccess(u, type, id);
      if (userId !== u.id) assertCan(a.role, 'share'); // anyone may remove their own access
      await ctx.db.query('DELETE FROM permissions WHERE resource_type = $1 AND resource_id = $2 AND user_id::text = $3', [type, id, userId]);
      return { ok: true };
    });
  }

  app.post('/api/documents/:id/public-link', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await access(u, id, 'share');
    const row = await one<{ token: string }>(
      ctx.db,
      `INSERT INTO public_links (token, document_id, created_by) VALUES ($1, $2, $3) ON CONFLICT (document_id) DO UPDATE SET document_id = EXCLUDED.document_id RETURNING token`,
      [randomToken(18), id, u.id],
    );
    return { token: row!.token, url: `${ctx.cfg.PUBLIC_URL}/p/${row!.token}` };
  });

  app.delete('/api/documents/:id/public-link', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await access(u, id, 'share');
    await ctx.db.query('DELETE FROM public_links WHERE document_id = $1', [id]);
    return { ok: true };
  });

  /** Read-only public view — no authentication. */
  app.get('/api/public/:token', async (req) => {
    const { token } = req.params as { token: string };
    const row = await one<{ document_id: string }>(ctx.db, 'SELECT document_id FROM public_links WHERE token = $1', [token]);
    if (!row) throw notFound();
    const d = await getDoc(ctx.db, row.document_id);
    if (d.deleted_at) throw notFound();
    return { id: d.id, name: d.name, title: d.title ?? d.name, updatedAt: d.updated_at, content: await readContent(ctx, d) };
  });

  // ---- comments ----
  app.get('/api/documents/:id/comments', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await access(u, id, 'read');
    return many(
      ctx.db,
      `SELECT c.id, c.parent_id AS "parentId", c.body, c.anchor_text AS "anchorText", c.anchor_start AS "anchorStart", c.anchor_end AS "anchorEnd",
         c.resolved_at AS "resolvedAt", c.created_at AS "createdAt", c.updated_at AS "updatedAt", ${PUBLIC_USER_SQL} AS author
       FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.document_id = $1 ORDER BY c.created_at`,
      [id],
    );
  });

  app.post('/api/documents/:id/comments', async (req, reply) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await access(u, id, 'comment');
    const body = z
      .object({
        body: z.string().trim().min(1).max(10_000),
        parentId: z.uuid().optional(),
        anchorText: z.string().max(2000).optional(),
        anchorStart: z.number().int().min(0).optional(),
        anchorEnd: z.number().int().min(0).optional(),
      })
      .parse(req.body);
    let parentAuthor: string | null = null;
    if (body.parentId) {
      const p = await one<{ author_id: string; parent_id: string | null }>(ctx.db, 'SELECT author_id, parent_id FROM comments WHERE id = $1 AND document_id = $2', [body.parentId, id]);
      if (!p) throw badRequest('parent comment not found');
      if (p.parent_id) throw badRequest('replies cannot be nested');
      parentAuthor = p.author_id;
    }
    const c = await one<{ id: string }>(
      ctx.db,
      `INSERT INTO comments (document_id, parent_id, author_id, body, anchor_text, anchor_start, anchor_end) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [id, body.parentId ?? null, u.id, body.body, body.parentId ? null : body.anchorText ?? null, body.anchorStart ?? null, body.anchorEnd ?? null],
    );
    const d = await getDoc(ctx.db, id);
    const docName = d.title ?? d.name;
    const actor = actorOf(u);
    const notified = new Set<string>([u.id]);
    const excerpt = body.body.slice(0, 200);
    if (parentAuthor && !notified.has(parentAuthor)) {
      notified.add(parentAuthor);
      await notify(ctx, parentAuthor, 'reply', { actor, documentId: id, documentName: docName, commentId: c!.id, excerpt });
    }
    // @mentions inside the comment
    const names = [...body.body.matchAll(/(^|\s)@([a-zA-Z0-9_.-]{2,32})/g)].map((m) => m[2].toLowerCase());
    if (names.length) {
      const users = await many<{ id: string }>(ctx.db, 'SELECT id FROM users WHERE lower(username) = ANY($1)', [names]);
      for (const m of users) {
        if (notified.has(m.id)) continue;
        const ma = await documentAccess(ctx.db, m.id, id);
        if (!ma || !can(ma.role, 'read')) continue;
        notified.add(m.id);
        await notify(ctx, m.id, 'mention', { actor, documentId: id, documentName: docName, commentId: c!.id, excerpt });
      }
    }
    // the document author hears about new top-level comments
    if (!body.parentId && d.created_by && !notified.has(d.created_by)) {
      await notify(ctx, d.created_by, 'comment', { actor, documentId: id, documentName: docName, commentId: c!.id, excerpt });
    }
    await ctx.bus.publish({ type: 'comments-changed', docId: id });
    return reply.code(201).send({ id: c!.id });
  });

  async function commentAccess(u: AuthUser, commentId: string) {
    assertUuid(commentId);
    const c = await one<{ document_id: string; author_id: string }>(ctx.db, 'SELECT document_id, author_id FROM comments WHERE id = $1', [commentId]);
    if (!c) throw notFound('Comment not found');
    const a = await access(u, c.document_id, 'comment');
    return { ...c, access: a };
  }

  app.patch('/api/comments/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const c = await commentAccess(u, id);
    const body = z.object({ body: z.string().trim().min(1).max(10_000).optional(), resolved: z.boolean().optional() }).parse(req.body);
    if (body.body !== undefined) {
      if (c.author_id !== u.id) throw badRequest('Only the author can edit a comment');
      await ctx.db.query('UPDATE comments SET body = $2, updated_at = now() WHERE id = $1', [id, body.body]);
    }
    if (body.resolved !== undefined) {
      await ctx.db.query('UPDATE comments SET resolved_at = CASE WHEN $2 THEN now() ELSE NULL END, resolved_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END WHERE id = $1', [id, body.resolved, u.id]);
    }
    await ctx.bus.publish({ type: 'comments-changed', docId: c.document_id });
    return { ok: true };
  });

  app.delete('/api/comments/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const c = await commentAccess(u, id);
    if (c.author_id !== u.id && !can(c.access.role, 'edit')) throw badRequest('Only the author or an editor can delete a comment');
    await ctx.db.query('DELETE FROM comments WHERE id = $1', [id]);
    await ctx.bus.publish({ type: 'comments-changed', docId: c.document_id });
    return { ok: true };
  });

  // ---- notifications ----
  app.get('/api/notifications', async (req) => {
    const u = requireUser(req);
    const items = await many(
      ctx.db,
      `SELECT id, type, payload, read_at AS "readAt", created_at AS "createdAt" FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [u.id],
    );
    const unread = await one<{ n: number }>(ctx.db, 'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [u.id]);
    return { items, unread: unread!.n };
  });

  app.post('/api/notifications/:id/read', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await ctx.db.query('UPDATE notifications SET read_at = now() WHERE id::text = $1 AND user_id = $2', [id, u.id]);
    return { ok: true };
  });

  app.post('/api/notifications/read-all', async (req) => {
    const u = requireUser(req);
    await ctx.db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [u.id]);
    return { ok: true };
  });
}
