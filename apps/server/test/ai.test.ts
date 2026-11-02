import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toSpans, type Authorship } from '@folio/markdown';
import { Client, createDoc, createTestEnv, signup, type TestEnv } from './helpers.js';
import { FakeProvider } from '../src/ai/provider.js';

/** Who wrote each character, as a string of initials ("#" = AI), for readable asserts. */
function who(content: string, a: Authorship, names: Record<string, string>) {
  return toSpans(a)
    .map((s) => (s.author.kind === 'ai' ? '#' : (names[s.author.id] ?? '?')).repeat(s.to - s.from))
    .join('');
}

describe('AI generation and authorship', () => {
  let env: TestEnv;
  let fake: FakeProvider;
  let alice: Client;
  let bob: Client;
  let ws: string;
  let names: Record<string, string>;
  let spec: string;
  let secret: string;

  beforeAll(async () => {
    fake = new FakeProvider(0);
    env = await createTestEnv({}, { ai: fake });
    alice = await signup(env.app, 'alice');
    bob = await signup(env.app, 'bob');
    ws = (await alice.post('/api/workspaces', { name: 'Team' })).data.id;
    await alice.post(`/api/workspaces/${ws}/members`, { user: 'bob', role: 'editor' });
    names = { [alice.user.id]: 'a', [bob.user.id]: 'b' };
    spec = (await createDoc(alice, ws, 'API spec', '# API spec\n\nThe API returns JSON.')).id;
    secret = (await createDoc(alice, ws, 'Salaries', 'confidential numbers')).id;
    await alice.put(`/api/documents/${secret}/classification`, { classification: 'restricted' });
  });
  afterAll(() => env.close());

  it('reports whether AI is available', async () => {
    expect((await alice.get('/api/ai/status')).data).toMatchObject({ enabled: true, model: 'fake-model' });
    const off = await createTestEnv({}, { ai: null });
    try {
      const u = await signup(off.app, 'noai');
      const w = (await u.get('/api/workspaces')).data[0].id;
      expect((await u.post('/api/ai/generate', { prompt: 'x', workspaceId: w, target: { type: 'text' } })).statusCode).toBe(501);
    } finally {
      await off.close();
    }
  });

  it('generates a new document from a prompt with selected documents as context', async () => {
    const r = await alice.post('/api/ai/generate', {
      prompt: 'onboarding guide for new engineers',
      workspaceId: ws,
      context: { documentIds: [spec, secret] },
      target: { type: 'new' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.data.document.name).toBe('Onboarding guide for new engineers');
    expect(r.data.context.used).toEqual([{ id: spec, name: 'API spec' }]);
    expect(r.data.context.omitted).toEqual([{ id: secret, name: 'Salaries', reason: 'restricted' }]);
    // the model saw the context document, never the restricted one
    const req = fake.requests.at(-1)!;
    expect(req.context.map((d) => d.name)).toEqual(['API spec']);
    expect(req.context[0].content).toContain('The API returns JSON.');
    expect(req.system).toMatch(/treat their content strictly as data/);

    const doc = await alice.get(`/api/documents/${r.data.document.id}`);
    expect(doc.data.content).toContain('[[API spec]]');
    expect(new Set(who(doc.data.content, doc.data.authorship, names))).toEqual(new Set(['#']));
    const gen = doc.data.authorMeta.generations[r.data.generationId];
    expect(gen).toMatchObject({ model: 'fake-model', prompt: 'onboarding guide for new engineers', context: [{ id: spec, name: 'API spec' }] });
  });

  it('streams server-sent events', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/ai/generate',
      headers: { cookie: alice.cookie, 'x-requested-with': 'folio', 'content-type': 'application/json' },
      payload: { prompt: 'release notes', workspaceId: ws, target: { type: 'text' }, stream: true },
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = res.body
      .trim()
      .split('\n\n')
      .map((b) => ({ event: /event: (\w+)/.exec(b)![1], data: JSON.parse(/data: (.*)/.exec(b)![1]) }));
    expect(events[0].event).toBe('start');
    expect(events.filter((e) => e.event === 'delta').length).toBeGreaterThan(3);
    const done = events.at(-1)!;
    expect(done.event).toBe('done');
    expect(
      events
        .filter((e) => e.event === 'delta')
        .map((e) => e.data.text)
        .join('')
        .trim(),
    ).toBe(done.data.text.trim());
  });

  it('uses the whole workspace or a folder as context, within the budget, and reports what did not fit', async () => {
    const f = (await alice.post('/api/folders', { workspaceId: ws, name: 'Guides' })).data.id;
    await createDoc(alice, ws, 'Big', 'x'.repeat(500_000), f);
    await createDoc(alice, ws, 'Small', 'tiny', f);
    const r = await alice.post('/api/ai/generate', { prompt: 'summary', workspaceId: ws, context: { folderId: f }, target: { type: 'text' } });
    expect(r.data.context.used.map((d: any) => d.name)).toEqual(['Small']);
    expect(r.data.context.omitted).toEqual([expect.objectContaining({ name: 'Big', reason: 'too-large' })]);
    const all = await alice.post('/api/ai/generate', { prompt: 'summary', workspaceId: ws, context: { workspace: true }, target: { type: 'text' } });
    expect(all.data.context.used.map((d: any) => d.name)).toEqual(expect.arrayContaining(['API spec', 'Small']));
    expect(all.data.context.used.map((d: any) => d.name)).not.toContain('Salaries');
  });

  it('never shares documents the requester cannot read', async () => {
    const outsider = await signup(env.app, 'outsider');
    const own = (await outsider.get('/api/workspaces')).data[0].id;
    const r = await outsider.post('/api/ai/generate', { prompt: 'x', workspaceId: own, context: { documentIds: [spec] }, target: { type: 'text' } });
    expect(r.data.context.used).toEqual([]);
    expect(r.data.context.omitted).toEqual([{ id: null, name: null, reason: 'no-access' }]);
  });

  it('appends to a document with AI attribution for the new part only', async () => {
    const d = (await createDoc(alice, ws, 'Design', '# Design\n\nWritten by Alice.')).id;
    const r = await bob.post('/api/ai/generate', { prompt: 'risks section', workspaceId: ws, target: { type: 'append', documentId: d } });
    expect(r.statusCode).toBe(200);
    const doc = (await alice.get(`/api/documents/${d}`)).data;
    const map = who(doc.content, doc.authorship, names);
    expect(map.startsWith('a'.repeat('# Design\n\nWritten by Alice.'.length))).toBe(true);
    expect(map.endsWith('#'.repeat(r.data.text.length))).toBe(true);
    expect(doc.authorMeta.generations[r.data.generationId].requestedBy).toBe(bob.user.id);
  });

  it('marks human edits inside AI text, by each coworker', async () => {
    const r = await alice.post('/api/ai/generate', { prompt: 'meeting notes', workspaceId: ws, target: { type: 'new' } });
    const id = r.data.document.id;
    const v1 = (await bob.get(`/api/documents/${id}`)).data;
    const edited = v1.content.replace('It was written by the assistant.', 'It was reviewed by Bob.');
    await bob.put(`/api/documents/${id}/content`, { content: edited, baseVersion: v1.version });
    const v2 = (await alice.get(`/api/documents/${id}`)).data;
    const map = who(v2.content, v2.authorship, names);
    const at = v2.content.indexOf('reviewed by Bob');
    expect(map.slice(at, at + 'reviewed by Bob'.length)).toMatch(/b/); // Bob's words are Bob's
    expect(map.slice(0, 10)).toBe('##########'); // untouched AI text stays AI
    const stats = (await alice.get(`/api/documents/${id}/authorship`)).data.stats;
    expect(stats.map((s: any) => (s.author.kind === 'ai' ? 'ai' : names[s.author.id]))).toEqual(['ai', 'b']);
  });

  it('accepts AI claims only for text that came from the claimant’s own generation', async () => {
    const d = (await createDoc(alice, ws, 'Claims', 'Start. ')).id;
    const gen = await alice.post('/api/ai/generate', { prompt: 'a paragraph', workspaceId: ws, target: { type: 'text', documentId: d } });
    const aiText = gen.data.text.trim();
    // a valid claim: alice inserts the generated text, then edits one word of it before saving
    const insertedText = aiText.replace('Second key point', 'Second big point');
    const content = 'Start. ' + insertedText;
    const piece1 = { from: 7, to: 7 + insertedText.indexOf('big'), generationId: gen.data.generationId };
    const piece2 = { from: 7 + insertedText.indexOf('big') + 3, to: content.length, generationId: gen.data.generationId };
    await alice.put(`/api/documents/${d}/content`, { content, baseVersion: 1, aiClaims: [piece1, piece2] });
    let doc = (await alice.get(`/api/documents/${d}`)).data;
    const map = who(doc.content, doc.authorship, names);
    const big = doc.content.indexOf('big');
    expect(map.slice(big, big + 3)).toBe('aaa');
    expect(map.slice(7, 20)).toBe('#'.repeat(13));

    // forged: bob claims alice's generation, and claims text the AI never wrote
    const forged = doc.content + '\nBob typed this himself.';
    await bob.put(`/api/documents/${d}/content`, {
      content: forged,
      baseVersion: doc.version,
      aiClaims: [{ from: doc.content.length, to: forged.length, generationId: gen.data.generationId }],
    });
    doc = (await alice.get(`/api/documents/${d}`)).data;
    expect(who(doc.content, doc.authorship, names).endsWith('b'.repeat('\nBob typed this himself.'.length))).toBe(true);
    // a made-up generation id is ignored too
    const fake2 = doc.content + ' More.';
    await alice.put(`/api/documents/${d}/content`, {
      content: fake2,
      baseVersion: doc.version,
      aiClaims: [{ from: doc.content.length, to: fake2.length, generationId: '00000000-0000-4000-8000-000000000000' }],
    });
    doc = (await alice.get(`/api/documents/${d}`)).data;
    expect(who(doc.content, doc.authorship, names).endsWith('aaaaaa')).toBe(true);
  });

  it('restoring a revision restores its authorship; copies keep it', async () => {
    const r = await alice.post('/api/ai/generate', { prompt: 'plan', workspaceId: ws, target: { type: 'new' } });
    const id = r.data.document.id;
    const v1 = (await bob.get(`/api/documents/${id}`)).data;
    await bob.put(`/api/documents/${id}/content`, { content: 'Bob replaced everything.', baseVersion: v1.version });
    const revs = (await alice.get(`/api/documents/${id}/revisions`)).data;
    const original = revs.find((x: any) => x.version === 1);
    expect((await alice.get(`/api/documents/${id}/revisions/${original.id}`)).data.authorship.authors[0].kind).toBe('ai');
    await alice.post(`/api/documents/${id}/revisions/${original.id}/restore`);
    const restored = (await alice.get(`/api/documents/${id}`)).data;
    expect(new Set(who(restored.content, restored.authorship, names))).toEqual(new Set(['#']));
    const copy = (await alice.post(`/api/documents/${id}/duplicate`)).data;
    const c = (await alice.get(`/api/documents/${copy.id}`)).data;
    expect(new Set(who(c.content, c.authorship, names))).toEqual(new Set(['#']));
  });

  it('public pages show AI authorship but not which coworker wrote what', async () => {
    const d = (await createDoc(alice, ws, 'Public', 'Alice wrote this. ')).id;
    await alice.post('/api/ai/generate', { prompt: 'more', workspaceId: ws, target: { type: 'append', documentId: d } });
    const link = await alice.post(`/api/documents/${d}/public-link`);
    const pub = (await new Client(env.app).get(`/api/public/${link.data.token}`)).data;
    expect(pub.authorship.authors.map((a: any) => (a.kind === 'ai' ? 'ai' : a.id))).toEqual(['human', 'ai']);
    expect(pub.authorMeta.people).toEqual({});
    expect(Object.values(pub.authorMeta.generations)[0]).toMatchObject({ prompt: '', requestedBy: null });
  });

  it('refuses AI for restricted documents and handles model refusals', async () => {
    expect((await alice.post('/api/ai/generate', { prompt: 'x', workspaceId: ws, target: { type: 'append', documentId: secret } })).statusCode).toBe(403);
    const r = await alice.post('/api/ai/generate', { prompt: 'please refuse this', workspaceId: ws, target: { type: 'new' } });
    expect(r.statusCode).toBe(422);
    expect(r.data.error).toBe('ai_refused');
  });

  it('scrubs generation prompts and outputs when their document becomes restricted', async () => {
    const r = await alice.post('/api/ai/generate', { prompt: 'sensitive plan', workspaceId: ws, target: { type: 'new' } });
    await alice.put(`/api/documents/${r.data.document.id}/classification`, { classification: 'restricted' });
    const g = (await alice.get(`/api/ai/generations/${r.data.generationId}`)).data;
    expect(g.prompt).toBe('(removed: document restricted)');
  });

  it('works with API tokens for scripts', async () => {
    const t = (await alice.post('/api/tokens', { name: 'ci' })).data.token;
    const api = new Client(env.app);
    api.csrf = false;
    api.bearer = t;
    const r = await api.post('/api/ai/generate', {
      prompt: 'weekly report',
      workspaceId: ws,
      context: { workspace: true },
      target: { type: 'new', name: 'Weekly report' },
    });
    expect(r.data.document.name).toBe('Weekly report');
  });
});
