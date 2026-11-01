import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Client, createDoc, createTestEnv, personalWorkspace, signup, type TestEnv } from './helpers.js';

function wsClient(url: string, cookie: string) {
  const sock = new WebSocket(url, { headers: { cookie } });
  const messages: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  sock.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    messages.push(m);
    for (const w of [...waiters]) {
      if (!w.pred(m)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  return {
    sock,
    opened: new Promise<void>((res, rej) => (sock.once('open', () => res()), sock.once('error', rej))),
    send: (m: unknown) => sock.send(JSON.stringify(m)),
    waitFor: (pred: (m: any) => boolean, ms = 5000) =>
      new Promise<any>((resolve, reject) => {
        const hit = messages.find(pred);
        if (hit) return resolve(hit);
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error('timed out waiting for websocket message')), ms);
      }),
  };
}

describe('mentions, comments and notifications', () => {
  let env: TestEnv;
  let alice: Client;
  let bob: Client;
  let ws: string;
  beforeAll(async () => {
    env = await createTestEnv();
    alice = await signup(env.app, 'alice');
    bob = await signup(env.app, 'bob');
    ws = await personalWorkspace(alice);
  });
  afterAll(() => env.close());

  it('reports mentioned users who lack access instead of notifying them', async () => {
    const d = await createDoc(alice, ws, 'Plan', 'Hey @bob, take a look');
    expect(d).toMatchObject({ mentionedWithoutAccess: [expect.objectContaining({ username: 'bob' })] });
    expect((await bob.get('/api/notifications')).data.unread).toBe(0);
  });

  it('notifies on share and on new mentions (once), by app and e-mail', async () => {
    const d = await createDoc(alice, ws, 'Roadmap', 'draft');
    await alice.post(`/api/documents/${d.id}/permissions`, { user: 'bob', role: 'editor' });
    let n = await bob.get('/api/notifications');
    expect(n.data.items[0]).toMatchObject({ type: 'share', payload: { documentId: d.id, role: 'editor' } });
    expect(env.mailer.last('bob@example.com')!.subject).toContain('shared "Roadmap"');

    const s1 = await alice.put(`/api/documents/${d.id}/content`, { content: 'draft — @bob please review the budget section', baseVersion: 1 });
    expect(s1.data.mentionedWithoutAccess).toEqual([]);
    n = await bob.get('/api/notifications');
    expect(n.data.items[0]).toMatchObject({ type: 'mention', payload: { documentId: d.id } });
    expect(n.data.items[0].payload.excerpt).toContain('@bob please review');
    const count = n.data.items.length;
    // saving again with the same mention does not re-notify
    await alice.put(`/api/documents/${d.id}/content`, { content: 'draft — @bob please review the budget section!', baseVersion: 2 });
    expect((await bob.get('/api/notifications')).data.items.length).toBe(count);
    // self-mentions never notify
    await alice.put(`/api/documents/${d.id}/content`, { content: '@alice note to self', baseVersion: 3 });
    expect((await alice.get('/api/notifications')).data.items.filter((x: any) => x.type === 'mention')).toHaveLength(0);
  });

  it('respects the e-mail notification preference', async () => {
    await bob.patch('/api/users/me', { prefs: { emailNotifications: false } });
    const before = env.mailer.sent.length;
    const d = await createDoc(alice, ws, 'Quiet', 'x');
    await alice.post(`/api/documents/${d.id}/permissions`, { user: 'bob', role: 'viewer' });
    expect(env.mailer.sent.length).toBe(before);
    expect((await bob.get('/api/notifications')).data.items[0].type).toBe('share');
    await bob.patch('/api/users/me', { prefs: { emailNotifications: true } });
  });

  it('notifies document authors about comments and comment authors about replies', async () => {
    const d = await createDoc(alice, ws, 'Spec', 'The API returns JSON.');
    await alice.post(`/api/documents/${d.id}/permissions`, { user: 'bob', role: 'commenter' });
    const c = await bob.post(`/api/documents/${d.id}/comments`, { body: 'Which version?', anchorText: 'returns JSON', anchorStart: 8, anchorEnd: 20 });
    expect((await alice.get('/api/notifications')).data.items[0]).toMatchObject({ type: 'comment', payload: { commentId: c.data.id } });
    await alice.post(`/api/documents/${d.id}/comments`, { body: 'v2, see @bob', parentId: c.data.id });
    const bn = await bob.get('/api/notifications');
    expect(bn.data.items[0].type).toBe('reply');
    expect(bn.data.items.filter((x: any) => x.payload.commentId && x.type === 'mention')).toHaveLength(0); // reply already notified bob
    const list = await alice.get(`/api/documents/${d.id}/comments`);
    expect(list.data).toHaveLength(2);
    expect(list.data[0]).toMatchObject({ anchorText: 'returns JSON', anchorStart: 8 });
    // replies cannot be nested
    const reply = list.data.find((x: any) => x.parentId);
    expect((await alice.post(`/api/documents/${d.id}/comments`, { body: 'deep', parentId: reply.id })).statusCode).toBe(400);
  });

  it('marks notifications read', async () => {
    const before = await bob.get('/api/notifications');
    expect(before.data.unread).toBeGreaterThan(0);
    await bob.post(`/api/notifications/${before.data.items[0].id}/read`);
    expect((await bob.get('/api/notifications')).data.unread).toBe(before.data.unread - 1);
    await bob.post('/api/notifications/read-all');
    expect((await bob.get('/api/notifications')).data.unread).toBe(0);
  });
});

describe('realtime websocket', () => {
  let env: TestEnv;
  let base: string;
  beforeAll(async () => {
    env = await createTestEnv();
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = env.app.server.address() as { port: number };
    base = `ws://127.0.0.1:${addr.port}/api/ws`;
  });
  afterAll(() => env.close());

  it('rejects unauthenticated sockets', async () => {
    const sock = new WebSocket(base);
    const code = await new Promise<number>((res) => sock.on('close', (c) => res(c)));
    expect(code).toBe(4401);
  });

  it('broadcasts presence, document updates, comments and notifications', async () => {
    const alice = await signup(env.app, 'wsalice');
    const bob = await signup(env.app, 'wsbob');
    const ws = await personalWorkspace(alice);
    const d = await createDoc(alice, ws, 'Live', 'v1');
    await alice.post(`/api/documents/${d.id}/permissions`, { user: 'wsbob', role: 'editor' });

    const a = wsClient(base, alice.cookie);
    const b = wsClient(base, bob.cookie);
    await Promise.all([a.opened, b.opened]);
    a.send({ type: 'join', docId: d.id });
    b.send({ type: 'join', docId: d.id });
    const presence = await a.waitFor((m) => m.type === 'presence' && m.users.length === 2);
    expect(presence.users.map((u: any) => u.username).sort()).toEqual(['wsalice', 'wsbob']);

    await bob.put(`/api/documents/${d.id}/content`, { content: 'v2 by bob @wsalice', baseVersion: 1 });
    const upd = await a.waitFor((m) => m.type === 'doc-updated');
    expect(upd).toMatchObject({ docId: d.id, version: 2, byName: 'Wsbob' });
    const notif = await a.waitFor((m) => m.type === 'notification');
    expect(notif.notification.type).toBe('mention');

    await bob.post(`/api/documents/${d.id}/comments`, { body: 'hi' });
    await a.waitFor((m) => m.type === 'comments-changed' && m.docId === d.id);

    b.sock.close();
    const after = await a.waitFor((m) => m.type === 'presence' && m.users.length === 1);
    expect(after.users[0].username).toBe('wsalice');
    a.sock.close();
  });

  it('refuses to join documents without access', async () => {
    const owner = await signup(env.app, 'wsowner');
    const outsider = await signup(env.app, 'wsoutsider');
    const d = await createDoc(owner, await personalWorkspace(owner), 'Private', 'x');
    const o = wsClient(base, outsider.cookie);
    await o.opened;
    o.send({ type: 'join', docId: d.id });
    expect(await o.waitFor((m) => m.type === 'error')).toEqual({ type: 'error', error: 'forbidden' });
    o.sock.close();
  });
});
