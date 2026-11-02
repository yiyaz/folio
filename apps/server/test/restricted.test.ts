import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import JSZip from 'jszip';
import { Client, createDoc, createTestEnv, multipart, signup, type TestEnv } from './helpers.js';
import { buildApp } from '../src/app.js';
import { LocalKeyRing, VaultTransit } from '../src/crypto/keys.js';
import { open as decryptFile, isEncrypted } from '../src/crypto/envelope.js';
import { clearDekCache } from '../src/services/restricted.js';
import { rewrapDocument } from '../src/services/documents.js';
import { MemoryMailer } from './helpers.js';

const SECRET = 'zebra-pineapple-confidential';
const KEY1 = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
const KEY2 = `k2:${Buffer.alloc(32, 2).toString('base64')}`;

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    const p = path.join(dir, e);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

describe('restricted documents', () => {
  let env: TestEnv;
  let db: pg.Pool;
  let owner: Client; // creates the document
  let wsOwner: Client; // owns the workspace
  let member: Client; // workspace editor
  let guest: Client; // explicitly granted
  let ws: string;
  let docId: string;
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

  beforeAll(async () => {
    env = await createTestEnv({ FOLIO_KEYS: KEY1 });
    db = new pg.Pool({ connectionString: env.dbUrl });
    wsOwner = await signup(env.app, 'wsowner');
    owner = await signup(env.app, 'owner');
    member = await signup(env.app, 'member');
    guest = await signup(env.app, 'guest');
    ws = (await wsOwner.post('/api/workspaces', { name: 'HR' })).data.id;
    await wsOwner.post(`/api/workspaces/${ws}/members`, { user: 'owner', role: 'editor' });
    await wsOwner.post(`/api/workspaces/${ws}/members`, { user: 'member', role: 'admin' });
    const folder = (await wsOwner.post('/api/folders', { workspaceId: ws, name: 'People' })).data.id;
    await wsOwner.post(`/api/folders/${folder}/permissions`, { user: 'guest', role: 'viewer' }); // folder share
    docId = (await createDoc(owner, ws, 'Salaries 2027', `# Salaries\n\n${SECRET} @member`, folder)).id;
    await owner.put(`/api/documents/${docId}/content`, { content: `# Salaries\n\n${SECRET} v2 @member`, baseVersion: 1 });
    await member.post(`/api/documents/${docId}/comments`, { body: `Comment mentioning ${SECRET}`, anchorText: SECRET, anchorStart: 12, anchorEnd: 40 });
    const mp = multipart({ workspaceId: ws, documentId: docId }, [{ field: 'files', filename: 'chart.png', content: PNG, type: 'image/png' }]);
    // field name for attachments is "file"
    const mp2 = multipart({ workspaceId: ws, documentId: docId }, [{ field: 'file', filename: 'chart.png', content: PNG, type: 'image/png' }]);
    void mp;
    await owner.req('POST', '/api/attachments', mp2.body, mp2.headers);
    await owner.post(`/api/documents/${docId}/public-link`);
  });
  afterAll(async () => {
    await db.end();
    await env.close();
  });

  it('only editors can restrict; restricting needs nothing else', async () => {
    expect((await guest.put(`/api/documents/${docId}/classification`, { classification: 'restricted' })).statusCode).toBe(403);
    const r = await member.put(`/api/documents/${docId}/classification`, { classification: 'restricted' });
    expect(r.statusCode).toBe(200);
    expect(r.data.classification).toBe('restricted');
  });

  it('denies by default: workspace owner/admins and folder shares lose access; owner and restrictor keep it', async () => {
    expect((await owner.get(`/api/documents/${docId}`)).data).toMatchObject({ restricted: true, isOwner: true, role: 'owner' });
    expect((await member.get(`/api/documents/${docId}`)).statusCode).toBe(200); // restricted it -> got an explicit grant
    expect((await wsOwner.get(`/api/documents/${docId}`)).statusCode).toBe(404);
    expect((await guest.get(`/api/documents/${docId}`)).statusCode).toBe(404);
    // and it is invisible in listings
    const tree = await wsOwner.get(`/api/workspaces/${ws}/tree`);
    expect(tree.data.documents.map((d: any) => d.id)).not.toContain(docId);
    expect((await wsOwner.get(`/api/workspaces/${ws}/names`)).data.map((d: any) => d.id)).not.toContain(docId);
    expect((await owner.get(`/api/workspaces/${ws}/tree`)).data.documents.find((d: any) => d.id === docId).restricted).toBe(true);
    expect((await wsOwner.get(`/api/search?q=Salaries`)).data).toEqual([]);
  });

  it('only the owner can share it, and only with explicit people', async () => {
    expect((await member.post(`/api/documents/${docId}/permissions`, { user: 'guest', role: 'viewer' })).statusCode).toBe(403);
    expect((await owner.post(`/api/documents/${docId}/permissions`, { user: 'guest', role: 'viewer' })).statusCode).toBe(201);
    expect((await guest.get(`/api/documents/${docId}`)).data.content).toContain(SECRET);
    const perms = (await owner.get(`/api/documents/${docId}/permissions`)).data;
    expect(perms).toMatchObject({ restricted: true, members: [], inherited: [], canShare: true });
    expect(perms.owner.username).toBe('owner');
    expect(perms.direct.map((p: any) => p.user.username).sort()).toEqual(['guest', 'member']);
  });

  it('stores no plaintext: versions, attachments, comments, library, search index', async () => {
    const files = allFiles(env.cfg.STORAGE_FS_ROOT).filter((f) => f.includes(docId) || f.includes('Salaries') || f.includes('/attachments/'));
    // the current version (same-author saves share one revision), the attachment and the library copy
    expect(files.some((f) => f.includes('/blobs/'))).toBe(true);
    expect(files.some((f) => f.includes('/attachments/'))).toBe(true);
    expect(files.some((f) => f.includes('/library/'))).toBe(true);
    for (const f of files) {
      const raw = readFileSync(f);
      expect(raw.toString('latin1')).not.toContain(SECRET);
      expect(isEncrypted(raw)).toBe(true);
    }
    const lib = files.filter((f) => f.includes('/library/'));
    expect(lib.map((f) => path.basename(f))).toEqual(['Salaries 2027.md.folio-encrypted']);
    const row = (await db.query('SELECT title, search_text FROM documents WHERE id = $1', [docId])).rows[0];
    expect(row).toEqual({ title: null, search_text: '' });
    const comments = (await db.query('SELECT body, anchor_text, encrypted FROM comments WHERE document_id = $1', [docId])).rows;
    for (const c of comments) {
      expect(c.encrypted).toBe(true);
      expect(c.body + c.anchor_text).not.toContain(SECRET);
    }
    // but people with access see everything decrypted
    const api = await guest.get(`/api/documents/${docId}/comments`);
    expect(api.data[0]).toMatchObject({ body: `Comment mentioning ${SECRET}`, anchorText: SECRET });
    const revs = (await owner.get(`/api/documents/${docId}/revisions`)).data;
    for (const r of revs) expect((await owner.get(`/api/documents/${docId}/revisions/${r.id}`)).data.content).toContain(SECRET);
  });

  it('serves attachments decrypted to people with access only', async () => {
    const att = (await db.query('SELECT id FROM attachments WHERE document_id = $1', [docId])).rows[0];
    const get = (c: Client) => env.app.inject({ method: 'GET', url: `/api/attachments/${att.id}`, headers: { cookie: c.cookie } });
    const ok = await get(guest);
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.equals(PNG)).toBe(true);
    expect((await get(wsOwner)).statusCode).toBe(404);
  });

  it('removes and refuses public links', async () => {
    expect((await db.query('SELECT 1 FROM public_links WHERE document_id = $1', [docId])).rowCount).toBe(0);
    expect((await owner.post(`/api/documents/${docId}/public-link`)).statusCode).toBe(400);
  });

  it('keeps restricted content out of bulk exports, e-mails and AI', async () => {
    const res = await env.app.inject({ method: 'GET', url: `/api/workspaces/${ws}/export`, headers: { cookie: owner.cookie } });
    const zip = await JSZip.loadAsync(res.rawPayload);
    expect(Object.keys(zip.files).some((f) => f.includes('Salaries'))).toBe(false);

    const before = env.mailer.sent.length;
    await owner.put(`/api/documents/${docId}/content`, { content: `# Salaries\n\n${SECRET} v3 @guest`, baseVersion: null });
    const n = (await guest.get('/api/notifications')).data.items.find((x: any) => x.type === 'mention');
    expect(n.payload.excerpt).toBeUndefined();
    for (const m of env.mailer.sent.slice(before)) expect(m.text).not.toContain(SECRET);

    expect((await owner.post('/api/ai', { action: 'summarize', text: 'x', documentId: docId })).statusCode).toBe(403);
  });

  it('allows audited single-document export by people with access', async () => {
    const r = await env.app.inject({ method: 'GET', url: `/api/documents/${docId}/export`, headers: { cookie: guest.cookie } });
    expect(r.body).toContain(SECRET);
  });

  it('records an audit trail visible only to the owner', async () => {
    const log = await owner.get(`/api/documents/${docId}/audit`);
    const actions = log.data.map((e: any) => `${e.action}:${e.actor?.username}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        'document.classified:member',
        'permission.granted:owner',
        'document.view:guest',
        'document.export:guest',
        'attachment.view:guest',
      ]),
    );
    expect((await guest.get(`/api/documents/${docId}/audit`)).statusCode).toBe(403);
  });

  it('only the owner can lift the restriction; then everything is plaintext and searchable again', async () => {
    expect((await member.put(`/api/documents/${docId}/classification`, { classification: 'standard' })).statusCode).toBe(403);
    expect((await owner.put(`/api/documents/${docId}/classification`, { classification: 'standard' })).statusCode).toBe(200);
    expect((await wsOwner.get(`/api/documents/${docId}`)).data.content).toContain(SECRET);
    expect((await wsOwner.get(`/api/search?q=${SECRET}`)).data.map((d: any) => d.id)).toEqual([docId]);
    const blobs = allFiles(env.cfg.STORAGE_FS_ROOT).filter((f) => f.includes(`/blobs/${docId}/`));
    for (const f of blobs) expect(isEncrypted(readFileSync(f))).toBe(false);
    expect((await db.query('SELECT encrypted FROM comments WHERE document_id = $1', [docId])).rows.every((r) => !r.encrypted)).toBe(true);
    // and restrict again for the following tests
    await owner.put(`/api/documents/${docId}/classification`, { classification: 'restricted' });
  });

  it('detects tampering and refuses ciphertext moved to another document', async () => {
    const other = (await createDoc(owner, ws, 'Other secret', 'other')).id;
    await owner.put(`/api/documents/${other}/classification`, { classification: 'restricted' });
    const a = (await db.query('SELECT storage_key FROM documents WHERE id = $1', [docId])).rows[0].storage_key;
    // point the other document at this document's (validly encrypted) blob
    await db.query('UPDATE documents SET storage_key = $2 WHERE id = $1', [other, a]);
    const r = await owner.get(`/api/documents/${other}`);
    expect(r.statusCode).toBe(500);
    expect(r.data.error).toBe('integrity');
  });

  it('duplicating keeps the copy restricted and is owner-only', async () => {
    expect((await guest.post(`/api/documents/${docId}/duplicate`)).statusCode).toBe(403);
    const copy = await owner.post(`/api/documents/${docId}/duplicate`);
    expect(copy.data.classification).toBe('restricted');
  });

  it('library copies can be decrypted offline with only the key', async () => {
    const lib = allFiles(env.cfg.STORAGE_FS_ROOT).find((f) => f.endsWith('Salaries 2027.md.folio-encrypted'))!;
    const plain = await decryptFile(readFileSync(lib), new LocalKeyRing(KEY1, 'irrelevant'));
    expect(plain.toString()).toContain(SECRET);
    await expect(decryptFile(readFileSync(lib), new LocalKeyRing(KEY2, 'irrelevant'))).rejects.toThrow(/unknown key/);
  });

  it('rotates keys: re-wraps data keys so the old master key can be retired', async () => {
    // a second instance on the same database with k2 active and k1 still available
    const rotating = await buildApp(
      { ...env.cfg, FOLIO_KEYS: `${KEY2},${KEY1}` },
      { mailer: new MemoryMailer(), logger: false, keys: new LocalKeyRing(`${KEY2},${KEY1}`, '') },
    );
    clearDekCache();
    expect(await rewrapDocument(rotating.ctx, docId)).toBe(true);
    expect(await rewrapDocument(rotating.ctx, docId)).toBe(false);
    await rotating.close();
    // an instance with only k2 can read everything
    const k2only = await buildApp({ ...env.cfg, FOLIO_KEYS: KEY2 }, { mailer: new MemoryMailer(), logger: false, keys: new LocalKeyRing(KEY2, '') });
    clearDekCache();
    const c = new Client(k2only);
    c.cookie = guest.cookie;
    expect((await c.get(`/api/documents/${docId}`)).data.content).toContain(SECRET);
    expect((await c.get(`/api/documents/${docId}/comments`)).statusCode).toBe(200);
    await k2only.close();
    clearDekCache();
  });
});

describe('HashiCorp Vault transit key provider', () => {
  let server: Server;
  let addr: string;
  const calls: string[] = [];
  beforeAll(async () => {
    // a minimal fake of Vault's transit API: "encrypts" by base64-wrapping with a version tag
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push(`${req.method} ${req.url} ${req.headers['x-vault-token']}`);
        if (req.headers['x-vault-token'] !== 'root') return res.writeHead(403).end();
        const json = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/transit/encrypt/folio') return res.end(JSON.stringify({ data: { ciphertext: `vault:v1:${json.plaintext}` } }));
        if (req.url === '/v1/transit/decrypt/folio') return res.end(JSON.stringify({ data: { plaintext: json.ciphertext.replace('vault:v1:', '') } }));
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    addr = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('wraps and unwraps data keys through the transit API', async () => {
    const v = new VaultTransit(addr, 'root', 'folio');
    const dek = Buffer.alloc(32, 7);
    const w = await v.wrap(dek, 'ctx');
    expect(w).toEqual({ wrapped: `vault:v1:${dek.toString('base64')}`, kekId: 'vault-transit:folio' });
    expect((await v.unwrap(w.wrapped, w.kekId, 'ctx')).equals(dek)).toBe(true);
    expect(calls).toEqual(['POST /v1/transit/encrypt/folio root', 'POST /v1/transit/decrypt/folio root']);
    await expect(new VaultTransit(addr, 'wrong', 'folio').wrap(dek, 'x')).rejects.toThrow(/HTTP 403/);
  });

  it('works end to end for a restricted document', async () => {
    const env = await createTestEnv({}, { keys: new VaultTransit(addr, 'root', 'folio') });
    try {
      const u = await signup(env.app, 'vaultuser');
      const w = (await u.get('/api/workspaces')).data[0].id;
      const d = (await createDoc(u, w, 'In Vault', SECRET)).id;
      await u.put(`/api/documents/${d}/classification`, { classification: 'restricted' });
      clearDekCache();
      expect((await u.get(`/api/documents/${d}`)).data.content).toBe(SECRET);
    } finally {
      await env.close();
    }
  });
});

describe('key configuration', () => {
  it('validates FOLIO_KEYS', () => {
    expect(() => new LocalKeyRing('nocolon', '')).toThrow(/look like/);
    expect(() => new LocalKeyRing('a:dG9vc2hvcnQ=', '')).toThrow(/32 bytes/);
    expect(() => new LocalKeyRing(`${KEY1},${KEY1}`, '')).toThrow(/duplicate/);
    expect(new LocalKeyRing(`${KEY2},${KEY1}`, '').activeKekId).toBe('k2');
    expect(new LocalKeyRing('', 'some-app-secret').activeKekId).toBe('app-secret');
  });
});
