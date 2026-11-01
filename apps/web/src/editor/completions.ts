import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { get } from '../api';
import { insertBlock, TABLE_SNIPPET } from './commands';

export interface CompletionData {
  docNames: () => { name: string; title: string }[];
  tags: () => string[];
}

interface SlashCommand {
  label: string;
  detail: string;
  apply: (view: EditorView, from: number, to: number) => void;
}

function replaceWithBlock(block: string, cursor?: number) {
  return (view: EditorView, from: number, to: number) => {
    view.dispatch({ changes: { from, to, insert: '' } });
    insertBlock(view, block, cursor);
  };
}
function replaceWithLinePrefix(prefix: string) {
  return (view: EditorView, from: number, to: number) => {
    const line = view.state.doc.lineAt(from);
    view.dispatch({ changes: { from: line.from, to, insert: prefix }, selection: { anchor: line.from + prefix.length } });
  };
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { label: 'h1', detail: 'Heading 1', apply: replaceWithLinePrefix('# ') },
  { label: 'h2', detail: 'Heading 2', apply: replaceWithLinePrefix('## ') },
  { label: 'h3', detail: 'Heading 3', apply: replaceWithLinePrefix('### ') },
  { label: 'bullet', detail: 'Bulleted list', apply: replaceWithLinePrefix('- ') },
  { label: 'numbered', detail: 'Numbered list', apply: replaceWithLinePrefix('1. ') },
  { label: 'todo', detail: 'Task list item', apply: replaceWithLinePrefix('- [ ] ') },
  { label: 'quote', detail: 'Blockquote', apply: replaceWithLinePrefix('> ') },
  { label: 'table', detail: 'Table', apply: replaceWithBlock(TABLE_SNIPPET, 2) },
  { label: 'code', detail: 'Code block', apply: replaceWithBlock('```\n\n```', 4) },
  { label: 'math', detail: 'Math block (KaTeX)', apply: replaceWithBlock('$$\n\n$$', 3) },
  { label: 'mermaid', detail: 'Mermaid diagram', apply: replaceWithBlock('```mermaid\nflowchart LR\n  A --> B\n```', 11) },
  { label: 'graphviz', detail: 'Graphviz (dot) diagram', apply: replaceWithBlock('```dot\ndigraph { A -> B }\n```', 7) },
  { label: 'plantuml', detail: 'PlantUML diagram', apply: replaceWithBlock('```plantuml\nAlice -> Bob: hello\n```', 12) },
  { label: 'chart', detail: 'Vega-Lite chart', apply: replaceWithBlock('```vega-lite\n{\n  "data": {"values": [{"x": "a", "y": 1}, {"x": "b", "y": 3}]},\n  "mark": "bar",\n  "encoding": {"x": {"field": "x", "type": "nominal"}, "y": {"field": "y", "type": "quantitative"}}\n}\n```', 13) },
  { label: 'csv', detail: 'Sortable CSV table', apply: replaceWithBlock('```csv\nname,value\nalpha,1\nbeta,2\n```', 7) },
  { label: 'python', detail: 'Runnable Python (Pyodide)', apply: replaceWithBlock('```python run\nprint("hello from Python")\n```', 14) },
  { label: 'notebook', detail: 'Embed Jupyter notebook attachment', apply: replaceWithBlock('```notebook\nsrc: /api/attachments/<id>\ncells: 1-3\n```', 17) },
  { label: 'dataset', detail: 'Preview CSV/Parquet attachment', apply: replaceWithBlock('```dataset\nsrc: /api/attachments/<id>\nlimit: 100\n```', 16) },
  { label: 'divider', detail: 'Horizontal rule', apply: replaceWithBlock('---') },
  { label: 'callout', detail: 'Callout / note', apply: replaceWithLinePrefix('> **Note:** ') },
  { label: 'date', detail: "Today's date", apply: (v, f, t) => v.dispatch({ changes: { from: f, to: t, insert: new Date().toISOString().slice(0, 10) } }) },
];

export function folioCompletions(data: CompletionData) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    // [[wiki links
    const wl = ctx.matchBefore(/\[\[[^\]\[\n|#]*$/);
    if (wl) {
      const q = wl.text.slice(2).toLowerCase();
      const options: Completion[] = data
        .docNames()
        .filter((d) => !q || d.name.toLowerCase().includes(q) || d.title.toLowerCase().includes(q))
        .slice(0, 50)
        .map((d) => ({
          label: d.name,
          detail: d.title !== d.name ? d.title : undefined,
          type: 'text',
          // replace the typed text plus any auto-closed "]]" and put the cursor after the link
          apply: (view: EditorView, _c: Completion, from: number, to: number) => {
            const closing = view.state.sliceDoc(to, to + 2) === ']]' ? 2 : 0;
            const insert = `${d.name}]]`;
            view.dispatch({ changes: { from, to: to + closing, insert }, selection: { anchor: from + insert.length } });
          },
        }));
      return { from: wl.from + 2, options, filter: false };
    }
    // @mentions
    const mention = ctx.matchBefore(/(?:^|[\s(])@[\w.-]*$/);
    if (mention) {
      const at = mention.text.lastIndexOf('@');
      const q = mention.text.slice(at + 1);
      if (!q && !ctx.explicit && mention.text.length > 1 && !/[\s(]@$/.test(mention.text)) return null;
      let users: { username: string; displayName: string }[];
      try {
        users = await get(`/api/users/search?q=${encodeURIComponent(q)}`);
      } catch {
        return null;
      }
      if (ctx.aborted) return null;
      return {
        from: mention.from + at + 1,
        options: users.map((u) => ({ label: u.username, detail: u.displayName, type: 'variable', apply: `${u.username} ` })),
        filter: false,
      };
    }
    // #tags (only after at least one character so headings aren't disturbed)
    const tag = ctx.matchBefore(/(?:^|[\s(])#[\p{L}\p{N}_\-/]+$/u);
    if (tag) {
      const hash = tag.text.lastIndexOf('#');
      return { from: tag.from + hash + 1, options: data.tags().map((t) => ({ label: t, type: 'keyword' })), validFor: /^[\p{L}\p{N}_\-/]*$/u };
    }
    // /slash commands at the start of a line
    const slash = ctx.matchBefore(/^\s*\/[\w-]*$/);
    if (slash) {
      const start = slash.from + slash.text.indexOf('/');
      return {
        from: start + 1,
        options: SLASH_COMMANDS.map((c) => ({
          label: c.label,
          detail: c.detail,
          type: 'function',
          apply: (view: EditorView, _c: Completion, _from: number, to: number) => c.apply(view, start, to),
        })),
        validFor: /^[\w-]*$/,
      };
    }
    return null;
  };
}
