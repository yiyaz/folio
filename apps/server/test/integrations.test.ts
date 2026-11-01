import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, createDoc, createTestEnv, personalWorkspace, signup, type TestEnv } from './helpers.js';
import { createEmbedFetcher } from '../src/routes/embeds.js';
import { loadConfig } from '../src/config.js';
import { FsStorage } from '../src/storage/fs.js';
import { SecretBox } from '../src/crypto.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });

describe('git sync', () => {
  let env: TestEnv;
  let alice: Client;
  let ws: string;
  let tmp: string;
  let remote: string;
  beforeAll(async () => {
    env = await createTestEnv({ GIT_ALLOW_FILE_REMOTES: 'true' });
    alice = await signup(env.app, 'gitalice');
    ws = (await alice.post('/api/workspaces', { name: 'Docs repo' })).data.id;
    tmp = mkdtempSync(path.join(os.tmpdir(), 'folio-git-test-'));
    remote = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  });
  afterAll(async () => {
    await env.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('only accepts https remotes unless file remotes are enabled', async () => {
    const strict = await createTestEnv();
    try {
      const u = await signup(strict.app, 'strict');
      const w = await personalWorkspace(u);
      expect((await u.put(`/api/workspaces/${w}/git`, { remote: 'file:///etc' })).statusCode).toBe(400);
      expect((await u.put(`/api/workspaces/${w}/git`, { remote: 'https://user:pw@github.com/x/y.git' })).statusCode).toBe(400);
      expect((await u.put(`/api/workspaces/${w}/git`, { remote: 'https://github.com/x/y.git', token: 'ghp_secret' })).data).toMatchObject({ hasToken: true });
      // the token is stored encrypted and never returned
      expect(JSON.stringify((await u.get(`/api/workspaces/${w}/git`)).data)).not.toContain('ghp_secret');
    } finally {
      await strict.close();
    }
  });

  it('pushes the workspace as Markdown files and pulls changes back', async () => {
    const f = await alice.post('/api/folders', { workspaceId: ws, name: 'guides' });
    const d = await createDoc(alice, ws, 'Install', '# Install\n\nstep 1', f.data.id);
    await createDoc(alice, ws, 'README', '# Docs');
    await alice.put(`/api/workspaces/${ws}/git`, { remote: `file://${remote}`, branch: 'main', subdir: 'docs' });

    const push = await alice.post(`/api/workspaces/${ws}/git/push`, { message: 'Initial docs' });
    expect(push.statusCode).toBe(200);
    expect(push.data).toMatchObject({ pushed: true, files: 2 });

    const work = path.join(tmp, 'work');
    execFileSync('git', ['clone', '-q', remote, work]);
    const installPath = path.join(work, 'docs/guides/Install.md');
    expect(readFileSync(installPath, 'utf8')).toContain(`id: ${d.id}`);
    expect(git(work, 'log', '-1', '--format=%s %an')).toContain('Initial docs Gitalice');

    // nothing changed => nothing to push
    expect((await alice.post(`/api/workspaces/${ws}/git/push`, {})).data.pushed).toBe(false);

    // edit in git, add a file, push to remote, then pull into Folio
    writeFileSync(installPath, readFileSync(installPath, 'utf8').replace('step 1', 'step 1\nstep 2'));
    mkdirSync(path.join(work, 'docs/adr'), { recursive: true });
    writeFileSync(path.join(work, 'docs/adr/0001 Use Postgres.md'), '# Use Postgres\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'edit in git');
    git(work, 'push', '-q', 'origin', 'main');

    const pull = await alice.post(`/api/workspaces/${ws}/git/pull`, {});
    expect(pull.statusCode).toBe(200);
    expect(pull.data).toMatchObject({ created: 1, updated: 1, unchanged: 1 });
    expect((await alice.get(`/api/documents/${d.id}`)).data.content).toBe('# Install\n\nstep 1\nstep 2');
    const tree = await alice.get(`/api/workspaces/${ws}/tree`);
    expect(tree.data.documents.map((x: any) => x.name).sort()).toEqual(['0001 Use Postgres', 'Install', 'README']);
    expect((await alice.get(`/api/workspaces/${ws}/git`)).data).toMatchObject({ lastError: null });
  });

  it('reports git errors without leaking credentials', async () => {
    await alice.put(`/api/workspaces/${ws}/git`, { remote: `file://${tmp}/does-not-exist.git`, branch: 'main', token: 'super-secret-token' });
    const r = await alice.post(`/api/workspaces/${ws}/git/push`, {});
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('super-secret-token');
    expect((await alice.get(`/api/workspaces/${ws}/git`)).data.lastError).toMatch(/git/);
  });
});

describe('rich embeds', () => {
  const cfg = loadConfig({ JIRA_BASE_URL: 'https://acme.atlassian.net', JIRA_TOKEN: 't' });
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith('/repos/acme/api/pulls/42'))
      return new Response(
        JSON.stringify({ title: 'Add caching', number: 42, state: 'closed', merged: true, draft: false, user: { login: 'octo' }, labels: [{ name: 'perf' }] }),
      );
    if (url.includes('/repos/acme/api/contents/src/app.ts')) return new Response(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
    if (url.includes('/rest/api/2/issue/OPS-7'))
      return new Response(
        JSON.stringify({ fields: { summary: 'Rotate keys', status: { name: 'In Progress' }, assignee: { displayName: 'Bo' }, issuetype: { name: 'Task' } } }),
      );
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  const fetchEmbed = createEmbedFetcher(cfg, fakeFetch);

  it('renders GitHub pull requests', async () => {
    expect(await fetchEmbed('https://github.com/acme/api/pull/42')).toMatchObject({
      kind: 'github-pr',
      title: 'Add caching',
      merged: true,
      labels: ['perf'],
      repo: 'acme/api',
    });
  });

  it('renders code permalinks with line ranges', async () => {
    const e: any = await fetchEmbed('https://github.com/acme/api/blob/abc123/src/app.ts#L3-L5');
    expect(e).toMatchObject({ kind: 'github-code', language: 'typescript', startLine: 3, endLine: 5, code: 'line 3\nline 4\nline 5' });
  });

  it('renders Jira issues from the configured instance', async () => {
    expect(await fetchEmbed('https://acme.atlassian.net/browse/OPS-7')).toMatchObject({ kind: 'jira', key: 'OPS-7', status: 'In Progress', assignee: 'Bo' });
  });

  it('never fetches arbitrary URLs (no SSRF)', async () => {
    const before = calls.length;
    expect(await fetchEmbed('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(await fetchEmbed('https://evil.example.com/browse/OPS-1')).toBeNull();
    expect(calls.length).toBe(before);
  });

  it('caches results', async () => {
    const before = calls.length;
    await fetchEmbed('https://github.com/acme/api/pull/42');
    expect(calls.length).toBe(before);
  });
});

describe('storage & crypto', () => {
  it('fs storage rejects path traversal and writes atomically', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'folio-fs-'));
    const s = new FsStorage(dir);
    await expect(s.put('../escape.txt', 'x')).rejects.toThrow(/invalid storage key/);
    await s.put('a/b/c.md', 'hello');
    expect((await s.get('a/b/c.md')).toString()).toBe('hello');
    expect(await s.exists('a/b/c.md')).toBe(true);
    await s.delete('a/b/c.md');
    expect(existsSync(path.join(dir, 'a/b/c.md'))).toBe(false);
    await expect(s.get('missing')).rejects.toThrow(/not found/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('secret box round-trips and detects tampering', () => {
    const box = new SecretBox('x'.repeat(32));
    const enc = box.encrypt('token-123');
    expect(enc).not.toContain('token-123');
    expect(box.decrypt(enc)).toBe('token-123');
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
    expect(() => new SecretBox('y'.repeat(32)).decrypt(enc)).toThrow();
  });
});
