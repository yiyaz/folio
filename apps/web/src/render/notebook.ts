import hljs from 'highlight.js/lib/common';
import { renderToHtml } from '@folio/markdown';

interface NbOutput {
  output_type: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
interface NbCell {
  cell_type: 'markdown' | 'code' | 'raw';
  source: string | string[];
  outputs?: NbOutput[];
  execution_count?: number | null;
}
export interface Notebook {
  cells: NbCell[];
  metadata?: { language_info?: { name?: string }; kernelspec?: { language?: string } };
}

const join = (s: string | string[] | undefined) => (Array.isArray(s) ? s.join('') : s ?? '');
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

/** Parse "1-3,5" into a set of 1-based cell numbers. */
export function parseCellRange(spec: string | undefined, count: number): Set<number> {
  if (!spec) return new Set(Array.from({ length: count }, (_, i) => i + 1));
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map((x) => Number(x.trim()));
    if (!a) continue;
    for (let i = a; i <= (b || a); i++) if (i >= 1 && i <= count) out.add(i);
  }
  return out;
}

export function renderNotebook(nb: Notebook, opts: { cells?: string } = {}): HTMLElement {
  const root = document.createElement('div');
  root.className = 'notebook';
  const lang = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? 'python';
  const include = parseCellRange(opts.cells, nb.cells.length);
  nb.cells.forEach((cell, idx) => {
    if (!include.has(idx + 1)) return;
    const el = document.createElement('div');
    el.className = `nb-cell nb-${cell.cell_type}`;
    const src = join(cell.source);
    if (cell.cell_type === 'markdown') {
      el.innerHTML = renderToHtml(src);
    } else if (cell.cell_type === 'code') {
      const prompt = document.createElement('div');
      prompt.className = 'nb-prompt';
      prompt.textContent = `In [${cell.execution_count ?? ' '}]:`;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'hljs';
      code.innerHTML = hljs.getLanguage(lang) ? hljs.highlight(src, { language: lang }).value : hljs.highlightAuto(src).value;
      pre.appendChild(code);
      el.append(prompt, pre);
      for (const o of cell.outputs ?? []) {
        const out = document.createElement('div');
        out.className = 'nb-output';
        if (o.output_type === 'stream') {
          const p = document.createElement('pre');
          p.textContent = stripAnsi(join(o.text));
          out.appendChild(p);
        } else if (o.output_type === 'error') {
          const p = document.createElement('pre');
          p.className = 'nb-error';
          p.textContent = stripAnsi((o.traceback ?? [`${o.ename}: ${o.evalue}`]).join('\n'));
          out.appendChild(p);
        } else if (o.data) {
          const png = o.data['image/png'];
          const jpeg = o.data['image/jpeg'];
          const html = o.data['text/html'];
          if (png || jpeg) {
            const img = document.createElement('img');
            img.src = `data:${png ? 'image/png' : 'image/jpeg'};base64,${join(png ?? jpeg).replace(/\s/g, '')}`;
            out.appendChild(img);
          } else if (html) {
            // goes through the same sanitiser as documents
            const div = document.createElement('div');
            div.className = 'nb-html';
            div.innerHTML = renderToHtml(join(html));
            out.appendChild(div);
          } else if (o.data['text/markdown']) {
            out.innerHTML = renderToHtml(join(o.data['text/markdown']));
          } else if (o.data['text/plain']) {
            const p = document.createElement('pre');
            p.textContent = join(o.data['text/plain']);
            out.appendChild(p);
          }
        }
        el.appendChild(out);
      }
    } else {
      const pre = document.createElement('pre');
      pre.textContent = src;
      el.appendChild(pre);
    }
    root.appendChild(el);
  });
  return root;
}
