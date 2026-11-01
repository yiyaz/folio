/**
 * Inline Folio syntax shared by the parser, renderer and editor.
 *
 *   [[Target]]  [[Target|alias]]  [[Target#Heading]]  [[Target#^block-id]]
 *   @username   #tag   #nested/tag   trailing " ^block-id" on a paragraph
 */
export const WIKILINK_RE = /\[\[([^\[\]\|\n#]*)(?:#(\^?[^\[\]\|\n]+))?(?:\|([^\[\]\n]+))?\]\]/g;
export const MENTION_RE = /(^|[\s(])@([a-zA-Z0-9_][a-zA-Z0-9_.-]{1,31}[a-zA-Z0-9_]|[a-zA-Z0-9_]{2})/g;
export const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;
export const BLOCK_ID_RE = /(?:^|\s)\^([a-zA-Z0-9-]{1,64})\s*$/;

export interface WikiLinkMatch {
  index: number;
  length: number;
  raw: string;
  target: string;
  anchor: string | null;
  alias: string | null;
}

export interface TokenMatch {
  index: number;
  length: number;
  value: string;
}

export function findWikiLinks(text: string): WikiLinkMatch[] {
  const out: WikiLinkMatch[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    const anchor = m[2] ? m[2].trim() : null;
    if (!target && !anchor) continue;
    out.push({
      index: m.index!,
      length: m[0].length,
      raw: m[0],
      target,
      anchor,
      alias: m[3] ? m[3].trim() : null,
    });
  }
  return out;
}

export function findMentions(text: string): TokenMatch[] {
  const out: TokenMatch[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const lead = m[1].length;
    out.push({ index: m.index! + lead, length: m[0].length - lead, value: m[2].toLowerCase() });
  }
  return out;
}

export function findTags(text: string): TokenMatch[] {
  const out: TokenMatch[] = [];
  for (const m of text.matchAll(TAG_RE)) {
    const value = m[2].replace(/[\/\-]+$/, '');
    // purely numeric tags (#1, #42) are usually issue numbers, not tags
    if (!value || /^\d+$/.test(value)) continue;
    const lead = m[1].length;
    out.push({ index: m.index! + lead, length: value.length + 1, value: value.toLowerCase() });
  }
  return out;
}

/** Normalises a document name for case-insensitive wiki-link resolution. */
export function normalizeName(name: string): string {
  return name.trim().replace(/\.md$/i, '').toLowerCase();
}

import GithubSlugger from 'github-slugger';
/** GitHub-compatible heading slug, used for `[[Doc#Heading]]` anchors. */
export function headingSlug(text: string): string {
  return new GithubSlugger().slug(text);
}
