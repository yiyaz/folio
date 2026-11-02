import { Annotation, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { applyChange, type Author, type Span } from '@folio/markdown';
import { styleSpans, type AuthorMeta, type AuthorshipMode } from '../authorship';

/** Replace the attribution wholesale (document loaded, saved, or updated remotely). */
export const setAuthorship = StateEffect.define<Span[]>();
/** Mark a transaction's inserted text as written by this author (AI insertions). */
export const insertedBy = Annotation.define<Author>();

export interface AuthorshipHooks {
  /** The person typing in this editor. */
  localAuthor: () => Author | null;
  mode: () => AuthorshipMode;
  meta: () => AuthorMeta;
}

/** Keeps character attribution in step with every edit, before the server confirms it. */
export const authorshipField = StateField.define<Span[]>({
  create: () => [],
  update(spans, tr) {
    // an explicit attribution always describes the document *after* this transaction
    const set = tr.effects.find((e) => e.is(setAuthorship));
    if (set) return set.value;
    if (!tr.docChanged) return spans;
    const by = tr.annotation(insertedBy) ?? localAuthorOf(tr.state);
    if (!by) return spans;
    // apply changes from the end so earlier offsets stay valid
    const changes: { fromA: number; toA: number; len: number }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ fromA, toA, len: inserted.length }));
    for (const c of changes.reverse()) spans = applyChange(spans, c.fromA, c.toA, c.len, by);
    return spans;
  },
});

const localAuthorFacet = StateField.define<Author | null>({ create: () => null, update: (v, tr) => tr.effects.find((e) => e.is(setLocalAuthor))?.value ?? v });
export const setLocalAuthor = StateEffect.define<Author | null>();
const localAuthorOf = (state: import('@codemirror/state').EditorState) => state.field(localAuthorFacet, false) ?? null;

/** Spans of AI-written text in the current content, as claims for the next save. */
export function aiClaims(spans: Span[]): { from: number; to: number; generationId: string }[] {
  return spans.flatMap((s) => (s.author.kind === 'ai' ? [{ from: s.from, to: s.to, generationId: s.author.generationId }] : []));
}

export const refreshAuthorship = StateEffect.define<null>();

function build(view: EditorView, hooks: AuthorshipHooks): DecorationSet {
  const mode = hooks.mode();
  if (mode === 'off') return Decoration.none;
  const spans = view.state.field(authorshipField);
  const text = view.state.doc.toString();
  const marks = [];
  for (const { from, to } of view.visibleRanges) {
    for (const s of styleSpans(text, spans, mode, hooks.meta(), from, to)) {
      const a = Math.max(s.from, from);
      const b = Math.min(s.to, to);
      if (b > a)
        marks.push(Decoration.mark({ class: `cm-${s.className}`, attributes: { title: s.title, ...(s.style ? { style: s.style } : {}) } }).range(a, b));
    }
  }
  return Decoration.set(marks, true);
}

export function authorshipExtension(hooks: AuthorshipHooks): Extension {
  return [
    localAuthorFacet,
    authorshipField,
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view, hooks);
        }
        update(u: ViewUpdate) {
          const changed = u.startState.field(authorshipField) !== u.state.field(authorshipField);
          if (changed || u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshAuthorship)))) {
            this.decorations = build(u.view, hooks);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ];
}
