import { diffChars } from 'diff';

/**
 * Who wrote which characters of a document.
 *
 * Stored compactly as runs of `[length, authorIndex]` over the document text (UTF-16 code units,
 * the same unit JavaScript strings and CodeMirror use), plus the list of distinct authors.
 * The server is the authority: it derives attribution by diffing each saved version against
 * the previous one (see `attributeEdit`), so clients cannot rewrite who wrote existing text.
 */
export type Author = { kind: 'user'; id: string } | { kind: 'ai'; generationId: string; model: string; requestedBy: string };

export interface Authorship {
  v: 1;
  authors: Author[];
  runs: [number, number][];
}

export interface Span {
  from: number;
  to: number;
  author: Author;
}

export const authorKey = (a: Author) => (a.kind === 'user' ? `u:${a.id}` : `ai:${a.generationId}`);
export const sameAuthor = (a: Author, b: Author) => authorKey(a) === authorKey(b);

export function emptyAuthorship(): Authorship {
  return { v: 1, authors: [], runs: [] };
}

export function uniform(length: number, author: Author): Authorship {
  return length > 0 ? { v: 1, authors: [author], runs: [[length, 0]] } : emptyAuthorship();
}

export function authorshipLength(a: Authorship): number {
  return a.runs.reduce((n, [len]) => n + len, 0);
}

export function toSpans(a: Authorship): Span[] {
  const out: Span[] = [];
  let pos = 0;
  for (const [len, idx] of a.runs) {
    const author = a.authors[idx];
    if (len > 0 && author) out.push({ from: pos, to: pos + len, author });
    pos += len;
  }
  return out;
}

/** Build a normalized authorship from contiguous spans (adjacent equal authors merged). */
export function fromSpans(spans: Span[]): Authorship {
  const authors: Author[] = [];
  const index = new Map<string, number>();
  const runs: [number, number][] = [];
  for (const s of spans) {
    const len = s.to - s.from;
    if (len <= 0) continue;
    const key = authorKey(s.author);
    let idx = index.get(key);
    if (idx === undefined) {
      idx = authors.push(s.author) - 1;
      index.set(key, idx);
    }
    const last = runs[runs.length - 1];
    if (last && last[1] === idx) last[0] += len;
    else runs.push([len, idx]);
  }
  return { v: 1, authors, runs };
}

/** The spans covering [from, to), clipped to that range. */
export function sliceSpans(spans: Span[], from: number, to: number): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    if (s.to <= from) continue;
    if (s.from >= to) break;
    out.push({ from: Math.max(s.from, from), to: Math.min(s.to, to), author: s.author });
  }
  return out;
}

/**
 * Replace [from, to) with `insertLength` characters written by `author` (a single edit).
 * Used by the editor to keep attribution in step with local typing.
 */
export function applyChange(spans: Span[], from: number, to: number, insertLength: number, author: Author): Span[] {
  const delta = insertLength - (to - from);
  const out: Span[] = [];
  for (const s of spans) {
    if (s.to <= from) out.push(s);
    else if (s.from >= to) out.push({ from: s.from + delta, to: s.to + delta, author: s.author });
    else {
      if (s.from < from) out.push({ from: s.from, to: from, author: s.author });
      if (s.to > to) out.push({ from: to + delta, to: s.to + delta, author: s.author });
    }
  }
  if (insertLength > 0) out.push({ from, to: from + insertLength, author });
  return out.sort((a, b) => a.from - b.from);
}

/** Make an authorship cover exactly `length` characters (repairs corrupt or legacy data). */
export function fitTo(a: Authorship, length: number, filler: Author): Span[] {
  const spans = sliceSpans(toSpans(a), 0, length);
  const covered = spans.length ? spans[spans.length - 1].to : 0;
  if (covered < length) spans.push({ from: covered, to: length, author: filler });
  return spans;
}

const MAX_DIFF_EDIT = 20_000;

/**
 * Attribute a new version of a text. Characters that survive from the old version keep their
 * author; inserted characters belong to `editor`, except where a (verified) claim says an AI
 * generation produced them. Deleted text simply disappears.
 *
 * Common prefix and suffix are skipped before diffing, so typical edits cost O(n).
 */
export function attributeEdit(old: Authorship, oldText: string, newText: string, editor: Author, claims: Span[] = []): Authorship {
  const oldSpans = fitTo(old, oldText.length, editor);
  let p = 0;
  const max = Math.min(oldText.length, newText.length);
  while (p < max && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)) s++;

  const oldMid = oldText.slice(p, oldText.length - s);
  const newMid = newText.slice(p, newText.length - s);
  type Op = { kind: 'equal' | 'insert' | 'delete'; len: number };
  let ops: Op[] = [];
  if (oldMid && newMid) {
    // bounded: a wholesale rewrite falls back to delete-all + insert-all instead of a slow diff
    const parts = diffChars(oldMid, newMid, { maxEditLength: MAX_DIFF_EDIT, timeout: 500 });
    ops = parts
      ? parts.map((c) => ({ kind: c.added ? 'insert' : c.removed ? 'delete' : 'equal', len: c.value.length }))
      : [
          { kind: 'delete', len: oldMid.length },
          { kind: 'insert', len: newMid.length },
        ];
  } else if (oldMid) ops = [{ kind: 'delete', len: oldMid.length }];
  else if (newMid) ops = [{ kind: 'insert', len: newMid.length }];

  const out: Span[] = sliceSpans(oldSpans, 0, p);
  let oldPos = p;
  let newPos = p;
  for (const op of ops) {
    if (op.kind === 'equal') {
      for (const sp of sliceSpans(oldSpans, oldPos, oldPos + op.len))
        out.push({ from: sp.from - oldPos + newPos, to: sp.to - oldPos + newPos, author: sp.author });
      oldPos += op.len;
      newPos += op.len;
    } else if (op.kind === 'delete') {
      oldPos += op.len;
    } else {
      out.push(...attributeInsert(newPos, newPos + op.len, editor, claims));
      newPos += op.len;
    }
  }
  for (const sp of sliceSpans(oldSpans, oldText.length - s, oldText.length)) {
    const shift = newText.length - oldText.length;
    out.push({ from: sp.from + shift, to: sp.to + shift, author: sp.author });
  }
  return fromSpans(out);
}

/** Inserted text: claimed parts go to the claiming author (AI), the rest to the editor. */
function attributeInsert(from: number, to: number, editor: Author, claims: Span[]): Span[] {
  const out: Span[] = [];
  let pos = from;
  for (const c of [...claims].sort((a, b) => a.from - b.from)) {
    const a = Math.max(c.from, pos);
    const b = Math.min(c.to, to);
    if (b <= a) continue;
    if (a > pos) out.push({ from: pos, to: a, author: editor });
    out.push({ from: a, to: b, author: c.author });
    pos = b;
  }
  if (pos < to) out.push({ from: pos, to, author: editor });
  return out;
}

/** Characters per author, largest first. */
export function authorStats(a: Authorship): { author: Author; chars: number; share: number }[] {
  const total = authorshipLength(a) || 1;
  const counts = new Map<string, { author: Author; chars: number }>();
  for (const s of toSpans(a)) {
    const k = authorKey(s.author);
    const e = counts.get(k) ?? { author: s.author, chars: 0 };
    e.chars += s.to - s.from;
    counts.set(k, e);
  }
  return [...counts.values()].map((e) => ({ ...e, share: e.chars / total })).sort((x, y) => y.chars - x.chars);
}

/** Keep AI attribution but hide which humans wrote what (for public pages). */
export function anonymizeHumans(a: Authorship): Authorship {
  return fromSpans(toSpans(a).map((s) => (s.author.kind === 'user' ? { ...s, author: { kind: 'user', id: 'human' } } : s)));
}

/** Runtime validation for authorship coming from the database or a client. */
export function isAuthorship(x: unknown): x is Authorship {
  if (!x || typeof x !== 'object') return false;
  const a = x as Authorship;
  return (
    a.v === 1 &&
    Array.isArray(a.authors) &&
    Array.isArray(a.runs) &&
    a.runs.every((r) => Array.isArray(r) && Number.isInteger(r[0]) && r[0] >= 0 && Number.isInteger(r[1]) && r[1] >= 0 && r[1] < a.authors.length)
  );
}
