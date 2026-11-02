import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder, drawSelection, highlightActiveLine, dropCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { livePreview, refreshDecorations, commentHighlights, setCommentRanges, type LivePreviewHooks, type CommentRange } from './livePreview';
import { folioCompletions, type CompletionData } from './completions';
import { formattingKeymap } from './commands';
import { aiClaims, authorshipExtension, authorshipField, insertedBy, refreshAuthorship, setAuthorship, setLocalAuthor } from './authorship';
import { emptyMeta, type AuthorMeta, type AuthorshipMode } from '../authorship';
import type { Author, Span } from '@folio/markdown';
import { Frontmatter } from './frontmatter';

export interface EditorHandle {
  view: EditorView | null;
  /** Replace the content; pass its attribution when it comes from the server. */
  setContent: (text: string, spans?: Span[]) => void;
  setAuthorship: (spans: Span[]) => void;
  /** AI-written ranges of the current content, to send with a save. */
  aiClaims: () => { from: number; to: number; generationId: string }[];
  /** Insert AI-generated Markdown at the cursor, attributed to that generation. */
  insertAi: (text: string, author: Author) => void;
  getContent: () => string;
  refresh: () => void;
  setComments: (ranges: CommentRange[]) => void;
  focus: () => void;
  scrollToLine: (line: number) => void;
}

export interface EditorProps {
  initialValue: string;
  mode: 'live' | 'source';
  readOnly: boolean;
  keymapMode: 'default' | 'vim' | 'emacs';
  showLineNumbers: boolean;
  hooks: LivePreviewHooks;
  completionData: CompletionData;
  onChange: (text: string) => void;
  onSelection?: (sel: { from: number; to: number; text: string } | null) => void;
  onUpload?: (file: File) => Promise<string>;
  onScroll?: (ratio: number) => void;
  initialAuthorship?: Span[];
  localAuthor?: Author | null;
  authorshipMode?: AuthorshipMode;
  authorMeta?: AuthorMeta;
  onAuthorshipChange?: (spans: Span[]) => void;
}

const markdownHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, fontFamily: 'var(--mono)' },
  { tag: t.processingInstruction, color: 'var(--muted)' },
  { tag: t.quote, color: 'var(--muted)' },
]);

async function keymapExtension(mode: EditorProps['keymapMode']): Promise<Extension> {
  if (mode === 'vim') return (await import('@replit/codemirror-vim')).vim();
  if (mode === 'emacs') return (await import('@replit/codemirror-emacs')).emacs();
  return [];
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const comps = useRef({ live: new Compartment(), ro: new Compartment(), keys: new Compartment(), lines: new Compartment() });
  const applyingExternal = useRef(false);

  useEffect(() => {
    const hooks: LivePreviewHooks = {
      exists: (x) => propsRef.current.hooks.exists(x),
      onWikiLink: (a, b) => propsRef.current.hooks.onWikiLink(a, b),
      onMention: (u) => propsRef.current.hooks.onMention(u),
      onTag: (x) => propsRef.current.hooks.onTag(x),
    };
    const c = comps.current;
    const state = EditorState.create({
      doc: props.initialValue,
      extensions: [
        c.keys.of([]),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true, extensions: [Frontmatter] }),
        syntaxHighlighting(markdownHighlight),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        autocompletion({
          override: [folioCompletions({ docNames: () => propsRef.current.completionData.docNames(), tags: () => propsRef.current.completionData.tags() })],
          activateOnTyping: true,
        }),
        keymap.of([
          ...formattingKeymap,
          ...closeBracketsKeymap,
          ...markdownKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        placeholder('Start writing… type / for commands, [[ to link, @ to mention'),
        c.live.of(props.mode === 'live' ? livePreview(hooks) : []),
        c.ro.of([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]),
        c.lines.of(props.showLineNumbers ? lineNumbers() : []),
        commentHighlights,
        authorshipExtension({
          localAuthor: () => propsRef.current.localAuthor ?? null,
          mode: () => propsRef.current.authorshipMode ?? 'off',
          meta: () => propsRef.current.authorMeta ?? emptyMeta,
        }),
        EditorView.updateListener.of((u) => {
          if (u.startState.field(authorshipField) !== u.state.field(authorshipField)) propsRef.current.onAuthorshipChange?.(u.state.field(authorshipField));
          if (u.docChanged && !applyingExternal.current) propsRef.current.onChange(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) {
            const r = u.state.selection.main;
            propsRef.current.onSelection?.(r.empty ? null : { from: r.from, to: r.to, text: u.state.sliceDoc(r.from, r.to) });
          }
        }),
        EditorView.domEventHandlers({
          paste(e, view) {
            const files = [...(e.clipboardData?.files ?? [])];
            if (!files.length || !propsRef.current.onUpload || view.state.readOnly) return false;
            e.preventDefault();
            void uploadAll(view, files);
            return true;
          },
          drop(e, view) {
            const files = [...(e.dataTransfer?.files ?? [])];
            if (!files.length || !propsRef.current.onUpload || view.state.readOnly) return false;
            e.preventDefault();
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos != null) view.dispatch({ selection: { anchor: pos } });
            void uploadAll(view, files);
            return true;
          },
          scroll(_e, view) {
            const el = view.scrollDOM;
            propsRef.current.onScroll?.(el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight));
            return false;
          },
        }),
      ],
    });
    async function uploadAll(view: EditorView, files: File[]) {
      for (const f of files) {
        const placeholderText = `![Uploading ${f.name}…]()`;
        const at = view.state.selection.main.head;
        view.dispatch({ changes: { from: at, insert: placeholderText } });
        try {
          const md = await propsRef.current.onUpload!(f);
          const idx = view.state.doc.toString().indexOf(placeholderText);
          if (idx >= 0) view.dispatch({ changes: { from: idx, to: idx + placeholderText.length, insert: md } });
        } catch (err) {
          const idx = view.state.doc.toString().indexOf(placeholderText);
          if (idx >= 0) view.dispatch({ changes: { from: idx, to: idx + placeholderText.length, insert: '' } });
          alert(`Upload failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    const view = new EditorView({ state, parent: host.current! });
    viewRef.current = view;
    view.dispatch({ effects: [setLocalAuthor.of(props.localAuthor ?? null), setAuthorship.of(props.initialAuthorship ?? [])] });
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const hooks: LivePreviewHooks = {
      exists: (x) => propsRef.current.hooks.exists(x),
      onWikiLink: (a, b) => propsRef.current.hooks.onWikiLink(a, b),
      onMention: (u) => propsRef.current.hooks.onMention(u),
      onTag: (x) => propsRef.current.hooks.onTag(x),
    };
    v.dispatch({ effects: comps.current.live.reconfigure(props.mode === 'live' ? livePreview(hooks) : []) });
  }, [props.mode]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: comps.current.ro.reconfigure([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]) });
  }, [props.readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: comps.current.lines.reconfigure(props.showLineNumbers ? lineNumbers() : []) });
  }, [props.showLineNumbers]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshAuthorship.of(null) });
  }, [props.authorshipMode, props.authorMeta]);

  useEffect(() => {
    let cancelled = false;
    void keymapExtension(props.keymapMode).then((ext) => {
      if (!cancelled) viewRef.current?.dispatch({ effects: comps.current.keys.reconfigure(ext) });
    });
    return () => {
      cancelled = true;
    };
  }, [props.keymapMode]);

  useImperativeHandle(ref, () => ({
    get view() {
      return viewRef.current;
    },
    setContent(text: string, spans?: Span[]) {
      const v = viewRef.current;
      if (!v) return;
      const effects = spans ? [setAuthorship.of(spans)] : [];
      if (v.state.doc.toString() === text) {
        if (spans) v.dispatch({ effects });
        return;
      }
      applyingExternal.current = true;
      const head = Math.min(v.state.selection.main.head, text.length);
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: head }, effects });
      applyingExternal.current = false;
    },
    setAuthorship: (spans) => viewRef.current?.dispatch({ effects: setAuthorship.of(spans) }),
    aiClaims: () => (viewRef.current ? aiClaims(viewRef.current.state.field(authorshipField)) : []),
    insertAi(text: string, author: Author) {
      const v = viewRef.current;
      if (!v) return;
      const { state } = v;
      const line = state.doc.lineAt(state.selection.main.head);
      const atEmpty = line.text.trim() === '';
      const at = atEmpty ? line.from : line.to;
      const before = atEmpty ? '' : '\n\n';
      const body = text.replace(/\s+$/, '');
      // only the generated text is AI-written; the separating newlines are not attributed to it
      v.dispatch({ changes: { from: at, to: atEmpty ? line.to : at, insert: before }, scrollIntoView: true });
      v.dispatch({
        changes: { from: at + before.length, insert: body },
        selection: { anchor: at + before.length + body.length },
        annotations: insertedBy.of(author),
        scrollIntoView: true,
      });
      v.focus();
    },
    getContent: () => viewRef.current?.state.doc.toString() ?? '',
    refresh: () => viewRef.current?.dispatch({ effects: refreshDecorations.of(null) }),
    setComments: (ranges) => viewRef.current?.dispatch({ effects: setCommentRanges.of(ranges) }),
    focus: () => viewRef.current?.focus(),
    scrollToLine(line: number) {
      const v = viewRef.current;
      if (!v) return;
      const l = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
      v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: 40 }) });
      v.focus();
    },
  }));

  return <div className="editor-host" ref={host} data-testid="editor" />;
});
