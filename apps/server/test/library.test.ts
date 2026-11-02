import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Client, createDoc, createTestEnv, multipart, signup, type TestEnv } from './helpers.js';
import { sanitizeSegment } from '../src/services/library.js';

function tree(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((e) => {
      const p = path.join(dir, e);
      return statSync(p).isDirectory() ? tree(p, base) : [path.relative(base, p)];
    })
    .sort();
}

describe('readable storage library', () => {
  let env: TestEnv;
  let alice: Client;
  let ws: string;
  let lib: string;
  beforeAll(async () => {
    env = await createTestEnv({ STORAGE_PREFIX: 'folio/test' });
    alice = await signup(env.app, 'alice');
    ws = (await alice.post('/api/workspaces', { name: 'ML Platform' })).data.id;
    lib = path.join(env.cfg.STORAGE_FS_ROOT, 'folio/test/library', `ML Platform (${ws.slice(0, 8)})`);
  });
  afterAll(() => env.close());

  it('mirrors documents as plain Markdown at human-readable paths, with a manifest', async () => {
    const f = (await alice.post('/api/folders', { workspaceId: ws, name: 'Design docs' })).data.id;
    const d = await createDoc(alice, ws, 'Feature Store', '# Feature Store\n\nBody', f);
    await createDoc(alice, ws, 'Notes', 'top level');
    expect(tree(lib)).toEqual(['Design docs/Feature Store.md', 'Notes.md', '_manifest.json']);
    expect(readFileSync(path.join(lib, 'Design docs/Feature Store.md'), 'utf8')).toBe(`---\nid: ${d.id}\n---\n\n# Feature Store\n\nBody`);
    const manifest = JSON.parse(readFileSync(path.join(lib, '_manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ format: 'folio-library/1', workspace: { id: ws, name: 'ML Platform' } });
    expect(manifest.documents).toContainEqual({
      id: d.id,
      name: 'Feature Store',
      title: 'Feature Store',
      path: 'Design docs/Feature Store.md',
      restricted: false,
    });
  });

  it('keeps files current on save, rename, move, trash, restore and folder changes', async () => {
    const d = await createDoc(alice, ws, 'Plan', 'v1');
    await alice.put(`/api/documents/${d.id}/content`, { content: 'v2', baseVersion: 1 });
    expect(readFileSync(path.join(lib, 'Plan.md'), 'utf8')).toContain('v2');

    await alice.patch(`/api/documents/${d.id}`, { name: 'Roadmap' });
    expect(existsSync(path.join(lib, 'Plan.md'))).toBe(false);
    expect(existsSync(path.join(lib, 'Roadmap.md'))).toBe(true);

    const f = (await alice.post('/api/folders', { workspaceId: ws, name: 'Planning' })).data.id;
    await alice.patch(`/api/documents/${d.id}`, { folderId: f });
    expect(existsSync(path.join(lib, 'Planning/Roadmap.md'))).toBe(true);

    await alice.patch(`/api/folders/${f}`, { name: 'Strategy' });
    expect(existsSync(path.join(lib, 'Strategy/Roadmap.md'))).toBe(true);
    expect(existsSync(path.join(lib, 'Planning'))).toBe(false); // empty folders are pruned

    await alice.del(`/api/documents/${d.id}`);
    expect(existsSync(path.join(lib, 'Strategy/Roadmap.md'))).toBe(false);
    await alice.post(`/api/documents/${d.id}/restore`);
    expect(existsSync(path.join(lib, 'Strategy/Roadmap.md'))).toBe(true);

    await alice.del(`/api/folders/${f}`);
    expect(existsSync(path.join(lib, 'Strategy'))).toBe(false);
    await alice.post(`/api/folders/${f}/restore`);
    expect(existsSync(path.join(lib, 'Strategy/Roadmap.md'))).toBe(true);
  });

  it('makes any name safe as a path on every OS', async () => {
    expect(sanitizeSegment('a:b*c?"d<e>f|g')).toBe('a_b_c__d_e_f_g');
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('trailing dots...')).toBe('trailing dots');
    expect(sanitizeSegment('..')).toBe('_');
    await createDoc(alice, ws, 'Q3: goals?', 'x');
    expect(existsSync(path.join(lib, 'Q3_ goals_.md'))).toBe(true);
  });

  it('heals itself: missing files are rewritten, strays removed', async () => {
    rmSync(path.join(lib, 'Notes.md'));
    mkdirSync(path.join(lib, 'junk'), { recursive: true });
    writeFileSync(path.join(lib, 'junk/stray.md'), 'not ours');
    const r = await alice.post(`/api/workspaces/${ws}/storage/reconcile`, {});
    expect(r.statusCode).toBe(200);
    expect(r.data).toEqual({ synced: 1, removed: 1 });
    expect(readFileSync(path.join(lib, 'Notes.md'), 'utf8')).toContain('top level');
    expect(existsSync(path.join(lib, 'junk'))).toBe(false);
  });

  it('moves the whole folder when the workspace is renamed, and removes it when deleted', async () => {
    const w2 = (await alice.post('/api/workspaces', { name: 'Old name' })).data.id;
    await createDoc(alice, w2, 'Doc', 'x');
    const root = path.join(env.cfg.STORAGE_FS_ROOT, 'folio/test/library');
    expect(existsSync(path.join(root, `Old name (${w2.slice(0, 8)})/Doc.md`))).toBe(true);
    await alice.patch(`/api/workspaces/${w2}`, { name: 'New name' });
    expect(existsSync(path.join(root, `Old name (${w2.slice(0, 8)})`))).toBe(false);
    expect(existsSync(path.join(root, `New name (${w2.slice(0, 8)})/Doc.md`))).toBe(true);
    await alice.del(`/api/workspaces/${w2}`);
    expect(existsSync(path.join(root, `New name (${w2.slice(0, 8)})`))).toBe(false);
  });

  it('library files can be re-imported to recover a workspace', async () => {
    const restoreWs = (await alice.post('/api/workspaces', { name: 'Restored' })).data.id;
    const files = tree(lib).filter((f) => f.endsWith('.md'));
    const mp = multipart(
      {},
      files.map((f) => ({ field: 'files', filename: f, content: readFileSync(path.join(lib, f)), type: 'text/markdown' })),
    );
    const r = await alice.req('POST', `/api/workspaces/${restoreWs}/import`, mp.body, mp.headers);
    expect(r.statusCode).toBe(200);
    const restored = await alice.get(`/api/workspaces/${restoreWs}/tree`);
    expect(restored.data.documents.map((d: any) => d.name).sort()).toEqual(expect.arrayContaining(['Feature Store', 'Roadmap']));
  });

  it('tells admins where the files are', async () => {
    const r = await alice.get(`/api/workspaces/${ws}/storage`);
    expect(r.data).toMatchObject({ driver: 'fs', libraryEnabled: true, documents: expect.any(Number), restrictedDocuments: 0 });
    expect(r.data.library).toBe(lib + path.sep);
    expect(r.data.manifest).toBe(path.join(lib, '_manifest.json'));
    expect(r.data.keyProvider).toContain('local key ring');
    expect(r.data.keyWarning).toBe(true); // no FOLIO_KEYS in this environment
    const bob = await signup(env.app, 'bob');
    expect((await bob.get(`/api/workspaces/${ws}/storage`)).statusCode).toBe(404);
  });

  it('can be switched off', async () => {
    const off = await createTestEnv({ LIBRARY_ENABLED: 'false' });
    try {
      const u = await signup(off.app, 'nolib');
      const w = (await u.get('/api/workspaces')).data[0].id;
      await createDoc(u, w, 'X', 'y');
      expect(existsSync(path.join(off.cfg.STORAGE_FS_ROOT, 'library'))).toBe(false);
    } finally {
      await off.close();
    }
  });
});
