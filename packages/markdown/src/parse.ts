import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import { visit, SKIP } from 'unist-util-visit';
import { toString } from 'mdast-util-to-string';
import GithubSlugger from 'github-slugger';
import type { Root, Text, Parent } from 'mdast';
import { splitFrontmatter } from './frontmatter.js';
import { findWikiLinks, findMentions, findTags, BLOCK_ID_RE } from './syntax.js';

export interface ParsedLink {
  target: string;
  anchor: string | null;
  alias: string | null;
  /** Offset of the full `[[...]]` in the source document. */
  start: number;
  end: number;
}

export interface ParsedHeading {
  depth: number;
  text: string;
  slug: string;
  line: number;
}

export interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  title: string | null;
  links: ParsedLink[];
  tags: string[];
  mentions: string[];
  headings: ParsedHeading[];
  blockIds: string[];
  /** Plain-text projection used for full-text search. */
  text: string;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']).use(remarkMath);

export function parseMarkdownTree(source: string): Root {
  return parser.parse(source) as Root;
}

const SKIP_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'yaml', 'html']);

/**
 * Visit text nodes that may contain Folio inline syntax, giving the source offset
 * of the node. Text inside code, math, raw HTML and front matter is skipped.
 */
export function visitSyntaxText(tree: Root, source: string, fn: (text: string, offset: number) => void) {
  visit(tree, (node, _i, parent) => {
    if (SKIP_TYPES.has(node.type)) return SKIP;
    if (node.type !== 'text') return;
    const t = node as Text;
    const start = t.position?.start.offset;
    const end = t.position?.end.offset;
    if (start == null || end == null) return;
    const raw = source.slice(start, end);
    // Text node values may differ from the source when escapes or entities are
    // present; we scan the raw source slice so offsets are always exact.
    // Links in markdown `[text](url)` are parents of text: a wikilink inside a
    // normal link label is meaningless, so skip those too.
    if (parent && (parent as Parent).type === 'link') return;
    fn(raw, start);
  });
}

export function parseDocument(source: string): ParsedDocument {
  const { data } = splitFrontmatter(source);
  const tree = parseMarkdownTree(source);
  const links: ParsedLink[] = [];
  const tags = new Set<string>();
  const mentions = new Set<string>();
  const headings: ParsedHeading[] = [];
  const blockIds: string[] = [];
  const slugger = new GithubSlugger();

  visitSyntaxText(tree, source, (text, offset) => {
    for (const l of findWikiLinks(text)) {
      links.push({ target: l.target, anchor: l.anchor, alias: l.alias, start: offset + l.index, end: offset + l.index + l.length });
    }
    for (const m of findMentions(text)) mentions.add(m.value);
    for (const t of findTags(text)) tags.add(t.value);
  });

  let firstH1: string | null = null;
  visit(tree, (node) => {
    if (node.type === 'heading') {
      const text = toString(node).trim();
      headings.push({ depth: node.depth, text, slug: slugger.slug(text), line: node.position?.start.line ?? 0 });
      if (node.depth === 1 && firstH1 == null) firstH1 = text;
    }
    if (node.type === 'paragraph') {
      const m = BLOCK_ID_RE.exec(toString(node));
      if (m) blockIds.push(m[1]);
    }
  });

  for (const t of normaliseTagList(data.tags)) tags.add(t);

  const fmTitle = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
  return {
    frontmatter: data,
    title: fmTitle ?? firstH1,
    links,
    tags: [...tags].sort(),
    mentions: [...mentions].sort(),
    headings,
    blockIds,
    text: plainText(tree),
  };
}

function normaliseTagList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  return arr
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/^#/, '').trim().toLowerCase())
    .filter(Boolean);
}

/** Plain-text projection with block boundaries preserved as spaces. */
function plainText(tree: Root): string {
  const parts: string[] = [];
  visit(tree, (node) => {
    if (node.type === 'yaml') return SKIP;
    if ('value' in node && typeof node.value === 'string' && node.type !== 'html') parts.push(node.value);
  });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
