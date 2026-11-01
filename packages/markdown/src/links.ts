import { parseDocument } from './parse.js';
import { normalizeName } from './syntax.js';

/**
 * Rewrite `[[oldName...]]` references to `[[newName...]]`, preserving anchors
 * and aliases. Code blocks and inline code are left untouched.
 */
export function rewriteWikiLinks(source: string, oldName: string, newName: string): string {
  const parsed = parseDocument(source);
  const want = normalizeName(oldName);
  const hits = parsed.links.filter((l) => normalizeName(l.target) === want).sort((a, b) => b.start - a.start);
  let out = source;
  for (const l of hits) {
    const anchor = l.anchor ? `#${l.anchor}` : '';
    const alias = l.alias ? `|${l.alias}` : '';
    out = out.slice(0, l.start) + `[[${newName}${anchor}${alias}]]` + out.slice(l.end);
  }
  return out;
}
