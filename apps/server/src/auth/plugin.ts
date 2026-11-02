import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sha256 } from '../crypto/tokens.js';
import { one } from '../db.js';
import { HttpError, unauthorized } from '../errors.js';
import { USER_COLUMNS, toAuthUser, type UserRow } from '../services/users.js';

export const SESSION_COOKIE = 'folio_session';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'folio';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    req.user = null;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      const row = await one<UserRow & { token_id: string }>(
        app.ctx.db,
        `SELECT ${USER_COLUMNS}, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = $1 AND u.disabled_at IS NULL`,
        [sha256(token)],
      );
      if (!row) throw unauthorized('Invalid API token');
      app.ctx.db.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.token_id]).catch(() => {});
      req.user = toAuthUser(row, 'token');
      return;
    }

    if (req.url.startsWith('/api/') && MUTATING.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      throw new HttpError(403, 'csrf', 'Missing CSRF header');
    }

    const cookie = req.cookies[SESSION_COOKIE];
    if (!cookie) return;
    const row = await one<UserRow>(
      app.ctx.db,
      `SELECT ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [sha256(cookie)],
    );
    if (row) req.user = toAuthUser(row, 'session');
  });
}

export function requireUser(req: FastifyRequest) {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAdmin(req: FastifyRequest) {
  const u = requireUser(req);
  if (!u.isAdmin) throw new HttpError(403, 'forbidden', 'Administrator access required');
  return u;
}
