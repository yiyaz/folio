import { describe, it, expect } from 'vitest';
import {
  parseDocument,
  renderToHtml,
  rewriteWikiLinks,
  splitFrontmatter,
  setFrontmatterField,
  findTags,
  findMentions,
  findWikiLinks,
  applyTemplate,
  BUILTIN_TEMPLATES,
} from '../src/index.js';

describe('syntax scanners', () => {
  it('finds wiki links with anchors, block refs and aliases', () => {
    const l = findWikiLinks('see [[Doc]] and [[Other Doc#Setup|the setup]] and [[X#^abc-1]] and [[#Local]]');
    expect(l.map((x) => [x.target, x.anchor, x.alias])).toEqual([
      ['Doc', null, null],
      ['Other Doc', 'Setup', 'the setup'],
      ['X', '^abc-1', null],
      ['', 'Local', null],
    ]);
  });

  it('finds mentions but not e-mail addresses', () => {
    expect(findMentions('hi @alice and @bob.smith, mail me at x@example.com').map((m) => m.value)).toEqual(['alice', 'bob.smith']);
  });

  it('finds tags but not headings, numbers or url fragments', () => {
    expect(findTags('#ml #data/clean issue #42 http://x.y/#frag (#ok)').map((t) => t.value)).toEqual(['ml', 'data/clean', 'ok']);
  });
});

describe('parseDocument', () => {
  const src = `---
title: Pipeline Overview
tags: [Data, etl]
---
# Ignored H1

Intro paragraph linking [[Feature Store]] and [[Training#Hyper params|params]] for @alice. #ml

A key fact. ^fact-1

\`\`\`python
# not a tag, [[Not A Link]] @nobody
\`\`\`

Inline \`[[nope]]\` code.

## Hyper params
`;
  const p = parseDocument(src);

  it('reads the front matter title over the first H1', () => {
    expect(p.title).toBe('Pipeline Overview');
    expect(p.frontmatter.tags).toEqual(['Data', 'etl']);
  });

  it('extracts links with exact source offsets and skips code', () => {
    expect(p.links.map((l) => l.target)).toEqual(['Feature Store', 'Training']);
    for (const l of p.links) expect(src.slice(l.start, l.end)).toMatch(/^\[\[.*\]\]$/);
  });

  it('merges inline and front-matter tags', () => {
    expect(p.tags).toEqual(['data', 'etl', 'ml']);
  });

  it('extracts mentions, headings and block ids', () => {
    expect(p.mentions).toEqual(['alice']);
    expect(p.headings.map((h) => [h.depth, h.slug])).toEqual([
      [1, 'ignored-h1'],
      [2, 'hyper-params'],
    ]);
    expect(p.blockIds).toEqual(['fact-1']);
  });

  it('falls back to the first H1 as title', () => {
    expect(parseDocument('# Hello\n\ntext').title).toBe('Hello');
    expect(parseDocument('no title').title).toBeNull();
  });

  it('produces searchable plain text', () => {
    expect(p.text).toContain('A key fact');
  });
});

describe('frontmatter helpers', () => {
  it('splits and round-trips', () => {
    const s = splitFrontmatter('---\na: 1\n---\nbody');
    expect(s.data).toEqual({ a: 1 });
    expect(s.body).toBe('body');
  });

  it('adds a field to a document without front matter', () => {
    expect(setFrontmatterField('# T\n', 'id', 'abc')).toBe('---\nid: abc\n---\n\n# T\n');
  });

  it('updates a field and keeps comments and the body untouched', () => {
    const src = '---\n# keep me\ntitle: X\n---\nBody **bold**\n';
    const out = setFrontmatterField(src, 'id', 'z');
    expect(out).toContain('# keep me');
    expect(out).toContain('id: z');
    expect(out.endsWith('Body **bold**\n')).toBe(true);
  });

  it('leaves documents with invalid YAML unchanged', () => {
    const src = '---\n: : bad\n  - [\n---\nbody';
    expect(setFrontmatterField(src, 'id', 'z')).toBe(src);
  });
});

describe('rewriteWikiLinks', () => {
  it('renames targets case-insensitively and keeps anchors/aliases', () => {
    const src = 'A [[old name]] B [[Old Name#Sec|alias]] C `[[Old Name]]` D [[Other]]';
    expect(rewriteWikiLinks(src, 'Old Name', 'New Name')).toBe('A [[New Name]] B [[New Name#Sec|alias]] C `[[Old Name]]` D [[Other]]');
  });

  it('is a no-op when nothing matches (source preserved byte for byte)', () => {
    const src = '* weird   spacing\n\n\n|a|b|\n|-|-|\n';
    expect(rewriteWikiLinks(src, 'x', 'y')).toBe(src);
  });
});

describe('renderToHtml', () => {
  const resolve = (t: string, a: string | null) => (t === 'Exists' ? { href: `/d/1${a ? '#' + a.toLowerCase() : ''}`, exists: true } : null);

  it('renders wiki links, broken links, mentions and tags', () => {
    const html = renderToHtml('[[Exists]] [[Missing]] @alice #ml', { resolveWikiLink: resolve });
    expect(html).toContain('href="/d/1" class="wikilink"');
    expect(html).toContain('class="wikilink broken"');
    expect(html).toContain('class="mention"');
    expect(html).toContain('href="/tags/ml"');
  });

  it('turns block ids into anchor targets', () => {
    const html = renderToHtml('A fact ^f1');
    expect(html).toContain('id="block-f1"');
    expect(html).not.toContain('^f1');
  });

  it('adds ids to headings for deep links', () => {
    expect(renderToHtml('## Hyper params')).toContain('id="hyper-params"');
  });

  it('sanitises dangerous HTML', () => {
    const html = renderToHtml('<img src=x onerror="alert(1)"><script>alert(1)</script>[x](javascript:alert(1))');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });

  it('renders math with KaTeX and highlights code but leaves diagram blocks for enhancers', () => {
    const html = renderToHtml('$E=mc^2$\n\n```js\nconst a = 1\n```\n\n```mermaid\ngraph TD; A-->B\n```');
    expect(html).toContain('katex');
    expect(html).toContain('hljs');
    expect(html).toContain('language-mermaid');
    expect(html).toContain('graph TD; A--');
  });

  it('marks runnable code blocks and embeddable links', () => {
    const html = renderToHtml('```python run\nprint(1)\n```\n\nhttps://github.com/a/b/pull/1', { isEmbeddableUrl: (u) => u.includes('github.com') });
    expect(html).toContain('data-run="true"');
    expect(html).toContain('data-embed-url="https://github.com/a/b/pull/1"');
  });

  it('renders GFM task lists and tables', () => {
    const html = renderToHtml('- [x] done\n- [ ] todo\n\n|a|b|\n|-|-|\n|1|2|');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<table>');
  });
});

describe('templates', () => {
  it('substitutes variables', () => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === 'adr')!;
    const out = applyTemplate(t.body, { title: 'Use Postgres', author: 'alice', date: '2026-01-01' });
    expect(out).toContain('# Use Postgres');
    expect(out).toContain('date: 2026-01-01');
    expect(parseDocument(out).tags).toContain('adr');
  });
});
