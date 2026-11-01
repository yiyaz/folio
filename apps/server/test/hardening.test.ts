import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import WebSocket from 'ws';
import { Client, createDoc, createTestEnv, personalWorkspace, signup, type TestEnv } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { runMaintenance } from '../src/services/maintenance.js';

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listFiles(p).map((f) => path.join(e, f)));
    else out.push(path.relative(dir, p));
  }
  return out;
}

describe('crash-safe storage', () => {
  let env: TestEnv;
  let alice: Client;
  let ws: string;
  beforeAll(async () => {
    env = await createTestEnv();
    alice = await signup(env.app, 'alice');
    ws = await personalWorkspace(alice);
  });
  afterAll(() => env.close());

  async function referencedKeys(): Promise<Set<string>> {
    const db = new pg.Client({ connectionString: env.dbUrl });
    await db.connect();
    const r = await db.query('SELECT storage_key FROM documents UNION SELECT storage_key FROM revisions');
    await db.end();
    return new Set(r.rows.map((x) => x.storage_key));
  }
  const storedBlobs = () => listFiles(env.cfg.STORAGE_FS_ROOT).filter((f) => f.endsWith('.md'));

  it('never overwrites content in place and leaves no orphaned blobs', async () => {
    const d = await createDoc(alice, ws, 'Immutable', 'v1');
    const first = (await alice.get(`/api/documents/${d.id}/revisions`)).data[0];
    for (let v = 1; v <= 5; v++) await alice.put(`/api/documents/${d.id}/content`, { content: `v${v + 1}`, baseVersion: v });
    // coalesced into one revision; the superseded blobs were garbage-collected
    expect(storedBlobs().sort()).toEqual([...(await referencedKeys())].sort());
    expect((await alice.get(`/api/documents/${d.id}/revisions`)).data[0].id).toBe(first.id);
    expect((await alice.get(`/api/documents/${d.id}`)).data.content).toBe('v6');
  });

  it('a rejected (conflicting) save changes nothing and leaves no blob behind', async () => {
    const d = await createDoc(alice, ws, 'Conflicted', 'original');
    const before = storedBlobs().length;
    const r = await alice.put(`/api/documents/${d.id}/content`, { content: 'stale edit', baseVersion: 99 });
    expect(r.statusCode).toBe(409);
    expect(storedBlobs().length).toBe(before);
    expect((await alice.get(`/api/documents/${d.id}`)).data.content).toBe('original');
  });

  it('keeps older revisions readable when a different author saves', async () => {
    const bob = await signup(env.app, 'bob');
    const d = await createDoc(alice, ws, 'Shared history', 'by alice');
    await alice.post(`/api/documents/${d.id}/permissions`, { user: 'bob', role: 'editor' });
    await bob.put(`/api/documents/${d.id}/content`, { content: 'by bob', baseVersion: 1 });
    const revs = (await alice.get(`/api/documents/${d.id}/revisions`)).data;
    expect(revs).toHaveLength(2);
    expect((await alice.get(`/api/documents/${d.id}/revisions/${revs[1].id}`)).data.content).toBe('by alice');
    expect(storedBlobs().sort()).toEqual([...(await referencedKeys())].sort());
  });

  it('removes every blob when a document is deleted permanently', async () => {
    const d = await createDoc(alice, ws, 'Doomed', 'x');
    await alice.put(`/api/documents/${d.id}/content`, { content: 'y', baseVersion: 1 });
    await alice.del(`/api/documents/${d.id}`);
    await alice.del(`/api/documents/${d.id}/permanent`);
    expect(storedBlobs().some((f) => f.includes(d.id))).toBe(false);
  });
});

describe('client IP and rate limiting behind proxies', () => {
  const attempt = (env: TestEnv, ip: string) =>
    env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-requested-with': 'folio', 'x-forwarded-for': ip },
      payload: { login: 'nobody', password: 'wrong-password' },
    });

  it('ignores X-Forwarded-For by default, so spoofed IPs cannot bypass the limit', async () => {
    const env = await createTestEnv({ RATE_LIMIT_AUTH_PER_MIN: '2' });
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await attempt(env, `10.0.0.${i}`)).statusCode);
      expect(codes.slice(2)).toEqual([429, 429]);
    } finally {
      await env.close();
    }
  });

  it('uses the forwarded client IP when the request comes from a trusted proxy', async () => {
    const env = await createTestEnv({ RATE_LIMIT_AUTH_PER_MIN: '2', TRUST_PROXY: 'loopback' });
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await attempt(env, `10.0.0.${i}`)).statusCode);
      expect(codes).toEqual([401, 401, 401, 401]);
    } finally {
      await env.close();
    }
  });
});

describe('websocket hardening', () => {
  let env: TestEnv;
  let url: string;
  let cookie: string;
  beforeAll(async () => {
    env = await createTestEnv();
    cookie = (await signup(env.app, 'wsuser')).cookie;
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(env.app.server.address() as { port: number }).port}/api/ws`;
  });
  afterAll(() => env.close());
  const closeCode = (sock: WebSocket) => new Promise<number>((res) => sock.on('close', (c) => res(c)));

  it('rejects handshakes from other origins (cross-site WebSocket hijacking)', async () => {
    expect(await closeCode(new WebSocket(url, { headers: { cookie, origin: 'https://evil.example' } }))).toBe(4403);
  });

  it('accepts the configured origin', async () => {
    const sock = new WebSocket(url, { headers: { cookie, origin: 'http://folio.test' } });
    await new Promise((res) => sock.on('open', res));
    sock.send(JSON.stringify({ type: 'ping' }));
    const msg = await new Promise<string>((res) => sock.on('message', (m) => res(String(m))));
    expect(JSON.parse(msg)).toEqual({ type: 'pong' });
    sock.close();
  });

  it('drops oversized messages', async () => {
    const sock = new WebSocket(url, { headers: { cookie } });
    await new Promise((res) => sock.on('open', res));
    const code = closeCode(sock);
    sock.send('x'.repeat(100 * 1024));
    expect(await code).toBe(1009); // message too big
  });
});

describe('maintenance', () => {
  it('purges expired sessions and tokens, and only one replica runs it at a time', async () => {
    const env = await createTestEnv();
    try {
      const u = await signup(env.app, 'maint');
      const db = new pg.Pool({ connectionString: env.dbUrl });
      await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('expired', $1, now() - interval '1 day')`, [u.user.id]);
      await db.query(`INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES ('old', $1, 'verify', now() - interval '3 days')`, [u.user.id]);
      try {
        // another replica holding the lock: this one skips
        const other = await db.connect();
        await other.query('SELECT pg_advisory_lock(727275)');
        expect(await runMaintenance(db)).toBeNull();
        await other.query('SELECT pg_advisory_unlock(727275)');
        other.release();

        expect(await runMaintenance(db)).toMatchObject({ sessions: 1, emailTokens: 1 });
        expect((await u.get('/api/auth/me')).statusCode).toBe(200); // live session untouched
      } finally {
        await db.end();
      }
    } finally {
      await env.close();
    }
  });
});

describe('configuration validation', () => {
  it('refuses insecure production settings', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/APP_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', APP_SECRET: 'short-but-not-dev-secret' })).toThrow(/32/);
    expect(() => loadConfig({ NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40), PUBLIC_URL: 'https://a.example', COOKIE_SECURE: 'false' })).toThrow(
      /COOKIE_SECURE/,
    );
    expect(() => loadConfig({ PUBLIC_URL: 'not a url' })).toThrow(/PUBLIC_URL/);
  });

  it('derives secure cookies from an https PUBLIC_URL', () => {
    expect(loadConfig({ PUBLIC_URL: 'https://docs.example.com' }).COOKIE_SECURE).toBe(true);
    expect(loadConfig({ PUBLIC_URL: 'http://localhost:3000' }).COOKIE_SECURE).toBe(false);
  });
});
