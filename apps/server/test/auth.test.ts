import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestEnv, signup, type TestEnv } from './helpers.js';

describe('authentication & accounts', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({ REQUIRE_EMAIL_VERIFICATION: 'true' });
  });
  afterAll(() => env.close());

  it('makes the first user an admin and signs them in without e-mail verification', async () => {
    const c = new Client(env.app);
    const r = await c.post('/api/auth/signup', { email: 'Admin@Example.com', username: 'admin', displayName: 'Admin', password: 'password-123456' });
    expect(r.statusCode).toBe(201);
    expect(r.data.user).toMatchObject({ email: 'admin@example.com', isAdmin: true, emailVerified: true });
    expect(r.data.verificationRequired).toBe(false);
    const me = await c.get('/api/auth/me');
    expect(me.data.user.username).toBe('admin');
    // a personal workspace with seeded docs was created
    const ws = await c.get('/api/workspaces');
    expect(ws.data).toHaveLength(1);
    const tree = await c.get(`/api/workspaces/${ws.data[0].id}/tree`);
    expect(tree.data.documents.map((d: any) => d.name).sort()).toEqual(['Getting started', 'Welcome to Folio']);
  });

  it('requires e-mail verification for later users', async () => {
    const c = new Client(env.app);
    const r = await c.post('/api/auth/signup', { email: 'bob@example.com', username: 'bob', displayName: 'Bob', password: 'password-123456' });
    expect(r.statusCode).toBe(201);
    expect(r.data.verificationRequired).toBe(true);
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);

    const login = await c.post('/api/auth/login', { login: 'bob', password: 'password-123456' });
    expect(login.statusCode).toBe(403);
    expect(login.data.error).toBe('email_unverified');

    const token = env.mailer.tokenFor('bob@example.com', '/verify');
    expect((await c.post('/api/auth/verify', { token })).statusCode).toBe(200);
    expect((await c.get('/api/auth/me')).data.user.emailVerified).toBe(true);
    // tokens are single use
    expect((await new Client(env.app).post('/api/auth/verify', { token })).statusCode).toBe(400);
  });

  it('rejects duplicate e-mails and usernames case-insensitively', async () => {
    const c = new Client(env.app);
    const dupEmail = await c.post('/api/auth/signup', { email: 'BOB@example.com', username: 'bobby', displayName: 'B', password: 'password-123456' });
    expect(dupEmail.statusCode).toBe(409);
    const dupUser = await c.post('/api/auth/signup', { email: 'other@example.com', username: 'BOB', displayName: 'B', password: 'password-123456' });
    expect(dupUser.statusCode).toBe(409);
  });

  it('validates input', async () => {
    const c = new Client(env.app);
    const r = await c.post('/api/auth/signup', { email: 'not-an-email', username: 'x', displayName: '', password: 'short' });
    expect(r.statusCode).toBe(400);
    expect(r.data.error).toBe('validation');
  });

  it('logs in with e-mail or username and rejects bad passwords', async () => {
    expect((await new Client(env.app).post('/api/auth/login', { login: 'admin@example.com', password: 'password-123456' })).statusCode).toBe(200);
    expect((await new Client(env.app).post('/api/auth/login', { login: 'ADMIN', password: 'password-123456' })).statusCode).toBe(200);
    const bad = await new Client(env.app).post('/api/auth/login', { login: 'admin', password: 'wrong-password' });
    expect(bad.statusCode).toBe(401);
    const unknown = await new Client(env.app).post('/api/auth/login', { login: 'nobody', password: 'wrong-password' });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.data.message).toBe(bad.data.message); // no user enumeration
  });

  it('enforces the CSRF header on cookie-authenticated mutations', async () => {
    const c = new Client(env.app);
    await c.post('/api/auth/login', { login: 'admin', password: 'password-123456' });
    c.csrf = false;
    const r = await c.post('/api/workspaces', { name: 'x' });
    expect(r.statusCode).toBe(403);
    expect(r.data.error).toBe('csrf');
  });

  it('resets a password and revokes existing sessions', async () => {
    const session = new Client(env.app);
    await session.post('/api/auth/login', { login: 'bob', password: 'password-123456' });
    expect((await session.get('/api/auth/me')).statusCode).toBe(200);

    const anon = new Client(env.app);
    expect((await anon.post('/api/auth/forgot', { email: 'bob@example.com' })).statusCode).toBe(200);
    expect((await anon.post('/api/auth/forgot', { email: 'ghost@example.com' })).statusCode).toBe(200); // same response
    const token = env.mailer.tokenFor('bob@example.com', '/reset');
    expect((await anon.post('/api/auth/reset', { token, password: 'new-password-999' })).statusCode).toBe(200);

    expect((await session.get('/api/auth/me')).statusCode).toBe(401);
    expect((await new Client(env.app).post('/api/auth/login', { login: 'bob', password: 'password-123456' })).statusCode).toBe(401);
    expect((await new Client(env.app).post('/api/auth/login', { login: 'bob', password: 'new-password-999' })).statusCode).toBe(200);
  });

  it('logs out', async () => {
    const c = new Client(env.app);
    await c.post('/api/auth/login', { login: 'admin', password: 'password-123456' });
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('supports personal API tokens (no CSRF header needed) and revocation', async () => {
    const c = new Client(env.app);
    await c.post('/api/auth/login', { login: 'admin', password: 'password-123456' });
    const t = await c.post('/api/tokens', { name: 'cli' });
    expect(t.statusCode).toBe(201);
    expect(t.data.token).toMatch(/^folio_/);

    const api = new Client(env.app);
    api.csrf = false;
    api.bearer = t.data.token;
    expect((await api.get('/api/auth/me')).data.user.username).toBe('admin');
    expect((await api.post('/api/workspaces', { name: 'From CLI' })).statusCode).toBe(201);
    expect((await api.post('/api/tokens', { name: 'nested' })).statusCode).toBe(400);

    await c.del(`/api/tokens/${t.data.id}`);
    expect((await api.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('applies admin sign-up modes: closed, domain and invite', async () => {
    const admin = new Client(env.app);
    await admin.post('/api/auth/login', { login: 'admin', password: 'password-123456' });
    const user = (n: string, email: string, extra = {}) =>
      new Client(env.app).post('/api/auth/signup', { email, username: n, displayName: n, password: 'password-123456', ...extra });

    await admin.put('/api/admin/settings', { signup: { mode: 'closed', allowedDomains: [] } });
    expect((await user('carol', 'carol@example.com')).statusCode).toBe(403);
    expect((await new Client(env.app).get('/api/auth/config')).data.signupMode).toBe('closed');

    await admin.put('/api/admin/settings', { signup: { mode: 'domain', allowedDomains: ['acme.io'] } });
    expect((await user('carol', 'carol@example.com')).statusCode).toBe(403);
    expect((await user('carol', 'carol@acme.io')).statusCode).toBe(201);

    await admin.put('/api/admin/settings', { signup: { mode: 'invite', allowedDomains: [] } });
    expect((await user('dave', 'dave@example.com')).statusCode).toBe(403);
    const inv = await admin.post('/api/admin/invites', { email: 'dave@example.com' });
    const token = new URL(inv.data.link).searchParams.get('invite')!;
    expect((await user('dave', 'other@example.com', { inviteToken: token })).statusCode).toBe(400);
    const ok = await user('dave', 'dave@example.com', { inviteToken: token });
    expect(ok.statusCode).toBe(201);
    expect(ok.data.verificationRequired).toBe(false); // the invite proves e-mail ownership
    expect((await user('dave2', 'dave@example.com', { inviteToken: token })).statusCode).toBe(400); // single use

    await admin.put('/api/admin/settings', { signup: { mode: 'open', allowedDomains: [] } });
  });

  it('lets only admins use admin endpoints and disable users', async () => {
    const bob = new Client(env.app);
    await bob.post('/api/auth/login', { login: 'bob', password: 'new-password-999' });
    expect((await bob.get('/api/admin/users')).statusCode).toBe(403);

    const admin = new Client(env.app);
    await admin.post('/api/auth/login', { login: 'admin', password: 'password-123456' });
    const users = await admin.get('/api/admin/users');
    const bobId = users.data.find((u: any) => u.username === 'bob').id;
    await admin.patch(`/api/admin/users/${bobId}`, { disabled: true });
    expect((await bob.get('/api/auth/me')).statusCode).toBe(401);
    expect((await new Client(env.app).post('/api/auth/login', { login: 'bob', password: 'new-password-999' })).statusCode).toBe(401);
    expect((await admin.patch(`/api/admin/users/${admin.user?.id ?? users.data[0].id}`, { isAdmin: false })).statusCode).toBe(400);
    await admin.patch(`/api/admin/users/${bobId}`, { disabled: false });
  });
});

describe('auth rate limiting', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({ RATE_LIMIT_AUTH_PER_MIN: '3' });
    await signup(env.app, 'rluser');
  });
  afterAll(() => env.close());

  it('throttles repeated login attempts', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await new Client(env.app).post('/api/auth/login', { login: 'rluser', password: 'wrong-password' })).statusCode);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes[4]).toBe(429);
  });
});
