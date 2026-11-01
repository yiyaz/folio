import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { Client, createDoc, createTestEnv, multipart, personalWorkspace, signup, type TestEnv } from './helpers.js';

describe('documents', () => {
  let env: TestEnv;
  let alice: Client;
  let ws: string;
  beforeAll(async () => {
    env = await createTestEnv();
    alice = await signup(env.app, 'alice');
    ws = await personalWorkspace(alice);
  });
  afterAll(() => env.close());

  it('creates, reads and saves a document with optimistic concurrency', async () => {
    const d = await createDoc(alice, ws, 'Notes', '# Notes\n\nfirst');
    const got = await alice.get(`/api/documents/${d.id}`);
    expect(got.data).toMatchObject({ name: 'Notes', title: 'Notes', version: 1, content: '# Notes\n\nfirst', role: 'owner' });

    const s1 = await alice.put(`/api/documents/${d.id}/content`, { content: '# Notes\n\nsecond', baseVersion: 1 });
    expect(s1.statusCode).toBe(200);
    expect(s1.data.version).toBe(2);

    // a stale save gets 409 with the server's content
    const stale = await alice.put(`/api/documents/${d.id}/content`, { content: 'stale', baseVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.data.details).toMatchObject({ version: 2, content: '# Notes\n\nsecond' });

    // the title follows the first H1 / front matter
    const s2 = await alice.put(`/api/documents/${d.id}/content`, { content: '---\ntitle: Meeting Notes\n---\nbody', baseVersion: 2 });
    expect(s2.data.title).toBe('Meeting Notes');
  });

  it('rejects invalid and duplicate names', async () => {
    expect((await alice.post('/api/documents', { workspaceId: ws, name: 'a/b' })).statusCode).toBe(400);
    expect((await alice.post('/api/documents', { workspaceId: ws, name: 'x[[y' })).statusCode).toBe(400);
    await createDoc(alice, ws, 'Unique', '');
    expect((await alice.post('/api/documents', { workspaceId: ws, name: 'unique' })).statusCode).toBe(409);
    // unnamed documents get a free "Untitled N" name
    const u1 = await alice.post('/api/documents', { workspaceId: ws });
    const u2 = await alice.post('/api/documents', { workspaceId: ws });
    expect([u1.data.name, u2.data.name]).toEqual(['Untitled', 'Untitled 2']);
  });

  it('creates documents from templates', async () => {
    const r = await alice.post('/api/documents', { workspaceId: ws, name: 'Use Postgres', templateId: 'adr' });
    const d = await alice.get(`/api/documents/${r.data.id}`);
    expect(d.data.content).toContain('# Use Postgres');
    expect(d.data.content).toContain('## Decision');
    const tpls = await alice.get('/api/templates');
    expect(tpls.data.map((t: any) => t.id)).toEqual(expect.arrayContaining(['adr', 'rfc', 'postmortem', 'experiment-log', 'model-card']));
  });

  it('indexes wiki links, resolves backlinks with anchors, and tracks broken links', async () => {
    const target = await createDoc(alice, ws, 'Feature Store', '# Feature Store\n\n## Setup\n\nA fact. ^fact-1\n');
    const src = await createDoc(alice, ws, 'Pipeline', 'Uses [[feature store#Setup]] and [[Feature Store#^fact-1|the fact]] and [[Missing Doc]].');
    const bl = await alice.get(`/api/documents/${target.id}/backlinks`);
    expect(bl.data).toHaveLength(1);
    expect(bl.data[0]).toMatchObject({ id: src.id, name: 'Pipeline' });
    expect(bl.data[0].anchors.sort()).toEqual(['Setup', '^fact-1']);
    expect(bl.data[0].excerpt).toContain('[[feature store#Setup]]');

    const links = await alice.get(`/api/documents/${src.id}/links`);
    expect(links.data.find((l: any) => l.targetName === 'Missing Doc').targetId).toBeNull();

    // creating the missing document adopts the dangling link
    const missing = await createDoc(alice, ws, 'Missing Doc', '');
    const bl2 = await alice.get(`/api/documents/${missing.id}/backlinks`);
    expect(bl2.data.map((b: any) => b.id)).toEqual([src.id]);
  });

  it('rewrites [[links]] in other documents when a document is renamed', async () => {
    const t = await createDoc(alice, ws, 'Old Name', '');
    const s = await createDoc(alice, ws, 'Referrer', 'See [[Old Name]], [[old name#Intro|intro]] and `[[Old Name]]` in code.');
    const r = await alice.patch(`/api/documents/${t.id}`, { name: 'New Name' });
    expect(r.statusCode).toBe(200);
    const after = await alice.get(`/api/documents/${s.id}`);
    expect(after.data.content).toBe('See [[New Name]], [[New Name#Intro|intro]] and `[[Old Name]]` in code.');
    expect((await alice.get(`/api/documents/${t.id}/backlinks`)).data).toHaveLength(1);
  });

  it('keeps revisions, coalesces rapid saves by the same author, and restores', async () => {
    const d = await createDoc(alice, ws, 'History', 'v1');
    await alice.put(`/api/documents/${d.id}/content`, { content: 'v2', baseVersion: 1 });
    await alice.put(`/api/documents/${d.id}/content`, { content: 'v3', baseVersion: 2 });
    const revs = await alice.get(`/api/documents/${d.id}/revisions`);
    expect(revs.data).toHaveLength(1); // same author within the coalescing window
    expect(revs.data[0].version).toBe(3);

    // a different author creates a new revision
    const bob = await signup(env.app, 'histbob');
    await alice.post(`/api/documents/${d.id}/permissions`, { user: 'histbob', role: 'editor' });
    await bob.put(`/api/documents/${d.id}/content`, { content: 'v4 by bob', baseVersion: 3 });
    const revs2 = await alice.get(`/api/documents/${d.id}/revisions`);
    expect(revs2.data.map((r: any) => r.version)).toEqual([4, 3]);
    const old = revs2.data[1];
    expect((await alice.get(`/api/documents/${d.id}/revisions/${old.id}`)).data.content).toBe('v3');
    await alice.post(`/api/documents/${d.id}/revisions/${old.id}/restore`);
    expect((await alice.get(`/api/documents/${d.id}`)).data.content).toBe('v3');
  });

  it('moves documents to trash, unlinks them, and restores them', async () => {
    const t = await createDoc(alice, ws, 'Trashable', '');
    const s = await createDoc(alice, ws, 'Links To Trashable', '[[Trashable]]');
    await alice.del(`/api/documents/${t.id}`);
    const tree = await alice.get(`/api/workspaces/${ws}/tree`);
    expect(tree.data.documents.find((d: any) => d.id === t.id)).toBeUndefined();
    expect((await alice.get(`/api/workspaces/${ws}/trash`)).data.documents.map((d: any) => d.id)).toContain(t.id);
    expect((await alice.get(`/api/documents/${s.id}/links`)).data[0].targetId).toBeNull();
    expect((await alice.put(`/api/documents/${t.id}/content`, { content: 'x', baseVersion: null })).statusCode).toBe(404);

    await alice.post(`/api/documents/${t.id}/restore`);
    expect((await alice.get(`/api/documents/${s.id}/links`)).data[0].targetId).toBe(t.id);

    await alice.del(`/api/documents/${t.id}`);
    expect((await alice.del(`/api/documents/${t.id}/permanent`)).statusCode).toBe(200);
    expect((await alice.get(`/api/documents/${t.id}`)).statusCode).toBe(404);
  });

  it('manages folders: nesting, cycles, move, trash and restore', async () => {
    const a = await alice.post('/api/folders', { workspaceId: ws, name: 'Projects' });
    const b = await alice.post('/api/folders', { workspaceId: ws, parentId: a.data.id, name: 'Alpha' });
    expect((await alice.post('/api/folders', { workspaceId: ws, name: 'projects' })).statusCode).toBe(409);
    expect((await alice.patch(`/api/folders/${a.data.id}`, { parentId: b.data.id })).statusCode).toBe(400);
    const d = await createDoc(alice, ws, 'Spec', 'spec', b.data.id);
    const loose = await createDoc(alice, ws, 'Loose', '');
    await alice.patch(`/api/documents/${loose.id}`, { folderId: a.data.id });

    await alice.del(`/api/folders/${a.data.id}`);
    let tree = await alice.get(`/api/workspaces/${ws}/tree`);
    expect(tree.data.folders.find((f: any) => f.id === b.data.id)).toBeUndefined();
    expect(tree.data.documents.find((x: any) => x.id === d.id)).toBeUndefined();

    await alice.post(`/api/folders/${a.data.id}/restore`);
    tree = await alice.get(`/api/workspaces/${ws}/tree`);
    expect(tree.data.documents.find((x: any) => x.id === d.id)?.folderId).toBe(b.data.id);
    expect(tree.data.documents.find((x: any) => x.id === loose.id)?.folderId).toBe(a.data.id);
  });

  it('indexes tags (inline and front matter) and searches full text', async () => {
    await createDoc(alice, ws, 'Churn model', '---\ntags: [ml, models/churn]\n---\nGradient boosted trees predict customer attrition. #experiment');
    await createDoc(alice, ws, 'Unrelated', 'Something about kubernetes.');
    const tags = await alice.get(`/api/workspaces/${ws}/tags`);
    expect(tags.data.map((t: any) => t.tag)).toEqual(expect.arrayContaining(['ml', 'models/churn', 'experiment']));
    const byTag = await alice.get('/api/tags/models');
    expect(byTag.data.map((d: any) => d.name)).toEqual(['Churn model']);

    const s = await alice.get('/api/search?q=attrition');
    expect(s.data[0].name).toBe('Churn model');
    expect(s.data[0].snippet).toContain('<mark>attrition</mark>');
    // stemming: "predicting" matches "predict"
    expect((await alice.get('/api/search?q=predicting')).data.map((d: any) => d.name)).toContain('Churn model');
    // name matches
    expect((await alice.get('/api/search?q=churn')).data[0].name).toBe('Churn model');
    expect((await alice.get('/api/search?q=zzzznotfound')).data).toEqual([]);
  });

  it('exports a workspace as a zip with stable ids and re-imports without duplicates', async () => {
    const ws2 = (await alice.post('/api/workspaces', { name: 'Export test' })).data.id;
    const f = await alice.post('/api/folders', { workspaceId: ws2, name: 'Guides' });
    const d = await createDoc(alice, ws2, 'Install', '# Install\n\nRun it.', f.data.id);
    const res = await env.app.inject({ method: 'GET', url: `/api/workspaces/${ws2}/export`, headers: { cookie: alice.cookie } });
    expect(res.headers['content-type']).toBe('application/zip');
    const zip = await JSZip.loadAsync(res.rawPayload);
    const file = await zip.file('Guides/Install.md')!.async('string');
    expect(file).toContain(`id: ${d.id}`);

    // modify the exported file and re-import alongside a brand new file
    zip.file('Guides/Install.md', file.replace('Run it.', 'Run it twice.'));
    zip.file('New/Fresh.md', '# Fresh');
    zip.file('.hidden/skip.md', 'x');
    zip.file('image.png', 'x');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const mp = multipart({}, [{ field: 'files', filename: 'export.zip', content: buf, type: 'application/zip' }]);
    const imp = await alice.req('POST', `/api/workspaces/${ws2}/import`, mp.body, mp.headers);
    expect(imp.statusCode).toBe(200);
    expect(imp.data).toMatchObject({ created: 1, updated: 1, unchanged: 0 });
    const updated = await alice.get(`/api/documents/${d.id}`);
    expect(updated.data.content).toBe('# Install\n\nRun it twice.'); // id front matter stripped again
    const tree = await alice.get(`/api/workspaces/${ws2}/tree`);
    expect(tree.data.documents.map((x: any) => x.name).sort()).toEqual(['Fresh', 'Install']);
    expect(tree.data.folders.map((x: any) => x.name).sort()).toEqual(['Guides', 'New']);
  });

  it('exports a single document as Markdown', async () => {
    const d = await createDoc(alice, ws, 'Single', 'hello');
    const r = await env.app.inject({ method: 'GET', url: `/api/documents/${d.id}/export`, headers: { cookie: alice.cookie } });
    expect(r.headers['content-type']).toContain('text/markdown');
    expect(r.body).toBe(`---\nid: ${d.id}\n---\n\nhello`);
  });

  describe('attachments', () => {
    const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4150000000049454e44ae426082', 'hex');

    it('uploads images and data files, serves them with safe headers', async () => {
      const d = await createDoc(alice, ws, 'With image', '');
      const mp = multipart({ workspaceId: ws, documentId: d.id }, [{ field: 'file', filename: 'dot.png', content: PNG, type: 'image/png' }]);
      const r = await alice.req('POST', '/api/attachments', mp.body, mp.headers);
      expect(r.statusCode).toBe(201);
      expect(r.data.markdown).toBe(`![dot.png](${r.data.url})`);
      const get = await env.app.inject({ method: 'GET', url: r.data.url, headers: { cookie: alice.cookie } });
      expect(get.statusCode).toBe(200);
      expect(get.headers['content-type']).toBe('image/png');
      expect(get.headers['x-content-type-options']).toBe('nosniff');
      expect(get.headers['content-security-policy']).toContain('sandbox');

      const nb = JSON.stringify({ cells: [], metadata: {} });
      const mp2 = multipart({ workspaceId: ws }, [{ field: 'file', filename: 'analysis.ipynb', content: nb, type: 'application/octet-stream' }]);
      const r2 = await alice.req('POST', '/api/attachments', mp2.body, mp2.headers);
      expect(r2.data.mime).toBe('application/x-ipynb+json');

      // other users can't read it
      const eve = await signup(env.app, 'eve');
      expect((await env.app.inject({ method: 'GET', url: r.data.url, headers: { cookie: eve.cookie } })).statusCode).toBe(404);
    });

    it('rejects disallowed types and spoofed content', async () => {
      const svg = multipart({ workspaceId: ws }, [{ field: 'file', filename: 'x.svg', content: '<svg onload="alert(1)"/>', type: 'image/svg+xml' }]);
      expect((await alice.req('POST', '/api/attachments', svg.body, svg.headers)).statusCode).toBe(400);
      const html = multipart({ workspaceId: ws }, [{ field: 'file', filename: 'x.html', content: '<script>', type: 'text/html' }]);
      expect((await alice.req('POST', '/api/attachments', html.body, html.headers)).statusCode).toBe(400);
      const fake = multipart({ workspaceId: ws }, [{ field: 'file', filename: 'evil.png', content: 'MZ\u0000\u0000binary', type: 'image/png' }]);
      const r = await alice.req('POST', '/api/attachments', fake.body, fake.headers);
      expect(r.statusCode).toBe(400);
      expect(r.data.message).toMatch(/do not match/);
    });

    it('enforces the upload size limit', async () => {
      const small = await createTestEnv({ MAX_UPLOAD_MB: '1' });
      try {
        const u = await signup(small.app, 'big');
        const w = await personalWorkspace(u);
        const mp = multipart({ workspaceId: w }, [{ field: 'file', filename: 'big.csv', content: Buffer.alloc(1.5 * 1024 * 1024, 'a'), type: 'text/csv' }]);
        const r = await u.req('POST', '/api/attachments', mp.body, mp.headers);
        expect(r.statusCode).toBe(413);
      } finally {
        await small.close();
      }
    });
  });

  describe('public links', () => {
    it('serves a read-only public view (and its attachments) until disabled', async () => {
      const d = await createDoc(alice, ws, 'Public page', '# Hello world');
      const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
      const mp = multipart({ workspaceId: ws, documentId: d.id }, [{ field: 'file', filename: 'p.png', content: PNG, type: 'image/png' }]);
      const att = await alice.req('POST', '/api/attachments', mp.body, mp.headers);
      const link = await alice.post(`/api/documents/${d.id}/public-link`);
      const anon = new Client(env.app);
      const r = await anon.get(`/api/public/${link.data.token}`);
      expect(r.data).toMatchObject({ title: 'Hello world', content: '# Hello world' });
      expect((await anon.get(`${att.data.url}?p=${link.data.token}`)).statusCode).toBe(200);
      expect((await anon.get(att.data.url)).statusCode).toBe(404);
      expect((await anon.get(`/api/documents/${d.id}`)).statusCode).toBe(401);

      await alice.del(`/api/documents/${d.id}/public-link`);
      expect((await anon.get(`/api/public/${link.data.token}`)).statusCode).toBe(404);
    });
  });

  it('serves health, readiness, metrics and client config', async () => {
    expect((await env.app.inject('/healthz')).json()).toEqual({ ok: true });
    expect((await env.app.inject('/readyz')).json()).toEqual({ ok: true });
    const m = await env.app.inject('/metrics');
    expect(m.body).toContain('folio_http_request_duration_seconds');
    expect(m.body).toContain('folio_document_saves_total');
    const cc = (await env.app.inject('/api/client-config')).json();
    expect(cc).toMatchObject({ ai: false, maxUploadMb: 25 });
    expect(cc.embedPatterns.length).toBeGreaterThan(0);
  });

  it('returns 501 for AI assist when no API key is configured', async () => {
    expect((await alice.post('/api/ai', { action: 'summarize', text: 'hi' })).statusCode).toBe(501);
    expect((await alice.get('/api/ai/status')).data.enabled).toBe(false);
  });
});
