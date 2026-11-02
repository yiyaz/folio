import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { assertCan, assertUuid, folderAccess, workspaceRole, ACCESSIBLE_DOCS_CTE, can, visibleDocSql } from '../access.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { createWorkspace } from '../services/workspaces.js';
import { exportWorkspaceFiles, importFiles, unzipMarkdown, zipFiles } from '../services/transfer.js';
import { deleteDocumentPermanently } from '../services/documents.js';
import { deleteWorkspaceLibrary, reconcileWorkspace, safely, workspaceDir, MANIFEST } from '../services/library.js';
import { notify } from '../services/notifications.js';
import { actorOf } from '../services/users.js';
import { randomToken, sha256 } from '../crypto/tokens.js';
import { getSignupSettings } from '../auth/settings.js';

const memberRole = z.enum(['viewer', 'commenter', 'editor', 'admin']);

export async function registerWorkspaceRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  async function wsRole(userId: string, wsId: string) {
    assertUuid(wsId);
    return workspaceRole(ctx.db, userId, wsId);
  }

  app.get('/api/workspaces', async (req) => {
    const u = requireUser(req);
    return many(
      ctx.db,
      `SELECT w.id, w.name, w.owner_id AS "ownerId", CASE WHEN w.owner_id = $1 THEN 'owner' ELSE m.role END AS role, w.created_at AS "createdAt",
         (SELECT count(*)::int FROM workspace_members WHERE workspace_id = w.id) AS "memberCount"
       FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1
       ORDER BY w.created_at`,
      [u.id],
    );
  });

  app.post('/api/workspaces', async (req, reply) => {
    const u = requireUser(req);
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const ws = await createWorkspace(ctx, u, name);
    return reply.code(201).send({ id: ws.id, name: ws.name, ownerId: ws.owner_id, role: 'owner' });
  });

  app.patch('/api/workspaces/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertCan(await wsRole(u.id, id), 'manage');
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const ws = await one(ctx.db, 'UPDATE workspaces SET name = $2 WHERE id = $1 RETURNING id, name', [id, name]);
    // the library folder is named after the workspace
    await safely(ctx, 'reconcile', () => reconcileWorkspace(ctx, id));
    return ws;
  });

  app.delete('/api/workspaces/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const role = await wsRole(u.id, id);
    if (role !== 'owner') throw role ? forbidden('Only the owner can delete a workspace') : notFound();
    const ws = await one<{ id: string; name: string; library_dir: string | null }>(ctx.db, 'SELECT id, name, library_dir FROM workspaces WHERE id = $1', [id]);
    const docs = await many<{ id: string }>(ctx.db, 'SELECT id FROM documents WHERE workspace_id = $1', [id]);
    for (const d of docs) await deleteDocumentPermanently(ctx, d.id);
    await ctx.db.query('DELETE FROM workspaces WHERE id = $1', [id]);
    if (ws) await safely(ctx, 'delete', () => deleteWorkspaceLibrary(ctx, ws));
    return { ok: true };
  });

  app.get('/api/workspaces/:id/tree', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertCan(await wsRole(u.id, id), 'read');
    const [folders, documents] = await Promise.all([
      many(ctx.db, `SELECT id, parent_id AS "parentId", name FROM folders WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY lower(name)`, [id]),
      many(
        ctx.db,
        `SELECT d.id, d.folder_id AS "folderId", d.name, COALESCE(d.title, d.name) AS title, d.updated_at AS "updatedAt",
           d.classification = 'restricted' AS restricted
         FROM documents d WHERE d.workspace_id = $1 AND d.deleted_at IS NULL AND ${visibleDocSql('d', '$2')} ORDER BY lower(d.name)`,
        [id, u.id],
      ),
    ]);
    return { folders, documents };
  });

  /** Lightweight list of names for wiki-link resolution and autocomplete. */
  app.get('/api/workspaces/:id/names', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const role = await wsRole(u.id, id);
    if (role) {
      return many(
        ctx.db,
        `SELECT d.id, d.name, COALESCE(d.title, d.name) AS title, d.classification = 'restricted' AS restricted FROM documents d
         WHERE d.workspace_id = $1 AND d.deleted_at IS NULL AND ${visibleDocSql('d', '$2')} ORDER BY lower(d.name)`,
        [id, u.id],
      );
    }
    // shared-only users resolve links to documents they can read
    return many(
      ctx.db,
      `WITH RECURSIVE ${ACCESSIBLE_DOCS_CTE} SELECT d.id, d.name, COALESCE(d.title, d.name) AS title, d.classification = 'restricted' AS restricted FROM documents d
       WHERE d.workspace_id = $2 AND d.deleted_at IS NULL AND d.id IN (SELECT id FROM acc) ORDER BY lower(d.name)`,
      [u.id, id],
    );
  });

  app.get('/api/workspaces/:id/tags', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertCan(await wsRole(u.id, id), 'read');
    return many(
      ctx.db,
      `SELECT t.tag, count(*)::int AS count FROM doc_tags t JOIN documents d ON d.id = t.document_id
       WHERE d.workspace_id = $1 AND d.deleted_at IS NULL AND ${visibleDocSql('d', '$2')} GROUP BY t.tag ORDER BY count DESC, t.tag`,
      [id, u.id],
    );
  });

  app.get('/api/workspaces/:id/trash', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertCan(await wsRole(u.id, id), 'edit');
    const [documents, folders] = await Promise.all([
      many(
        ctx.db,
        `SELECT d.id, d.name, d.folder_id AS "folderId", d.deleted_at AS "deletedAt" FROM documents d
         WHERE d.workspace_id = $1 AND d.deleted_at IS NOT NULL AND ${visibleDocSql('d', '$2')} ORDER BY d.deleted_at DESC`,
        [id, u.id],
      ),
      many(
        ctx.db,
        `SELECT f.id, f.name, f.deleted_at AS "deletedAt" FROM folders f WHERE f.workspace_id = $1 AND f.deleted_at IS NOT NULL
         AND (f.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM folders p WHERE p.id = f.parent_id AND p.deleted_at = f.deleted_at))
         ORDER BY f.deleted_at DESC`,
        [id],
      ),
    ]);
    return { documents, folders };
  });

  // ---- members ----
  app.get('/api/workspaces/:id/members', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertCan(await wsRole(u.id, id), 'read');
    return many(
      ctx.db,
      `SELECT u.id, u.username, u.display_name AS "displayName", (u.avatar_key IS NOT NULL) AS "hasAvatar",
         CASE WHEN w.owner_id = u.id THEN 'owner' ELSE m.role END AS role
       FROM workspace_members m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.workspace_id = $1 ORDER BY (w.owner_id = u.id) DESC, u.username`,
      [id],
    );
  });

  app.post('/api/workspaces/:id/members', async (req, reply) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertCan(await wsRole(u.id, id), 'manage');
    const body = z.object({ user: z.string().trim().min(1), role: memberRole }).parse(req.body);
    const target = await one<{ id: string; email: string }>(
      ctx.db,
      'SELECT id, email FROM users WHERE (lower(username) = lower($1) OR lower(email) = lower($1)) AND disabled_at IS NULL',
      [body.user.replace(/^@/, '')],
    );
    const ws = await one<{ name: string }>(ctx.db, 'SELECT name FROM workspaces WHERE id = $1', [id]);
    if (!target) {
      if (!body.user.includes('@') || body.user.startsWith('@')) throw notFound('No user with that username');
      const settings = await getSignupSettings(ctx);
      if (settings.mode === 'closed') throw badRequest('That person has no account and sign-up is closed');
      const token = randomToken();
      await ctx.db.query('INSERT INTO invites (token_hash, email, invited_by, workspace_id, role) VALUES ($1, $2, $3, $4, $5)', [
        sha256(token),
        body.user.toLowerCase(),
        u.id,
        id,
        body.role,
      ]);
      const link = `${ctx.cfg.PUBLIC_URL}/signup?invite=${token}&email=${encodeURIComponent(body.user.toLowerCase())}`;
      await ctx.mailer.send({
        to: body.user,
        subject: `${u.displayName} invited you to "${ws!.name}" on Folio`,
        text: `${u.displayName} invited you to collaborate in the workspace "${ws!.name}".\n\nCreate your account: ${link}`,
      });
      return reply.code(202).send({ invited: true });
    }
    await ctx.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [id, target.id, body.role],
    );
    await notify(ctx, target.id, 'workspace-invite', { actor: actorOf(u), workspaceId: id, workspaceName: ws!.name, role: body.role });
    return reply.code(201).send({ ok: true });
  });

  app.patch('/api/workspaces/:id/members/:userId', async (req) => {
    const u = requireUser(req);
    const { id, userId } = req.params as { id: string; userId: string };
    assertCan(await wsRole(u.id, id), 'manage');
    const { role } = z.object({ role: memberRole }).parse(req.body);
    const ws = await one<{ owner_id: string }>(ctx.db, 'SELECT owner_id FROM workspaces WHERE id = $1', [id]);
    if (ws!.owner_id === userId) throw badRequest("The owner's role cannot be changed");
    await ctx.db.query('UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id::text = $2', [id, userId, role]);
    return { ok: true };
  });

  app.delete('/api/workspaces/:id/members/:userId', async (req) => {
    const u = requireUser(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const role = await wsRole(u.id, id);
    if (userId !== u.id) assertCan(role, 'manage'); // anyone can leave
    const ws = await one<{ owner_id: string }>(ctx.db, 'SELECT owner_id FROM workspaces WHERE id = $1', [id]);
    if (ws?.owner_id === userId) throw badRequest('The owner cannot be removed');
    await ctx.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id::text = $2', [id, userId]);
    return { ok: true };
  });

  /** Where this workspace's files live, for admins who need to locate or recover them. */
  app.get('/api/workspaces/:id/storage', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertCan(await wsRole(u.id, id), 'manage');
    const ws = await one<{ id: string; name: string; library_synced_at: Date | null }>(
      ctx.db,
      'SELECT id, name, library_synced_at FROM workspaces WHERE id = $1',
      [id],
    );
    const counts = await one<{ docs: number; restricted: number }>(
      ctx.db,
      `SELECT count(*)::int AS docs, count(*) FILTER (WHERE classification = 'restricted')::int AS restricted FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL`,
      [id],
    );
    const dir = workspaceDir(ws!);
    return {
      driver: ctx.cfg.STORAGE_DRIVER,
      libraryEnabled: ctx.cfg.LIBRARY_ENABLED,
      library: ctx.storage.locate(dir),
      manifest: ctx.storage.locate(`${dir}${MANIFEST}`),
      versions: ctx.storage.locate(`workspaces/${id}/blobs/`),
      attachments: ctx.storage.locate(`workspaces/${id}/attachments/`),
      lastReconciledAt: ws!.library_synced_at,
      documents: counts!.docs,
      restrictedDocuments: counts!.restricted,
      keyProvider: ctx.keys.describe(),
      // restricted documents depend on APP_SECRET staying unchanged until FOLIO_KEYS is set
      keyWarning: ctx.keys.activeKekId === 'app-secret',
    };
  });

  /** Rebuild this workspace's readable library now (normally automatic). */
  app.post('/api/workspaces/:id/storage/reconcile', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertCan(await wsRole(u.id, id), 'manage');
    return reconcileWorkspace(ctx, id);
  });

  // ---- export / import ----
  app.get('/api/workspaces/:id/export', async (req, reply) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const { folderId } = req.query as { folderId?: string };
    assertCan(await wsRole(u.id, id), 'read');
    const files = await exportWorkspaceFiles(ctx, id, { folderId });
    const ws = await one<{ name: string }>(ctx.db, 'SELECT name FROM workspaces WHERE id = $1', [id]);
    const fname = `${(ws?.name ?? 'workspace').replace(/[^\w.-]+/g, '_')}.zip`;
    return reply
      .type('application/zip')
      .header('content-disposition', `attachment; filename="${fname}"`)
      .send(await zipFiles(files));
  });

  app.post('/api/workspaces/:id/import', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertCan(await wsRole(u.id, id), 'edit');
    const { folderId } = req.query as { folderId?: string };
    if (folderId) {
      const fa = await folderAccess(ctx.db, u.id, folderId);
      if (!fa || fa.workspaceId !== id) throw badRequest('folder not found');
    }
    const files: { path: string; content: string }[] = [];
    for await (const part of req.files({ limits: { fileSize: ctx.cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 500 } })) {
      const buf = await part.toBuffer();
      if (/\.zip$/i.test(part.filename) || part.mimetype === 'application/zip') files.push(...(await unzipMarkdown(buf)));
      else if (/\.(md|markdown)$/i.test(part.filename)) files.push({ path: part.filename, content: buf.toString('utf8') });
    }
    if (!files.length) throw badRequest('Upload .md files or a .zip archive containing Markdown');
    return importFiles(ctx, u, id, files, { folderId: folderId ?? null });
  });

  // ---- folders ----
  async function canEditTarget(userId: string, workspaceId: string, folderId: string | null) {
    if (folderId) {
      assertUuid(folderId);
      const fa = await folderAccess(ctx.db, userId, folderId);
      if (!fa || fa.workspaceId !== workspaceId || fa.deleted) throw badRequest('folder not found');
      assertCan(fa.role, 'edit');
    } else {
      assertCan(await wsRole(userId, workspaceId), 'edit');
    }
  }
  app.decorate('canEditTarget', canEditTarget);

  app.post('/api/folders', async (req, reply) => {
    const u = requireUser(req);
    const body = z.object({ workspaceId: z.uuid(), parentId: z.uuid().nullable().optional(), name: z.string().trim().min(1).max(200) }).parse(req.body);
    if (/[\/\\]/.test(body.name)) throw badRequest('folder names cannot contain / or \\');
    await canEditTarget(u.id, body.workspaceId, body.parentId ?? null);
    try {
      const f = await one(
        ctx.db,
        `INSERT INTO folders (workspace_id, parent_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id, parent_id AS "parentId", name, workspace_id AS "workspaceId"`,
        [body.workspaceId, body.parentId ?? null, body.name, u.id],
      );
      await ctx.bus.publish({ type: 'tree-changed', workspaceId: body.workspaceId });
      return reply.code(201).send(f);
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('A folder with this name already exists here');
      throw e;
    }
  });

  app.get('/api/folders/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertUuid(id);
    const fa = await folderAccess(ctx.db, u.id, id);
    assertCan(fa?.role ?? null, 'read');
    // subtree for users who were given access to just this folder
    const folders = await many(
      ctx.db,
      `WITH RECURSIVE sub AS (SELECT id, parent_id, name FROM folders WHERE id = $1 UNION ALL SELECT f.id, f.parent_id, f.name FROM folders f JOIN sub ON f.parent_id = sub.id WHERE f.deleted_at IS NULL)
       SELECT id, parent_id AS "parentId", name FROM sub`,
      [id],
    );
    const documents = await many(
      ctx.db,
      `SELECT d.id, d.folder_id AS "folderId", d.name, COALESCE(d.title, d.name) AS title, d.updated_at AS "updatedAt"
       FROM documents d WHERE d.folder_id = ANY($1::uuid[]) AND d.deleted_at IS NULL AND ${visibleDocSql('d', '$2')} ORDER BY lower(d.name)`,
      [folders.map((f: any) => f.id), u.id],
    );
    return { id, workspaceId: fa!.workspaceId, role: fa!.role, folders, documents };
  });

  app.patch('/api/folders/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertUuid(id);
    const body = z.object({ name: z.string().trim().min(1).max(200).optional(), parentId: z.uuid().nullable().optional() }).parse(req.body);
    const fa = await folderAccess(ctx.db, u.id, id);
    assertCan(fa?.role ?? null, 'edit');
    if (body.name && /[\/\\]/.test(body.name)) throw badRequest('folder names cannot contain / or \\');
    if (body.parentId !== undefined) {
      await canEditTarget(u.id, fa!.workspaceId, body.parentId);
      if (body.parentId) {
        // refuse to move a folder into itself or one of its descendants
        const cycle = await one(
          ctx.db,
          `WITH RECURSIVE sub AS (SELECT id FROM folders WHERE id = $1 UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id) SELECT 1 FROM sub WHERE id = $2`,
          [id, body.parentId],
        );
        if (cycle) throw badRequest('A folder cannot be moved into itself');
      }
    }
    try {
      const f = await one(
        ctx.db,
        `UPDATE folders SET name = COALESCE($2, name), parent_id = CASE WHEN $4 THEN $3::uuid ELSE parent_id END WHERE id = $1 RETURNING id, parent_id AS "parentId", name`,
        [id, body.name ?? null, body.parentId ?? null, body.parentId !== undefined],
      );
      await ctx.bus.publish({ type: 'tree-changed', workspaceId: fa!.workspaceId });
      await safely(ctx, 'reconcile', () => reconcileWorkspace(ctx, fa!.workspaceId));
      return f;
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('A folder with this name already exists here');
      throw e;
    }
  });

  app.delete('/api/folders/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertUuid(id);
    const fa = await folderAccess(ctx.db, u.id, id);
    assertCan(fa?.role ?? null, 'edit');
    await tx(ctx.db, async (c) => {
      const now = (await c.query('SELECT now() AS t')).rows[0].t;
      const sub = await c.query(
        `WITH RECURSIVE sub AS (SELECT id FROM folders WHERE id = $1 UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id WHERE f.deleted_at IS NULL)
         UPDATE folders SET deleted_at = $2 WHERE id IN (SELECT id FROM sub) RETURNING id`,
        [id, now],
      );
      const ids = sub.rows.map((r) => r.id);
      const docs = await c.query('UPDATE documents SET deleted_at = $2 WHERE folder_id = ANY($1::uuid[]) AND deleted_at IS NULL RETURNING id', [ids, now]);
      await c.query('UPDATE links SET target_id = NULL WHERE target_id = ANY($1::uuid[])', [docs.rows.map((r) => r.id)]);
    });
    await ctx.bus.publish({ type: 'tree-changed', workspaceId: fa!.workspaceId });
    await safely(ctx, 'reconcile', () => reconcileWorkspace(ctx, fa!.workspaceId));
    return { ok: true };
  });

  app.post('/api/folders/:id/restore', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertUuid(id);
    const fa = await folderAccess(ctx.db, u.id, id);
    assertCan(fa?.role ?? null, 'edit');
    const f = await one<{ deleted_at: Date | null; parent_id: string | null }>(ctx.db, 'SELECT deleted_at, parent_id FROM folders WHERE id = $1', [id]);
    if (!f?.deleted_at) return { ok: true };
    try {
      await tx(ctx.db, async (c) => {
        const parentOk = f.parent_id ? (await c.query('SELECT 1 FROM folders WHERE id = $1 AND deleted_at IS NULL', [f.parent_id])).rowCount : 1;
        if (!parentOk) await c.query('UPDATE folders SET parent_id = NULL WHERE id = $1', [id]);
        const sub = await c.query(
          `WITH RECURSIVE sub AS (SELECT id FROM folders WHERE id = $1 UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id WHERE f.deleted_at = $2)
           UPDATE folders SET deleted_at = NULL WHERE id IN (SELECT id FROM sub) RETURNING id`,
          [id, f.deleted_at],
        );
        await c.query('UPDATE documents SET deleted_at = NULL WHERE folder_id = ANY($1::uuid[]) AND deleted_at = $2', [
          sub.rows.map((r) => r.id),
          f.deleted_at,
        ]);
        // re-link references to restored documents
        await c.query(
          `UPDATE links l SET target_id = d.id FROM documents d, documents s
           WHERE l.target_id IS NULL AND l.source_id = s.id AND s.workspace_id = d.workspace_id AND d.workspace_id = $1
             AND d.deleted_at IS NULL AND lower(d.name) = lower(l.target_name)`,
          [fa!.workspaceId],
        );
      });
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('An item with the same name already exists where this folder would be restored');
      throw e;
    }
    await ctx.bus.publish({ type: 'tree-changed', workspaceId: fa!.workspaceId });
    await safely(ctx, 'reconcile', () => reconcileWorkspace(ctx, fa!.workspaceId));
    return { ok: true };
  });

  // ---- cross-workspace views ----
  app.get('/api/search', async (req) => {
    const u = requireUser(req);
    const q = z
      .object({
        q: z.string().trim().min(1).max(200),
        workspaceId: z.uuid().optional(),
        tag: z.string().optional(),
        limit: z.coerce.number().min(1).max(100).default(30),
      })
      .parse(req.query);
    return many(
      ctx.db,
      `WITH RECURSIVE ${ACCESSIBLE_DOCS_CTE},
       query AS (SELECT websearch_to_tsquery('english', $2) AS en, websearch_to_tsquery('simple', $2) AS si)
       SELECT d.id, d.name, COALESCE(d.title, d.name) AS title, d.workspace_id AS "workspaceId", w.name AS "workspaceName", d.updated_at AS "updatedAt",
         ts_rank(d.search, query.en) + ts_rank(d.search, query.si) + CASE WHEN d.name ILIKE '%' || $2 || '%' THEN 1 ELSE 0 END AS rank,
         ts_headline('english', d.search_text, query.en, 'MaxFragments=2, MaxWords=18, MinWords=6, StartSel=<mark>, StopSel=</mark>') AS snippet
       FROM documents d JOIN workspaces w ON w.id = d.workspace_id, query
       WHERE d.id IN (SELECT id FROM acc) AND d.deleted_at IS NULL
         AND ($3::uuid IS NULL OR d.workspace_id = $3)
         AND (d.search @@ query.en OR d.search @@ query.si OR d.name ILIKE '%' || $2 || '%')
       ORDER BY rank DESC, d.updated_at DESC LIMIT $4`,
      [u.id, q.q, q.workspaceId ?? null, q.limit],
    );
  });

  app.get('/api/tags/:tag', async (req) => {
    const u = requireUser(req);
    const { tag } = req.params as { tag: string };
    const { workspaceId } = req.query as { workspaceId?: string };
    return many(
      ctx.db,
      `WITH RECURSIVE ${ACCESSIBLE_DOCS_CTE}
       SELECT d.id, d.name, COALESCE(d.title, d.name) AS title, d.workspace_id AS "workspaceId", d.updated_at AS "updatedAt",
         ARRAY(SELECT tag FROM doc_tags WHERE document_id = d.id ORDER BY tag) AS tags
       FROM doc_tags t JOIN documents d ON d.id = t.document_id
       WHERE (t.tag = lower($2) OR t.tag LIKE lower($2) || '/%') AND d.deleted_at IS NULL AND d.id IN (SELECT id FROM acc)
         AND ($3::uuid IS NULL OR d.workspace_id = $3)
       GROUP BY d.id ORDER BY d.updated_at DESC LIMIT 200`,
      [u.id, tag, workspaceId ?? null],
    );
  });

  app.get('/api/recent', async (req) => {
    const u = requireUser(req);
    return many(
      ctx.db,
      `WITH RECURSIVE ${ACCESSIBLE_DOCS_CTE}
       SELECT d.id, d.name, COALESCE(d.title, d.name) AS title, d.workspace_id AS "workspaceId", w.name AS "workspaceName", d.updated_at AS "updatedAt",
         (SELECT display_name FROM users WHERE id = d.updated_by) AS "updatedByName"
       FROM documents d JOIN workspaces w ON w.id = d.workspace_id
       WHERE d.id IN (SELECT id FROM acc) AND d.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT 20`,
      [u.id],
    );
  });

  app.get('/api/shared', async (req) => {
    const u = requireUser(req);
    return many(
      ctx.db,
      `SELECT p.resource_type AS type, p.resource_id AS id, p.role, p.created_at AS "sharedAt",
         COALESCE((SELECT COALESCE(title, name) FROM documents WHERE id = p.resource_id AND deleted_at IS NULL), (SELECT name FROM folders WHERE id = p.resource_id AND deleted_at IS NULL)) AS name,
         COALESCE((SELECT workspace_id FROM documents WHERE id = p.resource_id), (SELECT workspace_id FROM folders WHERE id = p.resource_id)) AS "workspaceId",
         (SELECT display_name FROM users WHERE id = p.created_by) AS "sharedByName"
       FROM permissions p WHERE p.user_id = $1 ORDER BY p.created_at DESC`,
      [u.id],
    ).then((rows) => rows.filter((r: any) => r.name));
  });

  void can;
}

declare module 'fastify' {
  interface FastifyInstance {
    canEditTarget: (userId: string, workspaceId: string, folderId: string | null) => Promise<void>;
  }
}
