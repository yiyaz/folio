import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createDoc, createTestEnv, signup, type TestEnv } from './helpers.js';

/**
 * Permission matrix: every way of getting access (workspace membership, a direct
 * document share, a share on an ancestor folder) × every action.
 */
type Access = 'none' | 'viewer' | 'commenter' | 'editor' | 'admin';
type Via = 'member' | 'doc-share' | 'folder-share';
const ACTIONS = ['read', 'comment', 'edit', 'share', 'rename', 'trash', 'manageWorkspace'] as const;
type Action = (typeof ACTIONS)[number];

const RANK: Record<Access, number> = { none: 0, viewer: 1, commenter: 2, editor: 3, admin: 4 };
const NEED: Record<Action, number> = { read: 1, comment: 2, edit: 3, share: 3, rename: 3, trash: 3, manageWorkspace: 4 };

describe('permission matrix', () => {
  let env: TestEnv;
  let owner: Client;
  let ws: string;
  beforeAll(async () => {
    env = await createTestEnv();
    owner = await signup(env.app, 'owner');
    ws = (await owner.post('/api/workspaces', { name: 'Team space' })).data.id;
  });
  afterAll(() => env.close());

  const cases: { via: Via; access: Access }[] = [
    { via: 'member', access: 'none' },
    ...(['viewer', 'commenter', 'editor', 'admin'] as Access[]).map((a) => ({ via: 'member' as Via, access: a })),
    ...(['viewer', 'commenter', 'editor'] as Access[]).map((a) => ({ via: 'doc-share' as Via, access: a })),
    ...(['viewer', 'commenter', 'editor'] as Access[]).map((a) => ({ via: 'folder-share' as Via, access: a })),
  ];

  let n = 0;
  for (const c of cases) {
    it(`${c.via} / ${c.access}`, async () => {
      const user = await signup(env.app, `u${c.via.replace('-', '')}${c.access}${++n}`);
      const folder = (await owner.post('/api/folders', { workspaceId: ws, name: `F${n}` })).data;
      const sub = (await owner.post('/api/folders', { workspaceId: ws, parentId: folder.id, name: 'nested' })).data;
      const doc = await createDoc(owner, ws, `Doc ${n}`, 'secret content', sub.id);

      if (c.access !== 'none') {
        if (c.via === 'member') await owner.post(`/api/workspaces/${ws}/members`, { user: user.user.username, role: c.access });
        if (c.via === 'doc-share') await owner.post(`/api/documents/${doc.id}/permissions`, { user: user.user.username, role: c.access });
        if (c.via === 'folder-share') await owner.post(`/api/folders/${folder.id}/permissions`, { user: user.user.username, role: c.access });
      }

      const results: Record<Action, boolean> = {
        read: (await user.get(`/api/documents/${doc.id}`)).statusCode === 200,
        comment: (await user.post(`/api/documents/${doc.id}/comments`, { body: 'hi' })).statusCode === 201,
        edit: (await user.put(`/api/documents/${doc.id}/content`, { content: 'changed', baseVersion: null })).statusCode === 200,
        share: (await user.post(`/api/documents/${doc.id}/permissions`, { user: 'owner', role: 'viewer' })).statusCode === 201,
        rename: (await user.patch(`/api/documents/${doc.id}`, { name: `Renamed ${n}` })).statusCode === 200,
        trash: false,
        manageWorkspace: (await user.patch(`/api/workspaces/${ws}`, { name: 'Team space' })).statusCode === 200,
      };
      results.trash = (await user.del(`/api/documents/${doc.id}`)).statusCode === 200;

      const expected = Object.fromEntries(ACTIONS.map((a) => [a, a === 'manageWorkspace' && c.via !== 'member' ? false : RANK[c.access] >= NEED[a]]));
      expect(results).toEqual(expected);
    });
  }

  it('hides documents from users without access (404, not 403) and from search', async () => {
    const stranger = await signup(env.app, 'stranger');
    const doc = await createDoc(owner, ws, 'Hidden plan', 'zebra-confidential');
    const r = await stranger.get(`/api/documents/${doc.id}`);
    expect(r.statusCode).toBe(404);
    expect((await stranger.get(`/api/workspaces/${ws}/tree`)).statusCode).toBe(404);
    expect((await stranger.get('/api/search?q=zebra-confidential')).data).toEqual([]);
    expect((await owner.get('/api/search?q=zebra-confidential')).data).toHaveLength(1);
  });

  it('shows folder-shared documents in search, shared list and folder view for non-members', async () => {
    const guest = await signup(env.app, 'guest');
    const f = (await owner.post('/api/folders', { workspaceId: ws, name: 'Shared stuff' })).data;
    const inner = (await owner.post('/api/folders', { workspaceId: ws, parentId: f.id, name: 'Deep' })).data;
    const d = await createDoc(owner, ws, 'Shared doc', 'pelican-keyword', inner.id);
    await owner.post(`/api/folders/${f.id}/permissions`, { user: 'guest', role: 'viewer' });
    expect((await guest.get('/api/search?q=pelican-keyword')).data.map((x: any) => x.id)).toEqual([d.id]);
    expect((await guest.get('/api/shared')).data).toEqual([expect.objectContaining({ type: 'folder', id: f.id, role: 'viewer' })]);
    const view = await guest.get(`/api/folders/${f.id}`);
    expect(view.data.documents.map((x: any) => x.id)).toEqual([d.id]);
    // the permission listing shows the inherited share on the document
    const perms = await owner.get(`/api/documents/${d.id}/permissions`);
    expect(perms.data.inherited).toEqual([expect.objectContaining({ role: 'viewer', fromFolder: 'Shared stuff' })]);
    // backlinks from documents the guest can't read are not revealed
    await createDoc(owner, ws, 'Private referrer', '[[Shared doc]]');
    expect((await guest.get(`/api/documents/${d.id}/backlinks`)).data).toEqual([]);
    expect((await owner.get(`/api/documents/${d.id}/backlinks`)).data).toHaveLength(1);
  });

  it('lets users remove their own access and only the owner delete the workspace', async () => {
    const leaver = await signup(env.app, 'leaver');
    await owner.post(`/api/workspaces/${ws}/members`, { user: 'leaver', role: 'admin' });
    expect((await leaver.del(`/api/workspaces/${ws}`)).statusCode).toBe(403);
    expect((await leaver.del(`/api/workspaces/${ws}/members/${owner.user.id}`)).statusCode).toBe(400);
    expect((await leaver.del(`/api/workspaces/${ws}/members/${leaver.user.id}`)).statusCode).toBe(200);
    expect((await leaver.get(`/api/workspaces/${ws}/tree`)).statusCode).toBe(404);
  });

  it('invites unknown e-mail addresses to the workspace and adds them on sign-up', async () => {
    const r = await owner.post(`/api/workspaces/${ws}/members`, { user: 'newbie@example.com', role: 'commenter' });
    expect(r.statusCode).toBe(202);
    const mail = env.mailer.last('newbie@example.com')!;
    const token = /invite=([\w-]+)/.exec(mail.text)![1];
    const c = new Client(env.app);
    await c.post('/api/auth/signup', { email: 'newbie@example.com', username: 'newbie', displayName: 'Newbie', password: 'password-123456', inviteToken: token });
    const list = await c.get('/api/workspaces');
    expect(list.data.find((w: any) => w.id === ws)?.role).toBe('commenter');
  });

  it('protects comments: only authors edit, editors moderate', async () => {
    const commenter = await signup(env.app, 'commenter2');
    const other = await signup(env.app, 'other2');
    const d = await createDoc(owner, ws, 'Discussed', 'text');
    await owner.post(`/api/documents/${d.id}/permissions`, { user: 'commenter2', role: 'commenter' });
    await owner.post(`/api/documents/${d.id}/permissions`, { user: 'other2', role: 'commenter' });
    const c = await commenter.post(`/api/documents/${d.id}/comments`, { body: 'mine', anchorText: 'text', anchorStart: 0, anchorEnd: 4 });
    expect((await other.patch(`/api/comments/${c.data.id}`, { body: 'hijack' })).statusCode).toBe(400);
    expect((await other.del(`/api/comments/${c.data.id}`)).statusCode).toBe(400);
    expect((await commenter.patch(`/api/comments/${c.data.id}`, { body: 'edited' })).statusCode).toBe(200);
    expect((await other.patch(`/api/comments/${c.data.id}`, { resolved: true })).statusCode).toBe(200);
    expect((await owner.del(`/api/comments/${c.data.id}`)).statusCode).toBe(200);
  });
});
