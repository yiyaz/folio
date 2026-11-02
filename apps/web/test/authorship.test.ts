import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { renderToHtml, toSpans, uniform, fromSpans, type Author, type Span } from '@folio/markdown';
import { authorshipExtension, authorshipField, aiClaims, insertedBy, setAuthorship, setLocalAuthor } from '../src/editor/authorship';
import { highlightRendered, sentencesWithAi, styleSpans, emptyMeta } from '../src/authorship';

const alice: Author = { kind: 'user', id: 'alice' };
const bob: Author = { kind: 'user', id: 'bob' };
const ai: Author = { kind: 'ai', generationId: 'g1', model: 'm', requestedBy: 'alice' };

function editor(doc: string, spans: Span[], me: Author) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [authorshipExtension({ localAuthor: () => me, mode: () => 'ai', meta: () => emptyMeta })] }),
    parent,
  });
  view.dispatch({ effects: [setLocalAuthor.of(me), setAuthorship.of(spans)] });
  return view;
}
const field = (v: EditorView) => fromSpans(v.state.field(authorshipField));
const initials = (v: EditorView) =>
  toSpans(field(v))
    .map((s) => (s.author.kind === 'ai' ? '#' : s.author.id[0]).repeat(s.to - s.from))
    .join('');

describe('editor attribution', () => {
  it('attributes local typing to the local person, even inside AI text', () => {
    const v = editor('AI text here.', toSpans(uniform(13, ai)), bob);
    v.dispatch({ changes: { from: 3, insert: 'new ' } });
    expect(initials(v)).toBe('###bbbb##########');
  });

  it('attributes AI insertions to the generation and produces claims for the save', () => {
    const v = editor('Intro.', toSpans(uniform(6, alice)), alice);
    v.dispatch({ changes: { from: 6, insert: ' Generated.' }, annotations: insertedBy.of(ai) });
    expect(initials(v)).toBe('aaaaaa###########');
    expect(aiClaims(v.state.field(authorshipField))).toEqual([{ from: 6, to: 17, generationId: 'g1' }]);
  });

  it('takes server attribution as-is when content and authorship are replaced together', () => {
    const v = editor('old', toSpans(uniform(3, alice)), bob);
    v.dispatch({ changes: { from: 0, to: 3, insert: 'server text' }, effects: setAuthorship.of(toSpans(uniform(11, alice))) });
    expect(initials(v)).toBe('a'.repeat(11));
  });
});

describe('what gets highlighted', () => {
  const text = 'The model is very accurate. A human wrote this.';
  const spans: Span[] = [
    { from: 0, to: 13, author: ai },
    { from: 13, to: 18, author: bob }, // "very " inserted by Bob into the AI sentence
    { from: 18, to: 28, author: ai },
    { from: 28, to: text.length, author: alice },
  ];

  it('AI mode: tints AI text and underlines only human edits inside AI sentences', () => {
    const s = styleSpans(text, spans, 'ai', emptyMeta);
    expect(s.map((x) => [x.className, text.slice(x.from, x.to)])).toEqual([
      ['auth-ai', 'The model is '],
      ['auth-edited', 'very '],
      ['auth-ai', 'accurate. '],
    ]);
    expect(s[1].title).toMatch(/edited AI text/);
  });

  it('everyone mode: every person is shown too', () => {
    const s = styleSpans(text, spans, 'all', emptyMeta);
    expect(s.map((x) => x.className)).toEqual(['auth-ai', 'auth-edited', 'auth-ai', 'auth-person']);
  });

  it('off: nothing', () => {
    expect(styleSpans(text, spans, 'off', emptyMeta)).toEqual([]);
  });

  it('finds sentences that contain AI text, never crossing lines', () => {
    const t = 'Human line.\nAI sentence one. Human sentence two.';
    const sp: Span[] = [
      { from: 0, to: 12, author: alice },
      { from: 12, to: 29, author: ai },
      { from: 29, to: t.length, author: alice },
    ];
    expect(sentencesWithAi(t, sp).map((r) => t.slice(r.from, r.to).trim())).toEqual(['AI sentence one.']);
  });
});

describe('rendered page highlighting', () => {
  it('splits rendered text at author boundaries using source offsets', () => {
    const src = '# Title\n\nWritten by AI. Edited by Bob.';
    const aiEnd = src.indexOf(' Edited');
    const spans: Span[] = [
      { from: 0, to: aiEnd, author: ai },
      { from: aiEnd, to: src.length, author: bob },
    ];
    const root = document.createElement('div');
    root.innerHTML = renderToHtml(src, { sourceSpans: true });
    highlightRendered(root, src, spans, 'all', emptyMeta);
    expect(root.querySelector('h1 .auth-ai, h1.auth-ai, h1 span.auth-ai')).not.toBeNull();
    const aiText = [...root.querySelectorAll('.auth-ai')].map((e) => e.textContent).join('');
    expect(aiText).toContain('Written by AI.');
    expect(aiText).not.toContain('Bob');
    expect([...root.querySelectorAll('.auth-person')].map((e) => e.textContent).join('')).toContain('Edited by Bob.');
  });
});

describe('source alignment', () => {
  it('maps rendered text back to source offsets despite dropped indentation and escapes', async () => {
    const { alignToSource } = await import('../src/authorship');
    const src = 'a \\*b\n  c';
    const rendered = 'a *b\nc';
    const offs = alignToSource(rendered, src, 100);
    expect(rendered.split('').map((ch, i) => `${ch}@${offs[i] - 100}`)).toEqual(['a@0', ' @1', '*@3', 'b@4', '\n@5', 'c@8']);
  });

  it('highlights a word edited inside a lazily continued list item', () => {
    const src = '- AI says key point.\n Human line.';
    const at = src.indexOf('key');
    const spans: Span[] = [
      { from: 0, to: at, author: ai },
      { from: at, to: at + 4, author: bob },
      { from: at + 4, to: src.indexOf('\n'), author: ai },
      { from: src.indexOf('\n'), to: src.length, author: alice },
    ];
    const root = document.createElement('div');
    root.innerHTML = renderToHtml(src, { sourceSpans: true });
    highlightRendered(root, src, spans, 'ai', emptyMeta);
    expect([...root.querySelectorAll('.auth-edited')].map((e) => e.textContent)).toEqual(['key ']);
  });
});
