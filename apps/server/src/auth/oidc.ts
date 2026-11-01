import type { FastifyInstance } from 'fastify';
import { Issuer, generators, type Client } from 'openid-client';
import type { AppContext } from '../context.js';
import { one } from '../db.js';
import { createUser, startSession } from './routes.js';
import { getSignupSettings } from './settings.js';

const STATE_COOKIE = 'folio_oidc';

export const oidcEnabled = (ctx: AppContext) => !!(ctx.cfg.OIDC_ISSUER && ctx.cfg.OIDC_CLIENT_ID);

function sanitizeUsername(s: string): string {
  const base = s.toLowerCase().replace(/@.*$/, '').replace(/[^a-z0-9_.-]/g, '').replace(/^[.-]+|[.-]+$/g, '');
  return (base.length >= 3 ? base : `user${base}`).slice(0, 28);
}

export async function registerOidc(app: FastifyInstance) {
  const ctx = app.ctx;
  if (!oidcEnabled(ctx)) return;
  let client: Client | null = null;
  const redirectUri = `${ctx.cfg.PUBLIC_URL}/api/auth/oidc/callback`;

  const getClient = async () => {
    if (client) return client;
    const issuer = await Issuer.discover(ctx.cfg.OIDC_ISSUER!);
    client = new issuer.Client({
      client_id: ctx.cfg.OIDC_CLIENT_ID!,
      client_secret: ctx.cfg.OIDC_CLIENT_SECRET,
      redirect_uris: [redirectUri],
      response_types: ['code'],
      token_endpoint_auth_method: ctx.cfg.OIDC_CLIENT_SECRET ? 'client_secret_basic' : 'none',
    });
    return client;
  };

  app.get('/api/auth/oidc/start', async (_req, reply) => {
    const c = await getClient();
    const state = generators.state();
    const nonce = generators.nonce();
    const verifier = generators.codeVerifier();
    reply.setCookie(STATE_COOKIE, JSON.stringify({ state, nonce, verifier }), {
      path: '/api/auth/oidc',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.cfg.COOKIE_SECURE,
      signed: true,
      maxAge: 600,
    });
    return reply.redirect(
      c.authorizationUrl({ scope: 'openid email profile', state, nonce, code_challenge: generators.codeChallenge(verifier), code_challenge_method: 'S256' }),
    );
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const raw = req.cookies[STATE_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value) return reply.redirect('/login?error=oidc_state');
    const saved = JSON.parse(unsigned.value) as { state: string; nonce: string; verifier: string };
    reply.clearCookie(STATE_COOKIE, { path: '/api/auth/oidc' });
    const c = await getClient();
    let claims: Record<string, any>;
    try {
      const tokens = await c.callback(redirectUri, c.callbackParams(req.raw), { state: saved.state, nonce: saved.nonce, code_verifier: saved.verifier });
      claims = tokens.claims();
    } catch (err) {
      req.log.warn({ err }, 'oidc callback failed');
      return reply.redirect('/login?error=oidc');
    }
    const sub = `${ctx.cfg.OIDC_ISSUER}|${claims.sub}`;
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    let user = await one<{ id: string }>(ctx.db, 'SELECT id FROM users WHERE oidc_sub = $1 AND disabled_at IS NULL', [sub]);
    if (!user && email && claims.email_verified !== false) {
      // link to an existing account with the same (IdP-verified) e-mail
      user = await one<{ id: string }>(ctx.db, 'UPDATE users SET oidc_sub = $2, email_verified_at = COALESCE(email_verified_at, now()) WHERE lower(email) = $1 AND oidc_sub IS NULL RETURNING id', [email, sub]);
    }
    if (!user) {
      const settings = await getSignupSettings(ctx);
      if (settings.mode === 'closed' || !email) return reply.redirect('/login?error=oidc_signup');
      if (settings.mode === 'domain' && !settings.allowedDomains.includes(email.split('@')[1])) return reply.redirect('/login?error=oidc_domain');
      let username = sanitizeUsername(claims.preferred_username || email);
      for (let i = 2; await one(ctx.db, 'SELECT 1 FROM users WHERE lower(username) = $1', [username]); i++) username = `${sanitizeUsername(claims.preferred_username || email)}${i}`;
      const created = await createUser(ctx, { email, username, displayName: claims.name || username, passwordHash: null, verified: true, oidcSub: sub });
      user = { id: created.id };
    }
    await startSession(ctx, reply, user.id, req.headers['user-agent']);
    return reply.redirect('/');
  });
}
