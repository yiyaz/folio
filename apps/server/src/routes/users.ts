import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../auth/plugin.js';
import { publicMe } from '../auth/routes.js';
import { getSignupSettings, setSignupSettings } from '../auth/settings.js';
import { many, one } from '../db.js';
import { keys, NotFoundInStorage } from '../storage/index.js';
import { randomToken, sha256 } from '../crypto/tokens.js';
import { badRequest, notFound } from '../errors.js';
import { USER_COLUMNS, toAuthUser, type UserRow } from '../services/users.js';

const AVATAR_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export async function registerUserRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.patch('/api/users/me', async (req) => {
    const u = requireUser(req);
    const body = z
      .object({
        displayName: z.string().trim().min(1).max(80).optional(),
        prefs: z
          .object({
            editorMode: z.enum(['live', 'source', 'split', 'read']).optional(),
            keymap: z.enum(['default', 'vim', 'emacs']).optional(),
            theme: z.enum(['system', 'light', 'dark']).optional(),
            emailNotifications: z.boolean().optional(),
            lineNumbers: z.boolean().optional(),
          })
          .optional(),
      })
      .parse(req.body);
    const row = await one<UserRow>(
      ctx.db,
      `UPDATE users u SET display_name = COALESCE($2, display_name), prefs = prefs || $3::jsonb WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [u.id, body.displayName ?? null, JSON.stringify(body.prefs ?? {})],
    );
    return { user: publicMe(toAuthUser(row!, u.via)) };
  });

  app.post('/api/users/me/avatar', async (req) => {
    const u = requireUser(req);
    const file = await req.file({ limits: { fileSize: 2 * 1024 * 1024 } });
    if (!file) throw badRequest('file is required');
    if (!AVATAR_MIME.includes(file.mimetype)) throw badRequest('avatar must be a PNG, JPEG, WebP or GIF image');
    const buf = await file.toBuffer();
    await ctx.storage.put(keys.avatar(u.id), buf, file.mimetype);
    await ctx.db.query('UPDATE users SET avatar_key = $2 WHERE id = $1', [u.id, file.mimetype]);
    return { ok: true };
  });

  app.get('/api/users/:id/avatar', async (req, reply) => {
    requireUser(req);
    const { id } = req.params as { id: string };
    const row = await one<{ id: string; avatar_key: string | null }>(
      ctx.db,
      'SELECT id, avatar_key FROM users WHERE id::text = $1 OR lower(username) = lower($1)',
      [id],
    );
    if (!row?.avatar_key) throw notFound();
    try {
      const buf = await ctx.storage.get(keys.avatar(row.id));
      return reply.type(row.avatar_key).header('cache-control', 'private, max-age=300').send(buf);
    } catch (e) {
      if (e instanceof NotFoundInStorage) throw notFound();
      throw e;
    }
  });

  /** Autocomplete for @mentions and the share dialog. */
  app.get('/api/users/search', async (req) => {
    requireUser(req);
    const { q = '' } = req.query as { q?: string };
    const term = q.trim().replace(/^@/, '');
    return many(
      ctx.db,
      `SELECT id, username, display_name AS "displayName", (avatar_key IS NOT NULL) AS "hasAvatar" FROM users
       WHERE disabled_at IS NULL AND ($1 = '' OR username ILIKE $1 || '%' OR display_name ILIKE '%' || $1 || '%' OR lower(email) = lower($1))
       ORDER BY username LIMIT 10`,
      [term.replace(/[%_\\]/g, '\\$&')],
    );
  });

  app.get('/api/users/by-username/:username', async (req) => {
    requireUser(req);
    const { username } = req.params as { username: string };
    const u = await one(
      ctx.db,
      `SELECT id, username, display_name AS "displayName", (avatar_key IS NOT NULL) AS "hasAvatar", created_at AS "createdAt" FROM users WHERE lower(username) = lower($1)`,
      [username],
    );
    if (!u) throw notFound('User not found');
    return u;
  });

  // ---- personal access tokens (for the REST API and the CLI) ----
  app.get('/api/tokens', async (req) => {
    const u = requireUser(req);
    return many(
      ctx.db,
      `SELECT id, name, prefix, last_used_at AS "lastUsedAt", created_at AS "createdAt" FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
      [u.id],
    );
  });

  app.post('/api/tokens', async (req, reply) => {
    const u = requireUser(req);
    if (u.via === 'token') throw badRequest('API tokens cannot create other tokens');
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const token = `folio_${randomToken(24)}`;
    const row = await one(
      ctx.db,
      `INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES ($1, $2, $3, $4) RETURNING id, name, prefix, created_at AS "createdAt"`,
      [u.id, name, sha256(token), token.slice(0, 12)],
    );
    return reply.code(201).send({ ...row, token });
  });

  app.delete('/api/tokens/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    await ctx.db.query('DELETE FROM api_tokens WHERE id::text = $1 AND user_id = $2', [id, u.id]);
    return { ok: true };
  });

  // ---- administration ----
  app.get('/api/admin/settings', async (req) => {
    requireAdmin(req);
    return { signup: await getSignupSettings(ctx) };
  });

  app.put('/api/admin/settings', async (req) => {
    requireAdmin(req);
    const body = z
      .object({
        signup: z.object({ mode: z.enum(['open', 'invite', 'domain', 'closed']), allowedDomains: z.array(z.string().trim().toLowerCase().min(1)).max(50) }),
      })
      .parse(req.body);
    await setSignupSettings(ctx, body.signup);
    return { signup: body.signup };
  });

  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    return many(
      ctx.db,
      `SELECT id, email, username, display_name AS "displayName", is_admin AS "isAdmin", email_verified_at IS NOT NULL AS "emailVerified", disabled_at AS "disabledAt", created_at AS "createdAt" FROM users ORDER BY created_at`,
    );
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = z.object({ isAdmin: z.boolean().optional(), disabled: z.boolean().optional() }).parse(req.body);
    if (id === admin.id && (body.isAdmin === false || body.disabled)) throw badRequest('You cannot demote or disable yourself');
    await ctx.db.query(
      `UPDATE users SET is_admin = COALESCE($2, is_admin), disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN now() ELSE NULL END WHERE id::text = $1`,
      [id, body.isAdmin ?? null, body.disabled ?? null],
    );
    if (body.disabled) await ctx.db.query('DELETE FROM sessions WHERE user_id::text = $1', [id]);
    return { ok: true };
  });

  app.post('/api/admin/invites', async (req, reply) => {
    const admin = requireAdmin(req);
    const { email } = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) }).parse(req.body);
    const token = randomToken();
    await ctx.db.query('INSERT INTO invites (token_hash, email, invited_by) VALUES ($1, $2, $3)', [sha256(token), email, admin.id]);
    const link = `${ctx.cfg.PUBLIC_URL}/signup?invite=${token}&email=${encodeURIComponent(email)}`;
    await ctx.mailer.send({
      to: email,
      subject: `${admin.displayName} invited you to Folio`,
      text: `You've been invited to Folio.\n\nCreate your account: ${link}`,
    });
    return reply.code(201).send({ ok: true, link });
  });
}
