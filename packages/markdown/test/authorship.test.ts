import { describe, expect, it } from 'vitest';
import { anonymizeHumans, applyChange, attributeEdit, authorStats, fromSpans, isAuthorship, toSpans, uniform, type Author } from '../src/index.js';

const alice: Author = { kind: 'user', id: 'alice' };
const bob: Author = { kind: 'user', id: 'bob' };
const ai: Author = { kind: 'ai', generationId: 'g1', model: 'm', requestedBy: 'alice' };
/** Render attribution as text like "aaaBBB" using one letter per author, for readable asserts. */
const show = (text: string, a: ReturnType<typeof uniform>) =>
  toSpans(a)
    .map((s) => (s.author.kind === 'ai' ? '#' : s.author.id[0]).repeat(s.to - s.from))
    .join('') + ` | ${text}`;

describe('attributeEdit', () => {
  it('keeps authors of untouched text and gives inserted text to the editor', () => {
    const v1 = uniform(11, alice);
    const v2 = attributeEdit(v1, 'Hello world', 'Hello brave world', bob);
    expect(show('Hello brave world', v2)).toBe('aaaaaabbbbbbaaaaa | Hello brave world');
  });

  it('handles deletions and replacements in the middle', () => {
    const v1 = uniform(13, alice);
    const v2 = attributeEdit(v1, 'The quick fox', 'The slow fox', bob);
    expect(show('The slow fox', v2)).toBe('aaaabbbbaaaa | The slow fox');
    const v3 = attributeEdit(v2, 'The slow fox', 'The fox', alice);
    expect(show('The fox', v3)).toBe('aaaaaaa | The fox');
  });

  it('attributes claimed insertions to the AI and the rest to the human', () => {
    const v1 = uniform(6, alice);
    const text = 'Intro AI wrote this. End';
    const claims = [{ from: 6, to: 20, author: ai }];
    const v2 = attributeEdit(v1, 'Intro ', text, alice, claims);
    expect(show(text, v2)).toBe('aaaaaa##############aaaa | ' + text);
  });

  it('shows a human edit inside an AI sentence', () => {
    const text = 'The model is accurate.';
    const v1 = uniform(text.length, ai);
    const edited = 'The model is very accurate.';
    const v2 = attributeEdit(v1, text, edited, bob);
    expect(show(edited, v2)).toBe('#############bbbbb######### | ' + edited);
  });

  it('repairs authorship that does not match the text length', () => {
    const broken = uniform(3, alice);
    const v = attributeEdit(broken, 'abcdef', 'abcdefg', bob);
    expect(toSpans(v).at(-1)!.to).toBe(7);
  });

  it('falls back gracefully for a complete rewrite', () => {
    const a = 'x'.repeat(5000);
    const b = 'y'.repeat(5000);
    expect(show(b, attributeEdit(uniform(5000, alice), a, b, bob)).startsWith('bbbbb')).toBe(true);
  });
});

describe('applyChange (editor-side)', () => {
  it('splits a span when typing inside it', () => {
    const spans = toSpans(uniform(10, ai));
    const out = fromSpans(applyChange(spans, 4, 4, 3, bob));
    expect(show('x'.repeat(13), out)).toBe('####bbb###### | ' + 'x'.repeat(13));
  });
  it('removes deleted ranges', () => {
    const out = fromSpans(applyChange(toSpans(uniform(10, alice)), 2, 8, 0, bob));
    expect(toSpans(out)).toEqual([{ from: 0, to: 4, author: alice }]);
  });
});

describe('helpers', () => {
  it('computes shares, anonymizes humans and validates', () => {
    const a = fromSpans([
      { from: 0, to: 6, author: alice },
      { from: 6, to: 8, author: bob },
      { from: 8, to: 10, author: ai },
    ]);
    expect(authorStats(a).map((s) => [s.author.kind === 'ai' ? 'ai' : s.author.id, s.share])).toEqual([
      ['alice', 0.6],
      ['bob', 0.2],
      ['ai', 0.2],
    ]);
    expect(anonymizeHumans(a).authors).toEqual([{ kind: 'user', id: 'human' }, ai]);
    expect(isAuthorship(a)).toBe(true);
    expect(isAuthorship({ v: 1, authors: [], runs: [[3, 0]] })).toBe(false);
  });
});
