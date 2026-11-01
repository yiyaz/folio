import { inject } from 'vitest';
import pg from 'pg';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildOptions } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Mail, Mailer } from '../src/mail.js';

export class MemoryMailer implements Mailer {
  sent: Mail[] = [];
  async send(m: Mail) {
    this.sent.push(m);
  }
  last(to: string) {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
  tokenFor(to: string, pathPart: string): string {
    const m = this.last(to);
    const match = m && new RegExp(`${pathPart}\\?token=([\\w-]+)`).exec(m.text);
    if (!match) throw new Error(`no ${pathPart} mail for ${to}`);
    return match[1];
  }
}

export interface TestEnv {
  app: FastifyInstance;
  mailer: MemoryMailer;
  cfg: Config;
  dbUrl: string;
  close: () => Promise<void>;
}

export async function createTestEnv(env: Record<string, string> = {}, opts: BuildOptions = {}): Promise<TestEnv> {
  const base = inject('pgUrl');
  const dbName = `folio_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  const storageDir = mkdtempSync(path.join(os.tmpdir(), 'folio-test-storage-'));
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url.toString(),
    DATABASE_POOL_MAX: '5',
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_ROOT: storageDir,
    REQUIRE_EMAIL_VERIFICATION: 'false',
    RATE_LIMIT_AUTH_PER_MIN: '1000',
    APP_SECRET: 'test-secret-test-secret-test-secret',
    PUBLIC_URL: 'http://folio.test',
    ...env,
  });
  const mailer = new MemoryMailer();
  const app = await buildApp(cfg, { mailer, runMigrations: true, logger: false, ...opts });
  await app.ready();
  return {
    app,
    mailer,
    cfg,
    dbUrl: url.toString(),
    close: async () => {
      await app.close();
      const a = new pg.Client({ connectionString: base });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await a.end();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A cookie-keeping API client on top of fastify.inject. */
export class Client {
  cookie = '';
  bearer: string | null = null;
  csrf = true;
  user: any = null;
  constructor(private app: FastifyInstance) {}

  async req(method: Method, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse & { data: any }> {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf) h['x-requested-with'] = 'folio';
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    const res = await this.app.inject({ method, url, headers: h, payload: body as any });
    const set = res.headers['set-cookie'];
    for (const c of Array.isArray(set) ? set : set ? [set] : []) {
      const [pair] = c.split(';');
      if (pair.startsWith('folio_session=')) this.cookie = pair.endsWith('=') ? '' : pair;
    }
    let data: any;
    try {
      data = res.json();
    } catch {
      data = res.body;
    }
    return Object.assign(res, { data });
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b: unknown = {}) => this.req('POST', u, b);
  put = (u: string, b: unknown) => this.req('PUT', u, b);
  patch = (u: string, b: unknown) => this.req('PATCH', u, b);
  del = (u: string) => this.req('DELETE', u);
}

let seq = 0;
export async function signup(app: FastifyInstance, name = `user${++seq}`): Promise<Client> {
  const c = new Client(app);
  const r = await c.post('/api/auth/signup', { email: `${name}@example.com`, username: name, displayName: name[0].toUpperCase() + name.slice(1), password: 'password-123456' });
  if (r.statusCode !== 201) throw new Error(`signup failed: ${r.body}`);
  c.user = r.data.user;
  return c;
}

export async function personalWorkspace(c: Client): Promise<string> {
  const r = await c.get('/api/workspaces');
  return r.data[0].id;
}

export async function createDoc(c: Client, workspaceId: string, name: string, content: string, folderId: string | null = null) {
  const r = await c.post('/api/documents', { workspaceId, name, content, folderId });
  if (r.statusCode !== 201) throw new Error(`create doc failed: ${r.body}`);
  return r.data as { id: string; version: number };
}

/** Build a multipart/form-data body for fastify.inject. */
export function multipart(fields: Record<string, string>, files: { field: string; filename: string; content: Buffer | string; type: string }[]) {
  const boundary = `----folio${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
