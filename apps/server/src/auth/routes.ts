import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hash, verify } from '@node-rs/argon2';
import { one, tx } from '../db.js';
import { randomToken, sha256 } from '../crypto.js';
import { badRequest, conflict, HttpError, unauthorized } from '../errors.js';
import { SESSION_COOKIE, requireUser } from './plugin.js';
import { getSignupSettings } from './settings.js';
import { createWorkspace } from '../services/workspaces.js';
import { toAuthUser, USER_COLUMNS, type UserRow } from '../services/users.js';
import type { AppContext, AuthUser } from '../context.js';
import { oidcEnabled, registerOidc } from './oidc.js';

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*[a-zA-Z0-9_]$/, 'letters, numbers, ".", "-" and "_" only');
const passwordSchema = z.string().min(10, 'at least 10 characters').max(256);
const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

export function publicMe(u: AuthUser) {
  const { via: _via, ...rest } = u;
  return rest;
}

export async function startSession(ctx: AppContext, reply: FastifyReply, userId: string, userAgent?: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + ctx.cfg.SESSION_TTL_DAYS * 86400_000);
  await ctx.db.query('INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)', [
    sha256(token),
    userId,
    expires,
    userAgent?.slice(0, 300),
  ]);
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.cfg.COOKIE_SECURE,
    expires,
  });
}

async function issueEmailToken(ctx: AppContext, userId: string, kind: 'verify' | 'reset') {
  const token = randomToken();
  const ttl = kind === 'verify' ? 48 * 3600_000 : 3600_000;
  await ctx.db.query('INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES ($1, $2, $3, $4)', [
    sha256(token),
    userId,
    kind,
    new Date(Date.now() + ttl),
  ]);
  return token;
}

async function consumeEmailToken(ctx: AppContext, token: string, kind: 'verify' | 'reset'): Promise<string> {
  const row = await one<{ user_id: string }>(
    ctx.db,
    `UPDATE email_tokens SET used_at = now() WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [sha256(token), kind],
  );
  if (!row) throw badRequest('This link is invalid or has expired');
  return row.user_id;
}

async function sendVerification(ctx: AppContext, user: { id: string; email: string }) {
  const token = await issueEmailToken(ctx, user.id, 'verify');
  await ctx.mailer.send({
    to: user.email,
    subject: 'Verify your Folio e-mail address',
    text: `Welcome to Folio!\n\nConfirm your e-mail address by opening this link:\n${ctx.cfg.PUBLIC_URL}/verify?token=${token}\n\nThe link is valid for 48 hours.`,
  });
}

/** Create a user, their personal workspace, and apply a pending invite. */
export async function createUser(
  ctx: AppContext,
  input: { email: string; username: string; displayName: string; passwordHash: string | null; verified: boolean; oidcSub?: string; inviteHash?: string },
): Promise<AuthUser> {
  const row = await tx(ctx.db, async (c) => {
    const first = !(await one(c, 'SELECT 1 FROM users LIMIT 1'));
    let row: UserRow;
    try {
      row = (await one<UserRow>(
        c,
        `INSERT INTO users (email, username, display_name, password_hash, email_verified_at, is_admin, oidc_sub)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${USER_COLUMNS.replaceAll('u.', '')}`,
        [input.email, input.username, input.displayName, input.passwordHash, input.verified || first ? new Date() : null, first, input.oidcSub ?? null],
      ))!;
    } catch (e: any) {
      if (e?.code === '23505') {
        throw conflict(String(e.constraint).includes('email') ? 'An account with this e-mail already exists' : 'This username is taken');
      }
      throw e;
    }
    if (input.inviteHash) {
      const inv = await one<{ workspace_id: string | null; role: string | null }>(
        c,
        'UPDATE invites SET used_at = now() WHERE token_hash = $1 RETURNING workspace_id, role',
        [input.inviteHash],
      );
      if (inv?.workspace_id) {
        await c.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
          inv.workspace_id,
          row.id,
          inv.role ?? 'editor',
        ]);
      }
    }
    return row;
  });
  const user = toAuthUser(row, 'session');
  await createWorkspace(ctx, user, `${user.displayName}'s workspace`, { seed: true });
  return user;
}

export async function registerAuthRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const authLimit = { config: { rateLimit: { max: ctx.cfg.RATE_LIMIT_AUTH_PER_MIN, timeWindow: '1 minute' } } };

  app.get('/api/auth/config', async () => {
    const s = await getSignupSettings(ctx);
    const noUsers = !(await one(ctx.db, 'SELECT 1 FROM users LIMIT 1'));
    return {
      signupMode: noUsers ? 'open' : s.mode,
      oidc: oidcEnabled(ctx) ? { name: ctx.cfg.OIDC_NAME } : null,
      requireEmailVerification: ctx.cfg.REQUIRE_EMAIL_VERIFICATION,
    };
  });

  app.post('/api/auth/signup', authLimit, async (req, reply) => {
    const body = z
      .object({
        email: emailSchema,
        username: usernameSchema,
        displayName: z.string().trim().min(1).max(80),
        password: passwordSchema,
        inviteToken: z.string().optional(),
      })
      .parse(req.body);
    const settings = await getSignupSettings(ctx);
    const noUsers = !(await one(ctx.db, 'SELECT 1 FROM users LIMIT 1'));
    let inviteHash: string | undefined;
    if (body.inviteToken) {
      const inv = await one<{ email: string }>(ctx.db, 'SELECT email FROM invites WHERE token_hash = $1 AND used_at IS NULL', [sha256(body.inviteToken)]);
      if (!inv) throw badRequest('This invitation is invalid or was already used');
      if (inv.email.toLowerCase() !== body.email) throw badRequest('This invitation was sent to a different e-mail address');
      inviteHash = sha256(body.inviteToken);
    }
    if (!noUsers && !inviteHash) {
      if (settings.mode === 'closed' || settings.mode === 'invite') throw new HttpError(403, 'signup_disabled', 'Sign-up is by invitation only');
      if (settings.mode === 'domain' && !settings.allowedDomains.includes(body.email.split('@')[1])) {
        throw new HttpError(403, 'signup_domain', `Sign-up is restricted to: ${settings.allowedDomains.join(', ')}`);
      }
    }
    const verified = !ctx.cfg.REQUIRE_EMAIL_VERIFICATION || !!inviteHash; // invite links prove e-mail ownership
    const user = await createUser(ctx, {
      email: body.email,
      username: body.username,
      displayName: body.displayName,
      passwordHash: await hash(body.password, ARGON),
      verified,
      inviteHash,
    });
    if (!user.emailVerified) {
      await sendVerification(ctx, user);
      return reply.code(201).send({ user: publicMe(user), verificationRequired: true });
    }
    await startSession(ctx, reply, user.id, req.headers['user-agent']);
    return reply.code(201).send({ user: publicMe(user), verificationRequired: false });
  });

  app.post('/api/auth/login', authLimit, async (req, reply) => {
    const body = z.object({ login: z.string().trim().min(1), password: z.string().min(1) }).parse(req.body);
    const row = await one<UserRow & { password_hash: string | null; disabled_at: Date | null }>(
      ctx.db,
      `SELECT ${USER_COLUMNS}, u.password_hash, u.disabled_at FROM users u WHERE lower(u.email) = lower($1) OR lower(u.username) = lower($1)`,
      [body.login],
    );
    // verify against a dummy hash when the user is unknown to keep timing similar
    const ok = row?.password_hash ? await verify(row.password_hash, body.password).catch(() => false) : (await hash('dummy-password', ARGON), false);
    if (!row || !ok || row.disabled_at) throw unauthorized('Invalid e-mail/username or password');
    if (!row.email_verified_at && ctx.cfg.REQUIRE_EMAIL_VERIFICATION) {
      throw new HttpError(403, 'email_unverified', 'Please verify your e-mail address first. Check your inbox for the link.');
    }
    await startSession(ctx, reply, row.id, req.headers['user-agent']);
    return { user: publicMe(toAuthUser(row, 'session')) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await ctx.db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const u = requireUser(req);
    return { user: publicMe(u) };
  });

  app.post('/api/auth/verify', authLimit, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const userId = await consumeEmailToken(ctx, token, 'verify');
    await ctx.db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [userId]);
    await startSession(ctx, reply, userId, req.headers['user-agent']);
    return { ok: true };
  });

  app.post('/api/auth/resend-verification', authLimit, async (req) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    const u = await one<{ id: string; email: string; email_verified_at: Date | null }>(
      ctx.db,
      'SELECT id, email, email_verified_at FROM users WHERE lower(email) = $1',
      [email],
    );
    if (u && !u.email_verified_at) await sendVerification(ctx, u);
    return { ok: true }; // never reveal whether the account exists
  });

  app.post('/api/auth/forgot', authLimit, async (req) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    const u = await one<{ id: string; email: string }>(ctx.db, 'SELECT id, email FROM users WHERE lower(email) = $1 AND disabled_at IS NULL', [email]);
    if (u) {
      const token = await issueEmailToken(ctx, u.id, 'reset');
      await ctx.mailer.send({
        to: u.email,
        subject: 'Reset your Folio password',
        text: `Someone (hopefully you) asked to reset your Folio password.\n\nOpen this link within one hour:\n${ctx.cfg.PUBLIC_URL}/reset?token=${token}\n\nIf you didn't request this, you can ignore this e-mail.`,
      });
    }
    return { ok: true };
  });

  app.post('/api/auth/reset', authLimit, async (req) => {
    const body = z.object({ token: z.string().min(10), password: passwordSchema }).parse(req.body);
    const userId = await consumeEmailToken(ctx, body.token, 'reset');
    await ctx.db.query('UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [
      userId,
      await hash(body.password, ARGON),
    ]);
    await ctx.db.query('DELETE FROM sessions WHERE user_id = $1', [userId]); // log out everywhere
    return { ok: true };
  });

  app.post('/api/auth/change-password', authLimit, async (req) => {
    const u = requireUser(req);
    const body = z.object({ currentPassword: z.string(), newPassword: passwordSchema }).parse(req.body);
    const row = await one<{ password_hash: string | null }>(ctx.db, 'SELECT password_hash FROM users WHERE id = $1', [u.id]);
    if (row?.password_hash && !(await verify(row.password_hash, body.currentPassword).catch(() => false))) throw badRequest('Current password is incorrect');
    await ctx.db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hash(body.newPassword, ARGON)]);
    return { ok: true };
  });

  await registerOidc(app);
}
