import { describe, expect, it } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { toggleWrap, setHeading, toggleLinePrefix, insertBlock } from '../src/editor/commands';
import { livePreview } from '../src/editor/livePreview';
import { fuzzy } from '../src/components/Palette';
import { parseCellRange, renderNotebook } from '../src/render/notebook';
import { sortableTable } from '../src/render/table';

function view(doc: string, anchor = 0, head = anchor, extensions: any[] = []) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({ state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [markdown({ base: markdownLanguage }), ...extensions] }), parent });
}

describe('formatting commands', () => {
  it('wraps and unwraps the selection', () => {
    const v = view('hello world', 0, 5);
    toggleWrap(v, '**');
    expect(v.state.doc.toString()).toBe('**hello** world');
    toggleWrap(v, '**');
    expect(v.state.doc.toString()).toBe('hello world');
  });

  it('wraps the word at the cursor when nothing is selected', () => {
    const v = view('make this bold', 6);
    toggleWrap(v, '*');
    expect(v.state.doc.toString()).toBe('make *this* bold');
  });

  it('toggles and replaces headings', () => {
    const v = view('Title');
    setHeading(v, 2);
    expect(v.state.doc.toString()).toBe('## Title');
    setHeading(v, 1);
    expect(v.state.doc.toString()).toBe('# Title');
    setHeading(v, 1);
    expect(v.state.doc.toString()).toBe('Title');
  });

  it('toggles list prefixes across selected lines and numbers ordered lists', () => {
    const v = view('a\nb\nc', 0, 5);
    toggleLinePrefix(v, '1. ');
    expect(v.state.doc.toString()).toBe('1. a\n2. b\n3. c');
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    toggleLinePrefix(v, '- [ ] ');
    expect(v.state.doc.toString()).toBe('- [ ] a\n- [ ] b\n- [ ] c');
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    toggleLinePrefix(v, '- [ ] ');
    expect(v.state.doc.toString()).toBe('a\nb\nc');
  });

  it('inserts blocks on their own line', () => {
    const v = view('para', 4);
    insertBlock(v, '---');
    expect(v.state.doc.toString()).toBe('para\n\n---\n');
  });
});

describe('live preview decorations', () => {
  const hooks = { exists: (t: string) => t === 'Known', onWikiLink: () => {}, onMention: () => {}, onTag: () => {} };
  const classesFor = (doc: string) => {
    const v = view(doc, doc.length, doc.length, [livePreview(hooks)]);
    ensureSyntaxTree(v.state, v.state.doc.length, 5000);
    v.dispatch({}); // trigger a decoration pass with the full tree
    return v.contentDOM.innerHTML;
  };

  it('styles headings, emphasis, wiki links, mentions and tags', () => {
    const html = classesFor('# Title\n\n**bold** [[Known]] [[Ghost]] @alice #ml\n\nend');
    expect(html).toContain('cm-lp-h1');
    expect(html).toContain('cm-lp-strong');
    expect(html).toContain('cm-lp-wikilink');
    expect(html).toMatch(/cm-lp-wikilink cm-lp-broken[^>]*data-wikilink="Ghost"/);
    expect(html).toContain('cm-lp-mention');
    expect(html).toContain('cm-lp-tag');
  });

  it('hides markup on inactive lines (editor not focused)', () => {
    const html = classesFor('## Heading\n\n**bold**');
    expect(html).not.toContain('## ');
    expect(html).not.toContain('**');
  });

  it('does not decorate syntax inside code', () => {
    const html = classesFor('`[[Known]] @alice`\n\n```\n#notatag\n```');
    expect(html).not.toContain('cm-lp-wikilink');
    expect(html).not.toContain('cm-lp-mention');
    expect(html).not.toContain('cm-lp-tag');
  });

  it('renders task checkboxes', () => {
    const html = classesFor('- [x] done\n- [ ] todo\n\nend');
    expect(html.match(/cm-lp-checkbox/g)?.length).toBe(2);
  });
});

describe('fuzzy matching', () => {
  it('prefers substring and early matches', () => {
    expect(fuzzy('meeting notes', 'notes')).toBeGreaterThan(fuzzy('meeting notes', 'mtn'));
    expect(fuzzy('architecture decision', 'arch')).toBeGreaterThan(0);
    expect(fuzzy('abc', 'xyz')).toBe(0);
  });
});

describe('notebook rendering', () => {
  it('parses cell ranges', () => {
    expect([...parseCellRange('1-3,5', 6)]).toEqual([1, 2, 3, 5]);
    expect([...parseCellRange(undefined, 2)]).toEqual([1, 2]);
    expect([...parseCellRange('4-9', 5)]).toEqual([4, 5]);
  });

  it('renders markdown, code, stream, image and error outputs; sanitises HTML outputs', () => {
    const el = renderNotebook({
      cells: [
        { cell_type: 'markdown', source: ['# Analysis'] },
        {
          cell_type: 'code',
          source: 'print(1)',
          execution_count: 1,
          outputs: [
            { output_type: 'stream', text: ['1\n'] },
            { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo=' } },
            { output_type: 'execute_result', data: { 'text/html': '<b>bold</b><script>alert(1)</script>' } },
            { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[31mValueError\u001b[0m: bad'] },
          ],
        },
      ],
    });
    expect(el.querySelector('h1')?.textContent).toBe('Analysis');
    expect(el.querySelector('.nb-prompt')?.textContent).toBe('In [1]:');
    expect(el.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(el.querySelector('.nb-html')?.innerHTML).toContain('<b>bold</b>');
    expect(el.innerHTML).not.toContain('<script');
    expect(el.querySelector('.nb-error')?.textContent).toBe('ValueError: bad');
  });

  it('respects the cells filter', () => {
    const el = renderNotebook({ cells: [{ cell_type: 'markdown', source: 'a' }, { cell_type: 'markdown', source: 'b' }] }, { cells: '2' });
    expect(el.textContent?.trim()).toBe('b');
  });
});

describe('sortable table', () => {
  it('sorts numerically and filters', () => {
    const t = sortableTable(['name', 'n'], [['b', '10'], ['a', '9'], ['c', '100']]);
    const th = t.querySelectorAll('th')[1] as HTMLElement;
    th.click();
    const col = () => [...t.querySelectorAll('tbody tr')].map((r) => r.children[1].textContent);
    expect(col()).toEqual(['9', '10', '100']);
    th.click();
    expect(col()).toEqual(['100', '10', '9']);
    const input = t.querySelector('input')!;
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    expect(col()).toEqual(['9']);
  });
});

describe('wiki-link completion', () => {
  it('moves the cursor past an auto-closed ]]', async () => {
    const { folioCompletions } = await import('../src/editor/completions');
    const { CompletionContext } = await import('@codemirror/autocomplete');
    const v = view('See [[Des]]', 9);
    const source = folioCompletions({ docNames: () => [{ name: 'Design', title: 'Design' }], tags: () => [] });
    const result = await source(new CompletionContext(v.state, 9, true));
    const opt = result!.options[0];
    (opt.apply as any)(v, opt, result!.from, 9);
    expect(v.state.doc.toString()).toBe('See [[Design]]');
    expect(v.state.selection.main.head).toBe(14);
  });
});
