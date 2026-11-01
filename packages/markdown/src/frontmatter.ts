import YAML from 'yaml';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface SplitFrontmatter {
  data: Record<string, unknown>;
  raw: string | null;
  body: string;
  /** Character offset at which the body starts in the original source. */
  bodyOffset: number;
}

export function splitFrontmatter(source: string): SplitFrontmatter {
  const m = FM_RE.exec(source);
  if (!m) return { data: {}, raw: null, body: source, bodyOffset: 0 };
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(m[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // invalid YAML: treat as empty front matter but keep the source untouched
  }
  return { data, raw: m[1], body: source.slice(m[0].length), bodyOffset: m[0].length };
}

/**
 * Set (or with `undefined`, remove) a front-matter field while preserving the
 * rest of the document byte-for-byte. Comments and ordering in YAML are kept.
 */
export function setFrontmatterField(source: string, key: string, value: unknown): string {
  const m = FM_RE.exec(source);
  if (!m) {
    if (value === undefined) return source;
    const doc = new YAML.Document({ [key]: value });
    return `---\n${doc.toString().trimEnd()}\n---\n\n${source.replace(/^\n+/, '')}`;
  }
  let doc: YAML.Document;
  try {
    doc = YAML.parseDocument(m[1]);
    if (doc.errors.length) throw new Error('bad yaml');
  } catch {
    return source;
  }
  if (value === undefined) doc.delete(key);
  else doc.set(key, value);
  const yaml = doc.toString().trimEnd();
  const rest = source.slice(m[0].length);
  if (!yaml || yaml === '{}') return rest.replace(/^\n+/, '');
  return `---\n${yaml}\n---\n${rest}`;
}
