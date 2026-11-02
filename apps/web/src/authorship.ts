import type { Author, Authorship, Span } from '@folio/markdown';
import { authorKey } from '@folio/markdown';

export type AuthorshipMode = 'off' | 'ai' | 'all';

export interface AuthorMeta {
  people: Record<string, { id: string; username: string; displayName: string; hasAvatar: boolean }>;
  generations: Record<
    string,
    { id: string; model: string; prompt: string; context: { id: string; name: string }[]; requestedBy: string | null; createdAt: string }
  >;
}

export const emptyMeta: AuthorMeta = { people: {}, generations: {} };

/** Stable, readable hue per person (the AI always gets violet). */
export function authorHue(a: Author): number {
  if (a.kind === 'ai') return 262;
  const h = [...a.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
  // keep people away from the AI's violet so the two are never confused
  return h > 235 && h < 290 ? (h + 70) % 360 : h;
}

export function authorLabel(a: Author, meta: AuthorMeta): string {
  if (a.kind === 'ai') {
    const g = meta.generations[a.generationId];
    const who = meta.people[a.requestedBy]?.displayName;
    const when = g ? new Date(g.createdAt).toLocaleDateString() : '';
    return `Written by AI (${g?.model ?? a.model})${who ? ` for ${who}` : ''}${when ? ` · ${when}` : ''}`;
  }
  if (a.id === 'human') return 'Written by a person';
  return `Written by ${meta.people[a.id]?.displayName ?? 'a coworker'}`;
}

export interface StyledSpan {
  from: number;
  to: number;
  className: string;
  style?: string;
  title: string;
}

/**
 * Decide how each attributed range should look.
 *   ai  – AI-written text is tinted; a person's edits inside an AI-written sentence are
 *         underlined in that person's colour, so even a one-word change is visible.
 *   all – additionally, every person's text carries a faint underline in their colour.
 */
export function styleSpans(text: string, spans: Span[], mode: AuthorshipMode, meta: AuthorMeta, from = 0, to = text.length): StyledSpan[] {
  if (mode === 'off' || !spans.length) return [];
  const visible = spans.filter((s) => s.to > from && s.from < to);
  if (!visible.length) return [];
  const aiSentences = mode === 'ai' || mode === 'all' ? sentencesWithAi(text, spans, from, to) : [];
  const out: StyledSpan[] = [];
  for (const s of visible) {
    const title = authorLabel(s.author, meta);
    const color = `--auth-hue: ${authorHue(s.author)}`;
    if (s.author.kind === 'ai') {
      out.push({ from: s.from, to: s.to, className: 'auth-ai', title });
      continue;
    }
    // human text: the parts inside AI-written sentences are edits of AI text; in "everyone" mode
    // the rest is shown as that person's own writing
    const pieces = split(aiSentences, s.from, s.to).filter((p) => mode === 'all' || p.edited);
    for (const p of pieces) {
      if (!text.slice(p.from, p.to).trim()) continue;
      out.push({
        from: p.from,
        to: p.to,
        className: p.edited ? 'auth-edited' : 'auth-person',
        style: color,
        title: p.edited ? `${title} (edited AI text)` : title,
      });
    }
  }
  return out;
}

/** Cut [a, b) at the boundaries of `ranges`, flagging the pieces that fall inside one. */
function split(ranges: { from: number; to: number }[], a: number, b: number): { from: number; to: number; edited: boolean }[] {
  const out: { from: number; to: number; edited: boolean }[] = [];
  let pos = a;
  for (const r of clip(ranges, a, b).sort((x, y) => x.from - y.from)) {
    if (r.from > pos) out.push({ from: pos, to: r.from, edited: false });
    out.push({ from: r.from, to: r.to, edited: true });
    pos = r.to;
  }
  if (pos < b) out.push({ from: pos, to: b, edited: false });
  return out;
}

function overlaps(ranges: { from: number; to: number }[], a: number, b: number) {
  return ranges.some((r) => r.from < b && r.to > a);
}

function clip(ranges: { from: number; to: number }[], a: number, b: number) {
  return ranges.filter((r) => r.from < b && r.to > a).map((r) => ({ from: Math.max(a, r.from), to: Math.min(b, r.to) }));
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;

/** Sentences (within [from, to)) that contain at least some AI-written text. */
export function sentencesWithAi(text: string, spans: Span[], from = 0, to = text.length): { from: number; to: number }[] {
  const ai = spans.filter((s) => s.author.kind === 'ai' && s.to > from && s.from < to);
  if (!ai.length) return [];
  // widen to whole lines so sentences aren't cut at the window edge
  const start = Math.max(0, text.lastIndexOf('\n', from) + 1);
  const endNl = text.indexOf('\n', to);
  const end = endNl === -1 ? text.length : endNl;
  const chunk = text.slice(start, end);
  const out: { from: number; to: number }[] = [];
  const pieces = segmenter ? [...segmenter.segment(chunk)].map((s) => ({ index: s.index, len: s.segment.length })) : splitSentences(chunk);
  for (const p of pieces) {
    // a sentence never spans paragraphs or list items: split on line breaks too
    let lineStart = p.index;
    for (const line of chunk.slice(p.index, p.index + p.len).split('\n')) {
      const a = start + lineStart;
      const b = a + line.length;
      if (line.trim() && overlaps(ai, a, b)) out.push({ from: a, to: b });
      lineStart += line.length + 1;
    }
  }
  return out;
}

function splitSentences(s: string) {
  const out: { index: number; len: number }[] = [];
  const re = /[^.!?\n]*(?:[.!?]+\s*|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && m[0]) out.push({ index: m.index, len: m[0].length });
  return out;
}

/** Shares for the legend / panel, from client-side spans. */
export function shares(spans: Span[]) {
  const total = spans.reduce((n, s) => n + s.to - s.from, 0) || 1;
  const m = new Map<string, { author: Author; chars: number }>();
  for (const s of spans) {
    const k = authorKey(s.author);
    const e = m.get(k) ?? { author: s.author, chars: 0 };
    e.chars += s.to - s.from;
    m.set(k, e);
  }
  return [...m.values()].map((e) => ({ ...e, share: e.chars / total })).sort((a, b) => b.chars - a.chars);
}

/**
 * Apply attribution to a rendered page: elements tagged with data-s/data-e (source offsets)
 * are split or styled according to who wrote that part of the source.
 */
export function highlightRendered(root: HTMLElement, source: string, spans: Span[], mode: AuthorshipMode, meta: AuthorMeta) {
  if (mode === 'off' || !spans.length) return;
  const styled = styleSpans(source, spans, mode, meta);
  if (!styled.length) return;
  const apply = (el: HTMLElement, s: StyledSpan) => {
    el.classList.add(s.className);
    if (s.style) el.setAttribute('style', s.style);
    el.title = s.title;
  };
  root.querySelectorAll<HTMLElement>('[data-s][data-e]').forEach((el) => {
    const a = Number(el.dataset.s);
    const b = Number(el.dataset.e);
    const hits = styled.filter((s) => s.from < b && s.to > a);
    if (!hits.length) return;
    const text = el.textContent ?? '';
    const plainText = el.tagName === 'SPAN' && el.childNodes.length === 1 && el.firstChild?.nodeType === Node.TEXT_NODE;
    if (!plainText) {
      // structured content (code blocks, diagrams): style by the majority author
      const best = hits.map((h) => ({ h, n: Math.min(b, h.to) - Math.max(a, h.from) })).sort((x, y) => y.n - x.n)[0];
      if (best.n * 2 >= b - a) apply(el, best.h);
      return;
    }
    // map each rendered character to its source offset (rendering may drop indentation,
    // escapes or decode entities), then split the text wherever the author changes
    const offsets = alignToSource(text, source.slice(a, b), a);
    const styleAt = (off: number) => hits.find((h) => off >= h.from && off < h.to) ?? null;
    const frag = document.createDocumentFragment();
    let i = 0;
    while (i < text.length) {
      const st = styleAt(offsets[i]);
      let j = i + 1;
      while (j < text.length && styleAt(offsets[j]) === st) j++;
      const piece = text.slice(i, j);
      if (st) {
        const span = document.createElement('span');
        span.textContent = piece;
        apply(span, st);
        frag.append(span);
      } else frag.append(piece);
      i = j;
    }
    el.replaceChildren(frag);
  });
}

/**
 * Source offset for every character of rendered text. Walks both strings forward, skipping
 * source characters that didn't make it into the output (indentation, backslash escapes,
 * entity spellings). Unmatched characters inherit the previous offset.
 */
export function alignToSource(rendered: string, source: string, base: number): number[] {
  const out = new Array<number>(rendered.length);
  let s = 0;
  for (let i = 0; i < rendered.length; i++) {
    const ch = rendered[i];
    let k = s;
    // look ahead a little for the same character (whitespace matches any whitespace)
    while (k < source.length && k - s < 12 && !(source[k] === ch || (/\s/.test(ch) && /\s/.test(source[k])))) k++;
    if (k < source.length && k - s < 12) {
      out[i] = base + k;
      s = k + 1;
    } else out[i] = base + Math.max(0, s - 1);
  }
  return out;
}

export type { Author, Authorship, Span };
