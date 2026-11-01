import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** Wrap / unwrap the selection (or word at cursor) with an inline marker such as ** or `. */
export function toggleWrap(view: EditorView, marker: string, closing = marker): boolean {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    let { from, to } = range;
    if (from === to) {
      const word = state.wordAt(from);
      if (word) ({ from, to } = word);
    }
    const before = state.sliceDoc(from - marker.length, from);
    const after = state.sliceDoc(to, to + closing.length);
    if (before === marker && after === closing) {
      return {
        changes: [
          { from: from - marker.length, to: from },
          { from: to, to: to + closing.length },
        ],
        range: EditorSelection.range(from - marker.length, to - marker.length),
      };
    }
    const inner = state.sliceDoc(from, to);
    if (inner.startsWith(marker) && inner.endsWith(closing) && inner.length >= marker.length + closing.length) {
      return {
        changes: { from, to, insert: inner.slice(marker.length, inner.length - closing.length) },
        range: EditorSelection.range(from, to - marker.length - closing.length),
      };
    }
    return {
      changes: [
        { from, insert: marker },
        { from: to, insert: closing },
      ],
      range: from === to ? EditorSelection.cursor(from + marker.length) : EditorSelection.range(from + marker.length, to + marker.length),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
  view.focus();
  return true;
}

function eachSelectedLine(view: EditorView, fn: (text: string, from: number) => ChangeSpec | null) {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to;) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        const c = fn(line.text, line.from);
        if (c) changes.push(c);
      }
      pos = line.to + 1;
    }
  }
  view.dispatch({ changes, userEvent: 'input.format' });
  view.focus();
}

export function setHeading(view: EditorView, level: number): boolean {
  eachSelectedLine(view, (text, from) => {
    const m = /^(#{1,6})\s+/.exec(text);
    const current = m ? m[1].length : 0;
    const prefix = level === 0 || current === level ? '' : '#'.repeat(level) + ' ';
    return { from, to: from + (m ? m[0].length : 0), insert: prefix };
  });
  return true;
}

const LINE_PREFIX_RE = /^(\s*)([-*+]\s\[[ xX]\]\s|[-*+]\s|\d+[.)]\s|>\s?)?/;

export function toggleLinePrefix(view: EditorView, prefix: '- ' | '1. ' | '- [ ] ' | '> '): boolean {
  let n = 0;
  eachSelectedLine(view, (text, from) => {
    const m = LINE_PREFIX_RE.exec(text)!;
    const existing = m[2] ?? '';
    const norm = existing
      .replace(/\d+/, '1')
      .replace(/\[[xX]\]/, '[ ]')
      .replace(/^[*+]/, '-')
      .replace(/^>$/, '> ');
    const start = from + m[1].length;
    if (norm === prefix) return { from: start, to: start + existing.length, insert: '' };
    n++;
    const insert = prefix === '1. ' ? `${n}. ` : prefix;
    return { from: start, to: start + existing.length, insert };
  });
  return true;
}

export function insertText(view: EditorView, text: string, cursorOffset?: number): boolean {
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + (cursorOffset ?? text.length) }, userEvent: 'input' });
  view.focus();
  return true;
}

/** Insert a block on its own line(s), adding blank lines around it as needed. */
export function insertBlock(view: EditorView, block: string, cursorOffset?: number): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const line = state.doc.lineAt(from);
  const atEmptyLine = line.text.trim() === '';
  const before = atEmptyLine ? (line.number > 1 && state.doc.line(line.number - 1).text.trim() ? '\n' : '') : '\n\n';
  const insertAt = atEmptyLine ? line.from : state.doc.lineAt(to).to;
  const text = `${before}${block}\n`;
  view.dispatch({
    changes: { from: insertAt, to: atEmptyLine ? line.to : insertAt, insert: text },
    selection: { anchor: insertAt + before.length + (cursorOffset ?? block.length) },
    userEvent: 'input',
  });
  view.focus();
  return true;
}

export function insertLink(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to);
  if (/^https?:\/\//.test(sel)) return insertText(view, `[](${sel})`, 1);
  const text = `[${sel || 'link text'}](https://)`;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: sel ? { anchor: from + sel.length + 3, head: from + sel.length + 11 } : { anchor: from + 1, head: from + 10 },
  });
  view.focus();
  return true;
}

export const TABLE_SNIPPET = '| Column A | Column B |\n| --- | --- |\n| | |';

export function insertCodeBlock(view: EditorView, lang = ''): boolean {
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to);
  const block = '```' + lang + '\n' + sel + '\n```';
  return insertBlock(view, block, 3 + lang.length + 1 + sel.length);
}

export const formattingKeymap = [
  { key: 'Mod-b', run: (v: EditorView) => toggleWrap(v, '**') },
  { key: 'Mod-i', run: (v: EditorView) => toggleWrap(v, '*') },
  { key: 'Mod-e', run: (v: EditorView) => toggleWrap(v, '`') },
  { key: 'Mod-Shift-x', run: (v: EditorView) => toggleWrap(v, '~~') },
  { key: 'Mod-k', run: insertLink },
  { key: 'Mod-Alt-1', run: (v: EditorView) => setHeading(v, 1) },
  { key: 'Mod-Alt-2', run: (v: EditorView) => setHeading(v, 2) },
  { key: 'Mod-Alt-3', run: (v: EditorView) => setHeading(v, 3) },
  { key: 'Mod-Shift-8', run: (v: EditorView) => toggleLinePrefix(v, '- ') },
  { key: 'Mod-Shift-7', run: (v: EditorView) => toggleLinePrefix(v, '1. ') },
  { key: 'Mod-Shift-9', run: (v: EditorView) => toggleLinePrefix(v, '- [ ] ') },
];
