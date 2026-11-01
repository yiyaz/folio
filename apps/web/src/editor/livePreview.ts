import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import katex from 'katex';
import { findWikiLinks, findMentions, findTags } from '@folio/markdown';

export interface LivePreviewHooks {
  /** Returns true when a wiki-link target resolves to an existing document. */
  exists: (target: string) => boolean;
  onWikiLink: (target: string, anchor: string | null) => void;
  onMention: (username: string) => void;
  onTag: (tag: string) => void;
}

/** Effect used to force a redecoration (e.g. when the list of document names changes). */
export const refreshDecorations = StateEffect.define<null>();

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.className = 'cm-lp-image';
    img.loading = 'lazy';
    return img;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-lp-bullet';
    s.textContent = '•';
    return s;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-lp-checkbox';
    box.setAttribute('aria-label', 'toggle task');
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      // TaskMarker is "[ ]" or "[x]": toggle the middle character
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement('hr');
    hr.className = 'cm-lp-hr';
    return hr;
  }
}

class MathWidget extends WidgetType {
  constructor(readonly tex: string) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-lp-math';
    try {
      katex.render(this.tex, s, { throwOnError: false });
    } catch {
      s.textContent = this.tex;
    }
    return s;
  }
}

const hide = Decoration.replace({});
const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'HTMLBlock', 'HTMLTag', 'URL', 'Autolink', 'LinkLabel']);

function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    for (let l = a; l <= b; l++) lines.add(l);
  }
  return lines;
}

function build(view: EditorView, hooks: LivePreviewHooks): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const active = activeLines(view);
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const decos: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          const line = doc.lineAt(node.from);
          decos.push(Decoration.line({ class: `cm-lp-h cm-lp-h${heading[1]}` }).range(line.from));
          return;
        }
        switch (name) {
          case 'HeaderMark': {
            if (node.node.parent?.name.startsWith('ATXHeading') && !isActive(node.from)) {
              const end = Math.min(doc.lineAt(node.from).to, node.to + 1);
              decos.push(hide.range(node.from, end));
            }
            break;
          }
          case 'StrongEmphasis':
            decos.push(Decoration.mark({ class: 'cm-lp-strong' }).range(node.from, node.to));
            break;
          case 'Emphasis':
            decos.push(Decoration.mark({ class: 'cm-lp-em' }).range(node.from, node.to));
            break;
          case 'Strikethrough':
            decos.push(Decoration.mark({ class: 'cm-lp-strike' }).range(node.from, node.to));
            break;
          case 'InlineCode':
            decos.push(Decoration.mark({ class: 'cm-lp-code' }).range(node.from, node.to));
            break;
          case 'EmphasisMark':
          case 'StrikethroughMark':
            if (!isActive(node.from)) decos.push(hide.range(node.from, node.to));
            break;
          case 'CodeMark':
            if (node.node.parent?.name === 'InlineCode' && !isActive(node.from)) decos.push(hide.range(node.from, node.to));
            if (node.node.parent?.name === 'FencedCode') decos.push(Decoration.mark({ class: 'cm-lp-fence' }).range(node.from, node.to));
            break;
          case 'Link': {
            // [[wiki links]] look like a reference link to the parser: leave them to the wiki-link pass
            if (state.sliceDoc(node.from - 1, node.from) === '[' || state.sliceDoc(node.from, node.from + 2) === '[[') return false;
            const text = state.sliceDoc(node.from, node.to);
            const url = /\]\((\S*?)(?:\s+"[^"]*")?\)$/.exec(text)?.[1];
            decos.push(Decoration.mark({ class: 'cm-lp-link', attributes: url ? { 'data-href': url } : {} }).range(node.from, node.to));
            if (!isActive(node.from)) {
              const c = node.node.cursor();
              if (c.firstChild()) {
                do {
                  if (c.name === 'LinkMark' || c.name === 'URL' || c.name === 'LinkTitle') {
                    // hide "[" , "](" ... ")" — everything except the label text
                    if (c.name === 'LinkMark' && state.sliceDoc(c.from, c.to) === ']') {
                      decos.push(hide.range(c.from, node.to));
                      break;
                    }
                    decos.push(hide.range(c.from, c.to));
                  }
                } while (c.nextSibling());
              }
            }
            return false;
          }
          case 'Image': {
            if (!isActive(node.from)) {
              const text = state.sliceDoc(node.from, node.to);
              const m = /^!\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)$/.exec(text);
              if (m) decos.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }).range(node.from, node.to));
            }
            return false;
          }
          case 'ListMark': {
            const parent = node.node.parent?.parent;
            const hasTask = node.node.parent?.getChild('Task');
            if (!isActive(node.from)) {
              if (hasTask) decos.push(hide.range(node.from, Math.min(node.to + 1, doc.lineAt(node.from).to)));
              else if (parent?.name === 'BulletList') decos.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
            }
            break;
          }
          case 'TaskMarker': {
            const checked = /x/i.test(state.sliceDoc(node.from, node.to));
            if (!isActive(node.from)) decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to));
            if (checked) {
              const line = doc.lineAt(node.from);
              if (node.to < line.to) decos.push(Decoration.mark({ class: 'cm-lp-done' }).range(node.to, line.to));
            }
            break;
          }
          case 'Blockquote': {
            for (let p = node.from; p <= node.to; ) {
              const line = doc.lineAt(p);
              decos.push(Decoration.line({ class: 'cm-lp-quote' }).range(line.from));
              p = line.to + 1;
            }
            break;
          }
          case 'QuoteMark':
            if (!isActive(node.from)) decos.push(hide.range(node.from, Math.min(node.to + 1, doc.lineAt(node.from).to)));
            break;
          case 'FencedCode':
          case 'CodeBlock': {
            for (let p = node.from; p <= node.to; ) {
              const line = doc.lineAt(p);
              decos.push(Decoration.line({ class: 'cm-lp-codeblock' }).range(line.from));
              p = line.to + 1;
            }
            break;
          }
          case 'HorizontalRule':
            if (!isActive(node.from)) decos.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
            break;
          case 'Table': {
            for (let p = node.from; p <= node.to; ) {
              const line = doc.lineAt(p);
              decos.push(Decoration.line({ class: 'cm-lp-table' }).range(line.from));
              p = line.to + 1;
            }
            break;
          }
        }
      },
    });

    // Folio inline syntax: [[links]], @mentions, #tags, $math$
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      const text = line.text;
      if (!text || /^\s*(```|~~~)/.test(text)) continue;
      const inCode = (offset: number) => {
        let n: any = tree.resolveInner(line.from + offset, 1);
        while (n) {
          if (CODE_NODES.has(n.name)) return true;
          n = n.parent;
        }
        return false;
      };
      const lineActive = active.has(line.number);
      for (const w of findWikiLinks(text)) {
        if (inCode(w.index)) continue;
        const a = line.from + w.index;
        const b = a + w.length;
        const broken = !!w.target && !hooks.exists(w.target);
        decos.push(
          Decoration.mark({
            class: broken ? 'cm-lp-wikilink cm-lp-broken' : 'cm-lp-wikilink',
            attributes: { 'data-wikilink': w.target, 'data-anchor': w.anchor ?? '' },
          }).range(a, b),
        );
        if (!lineActive) {
          if (w.alias) {
            const aliasStart = b - 2 - w.alias.length;
            decos.push(hide.range(a, aliasStart), hide.range(b - 2, b));
          } else {
            decos.push(hide.range(a, a + 2), hide.range(b - 2, b));
          }
        }
      }
      for (const m of findMentions(text)) {
        if (inCode(m.index)) continue;
        decos.push(Decoration.mark({ class: 'cm-lp-mention', attributes: { 'data-mention': m.value } }).range(line.from + m.index, line.from + m.index + m.length));
      }
      const isHeading = /^#{1,6}\s/.test(text);
      for (const t of findTags(text)) {
        if (inCode(t.index) || (isHeading && t.index === 0)) continue;
        decos.push(Decoration.mark({ class: 'cm-lp-tag', attributes: { 'data-tag': t.value } }).range(line.from + t.index, line.from + t.index + t.length));
      }
      if (!lineActive && text.includes('$')) {
        for (const m of text.matchAll(/(?<![\\$])\$([^$\n]+?)\$(?!\$)/g)) {
          if (inCode(m.index!) || /^\s|\s$/.test(m[1])) continue;
          decos.push(Decoration.replace({ widget: new MathWidget(m[1]) }).range(line.from + m.index!, line.from + m.index! + m[0].length));
        }
      }
    }
  }
  return Decoration.set(dedupe(decos), true);
}

/** Drop replace-decorations that overlap an earlier one (CodeMirror rejects overlapping replaces). */
function dedupe(decos: Range<Decoration>[]): Range<Decoration>[] {
  decos.sort((a, b) => a.from - b.from || (a.value.startSide ?? 0) - (b.value.startSide ?? 0) || b.to - a.to);
  const out: Range<Decoration>[] = [];
  let replacedTo = -1;
  for (const d of decos) {
    const isReplace = (d.value as any).point === true;
    if (isReplace) {
      if (d.from < replacedTo) continue;
      replacedTo = Math.max(replacedTo, d.to);
    }
    out.push(d);
  }
  return out;
}

export function livePreview(hooks: LivePreviewHooks): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, hooks);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state) || u.transactions.some((t) => t.effects.some((e) => e.is(refreshDecorations)))) {
          this.decorations = build(u.view, hooks);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = (e.target as HTMLElement).closest('[data-wikilink],[data-mention],[data-tag],[data-href]') as HTMLElement | null;
      if (!el) return false;
      const pos = view.posAtDOM(el);
      const lineActive = view.hasFocus && activeLines(view).has(view.state.doc.lineAt(pos).number);
      // on the line being edited, require Ctrl/Cmd-click so normal cursor placement still works
      if (lineActive && !(e.metaKey || e.ctrlKey)) return false;
      e.preventDefault();
      if (el.dataset.wikilink !== undefined) hooks.onWikiLink(el.dataset.wikilink, el.dataset.anchor || null);
      else if (el.dataset.mention) hooks.onMention(el.dataset.mention);
      else if (el.dataset.tag) hooks.onTag(el.dataset.tag);
      else if (el.dataset.href) window.open(el.dataset.href, el.dataset.href.startsWith('/') ? '_self' : '_blank', 'noopener');
      return true;
    },
  });
  return [plugin, clicks];
}

// ---- comment highlights ----
export interface CommentRange {
  id: string;
  from: number;
  to: number;
}
export const setCommentRanges = StateEffect.define<CommentRange[]>();
export const commentHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCommentRanges)) {
        const b = new RangeSetBuilder<Decoration>();
        const len = tr.state.doc.length;
        for (const r of [...e.value].sort((x, y) => x.from - y.from)) {
          if (r.to > r.from && r.to <= len) b.add(r.from, r.to, Decoration.mark({ class: 'cm-comment-highlight', attributes: { 'data-comment': r.id } }));
        }
        value = b.finish();
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
