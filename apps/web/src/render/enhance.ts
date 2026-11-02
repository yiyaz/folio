import Papa from 'papaparse';
import type { ClientConfig } from '../types';
import { sortableTable } from './table';
import { renderNotebook, type Notebook } from './notebook';

export interface EnhanceContext {
  config?: ClientConfig;
  /** Token of a public link; appended to attachment URLs so anonymous viewers can load them. */
  publicToken?: string;
  theme: 'light' | 'dark';
}

let mermaidSeq = 0;

function parseBlockArgs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

function withToken(url: string, ctx: EnhanceContext) {
  if (!ctx.publicToken || !url.startsWith('/api/attachments/')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}p=${encodeURIComponent(ctx.publicToken)}`;
}

/** Only same-origin attachment URLs may be fetched by data blocks. */
function safeSrc(src: string | undefined): string | null {
  if (!src) return null;
  return /^\/api\/attachments\/[0-9a-f-]{36}(\/[^?#]*)?$/i.test(src) ? src : null;
}

function errorBox(msg: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'enhance-error';
  d.textContent = msg;
  return d;
}

function replacePre(code: Element, node: HTMLElement) {
  const pre = code.closest('pre') ?? code;
  node.classList.add('enhanced');
  pre.replaceWith(node);
}

async function loadPyodide(url: string): Promise<any> {
  const w = window as any;
  if (w.__folioPyodide) return w.__folioPyodide;
  w.__folioPyodide = (async () => {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${url.replace(/\/?$/, '/')}pyodide.js`;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load Pyodide'));
      document.head.appendChild(s);
    });
    return w.loadPyodide({ indexURL: url });
  })();
  return w.__folioPyodide;
}

function enhanceRunnable(code: HTMLElement, ctx: EnhanceContext) {
  const pre = code.closest('pre');
  if (!pre || pre.dataset.runnable) return;
  pre.dataset.runnable = '1';
  const isPython = /language-(python|py)\b/.test(code.className);
  const bar = document.createElement('div');
  bar.className = 'run-bar';
  const btn = document.createElement('button');
  btn.className = 'btn btn-small';
  btn.textContent = isPython ? '▶ Run (Python)' : 'Only Python blocks can run';
  btn.disabled = !isPython || !ctx.config?.pyodideUrl;
  const out = document.createElement('pre');
  out.className = 'run-output';
  out.hidden = true;
  bar.appendChild(btn);
  pre.after(bar, out);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    out.hidden = false;
    out.textContent = 'Loading Python runtime…';
    try {
      const py = await loadPyodide(ctx.config!.pyodideUrl);
      const lines: string[] = [];
      py.setStdout({ batched: (s: string) => lines.push(s) });
      py.setStderr({ batched: (s: string) => lines.push(s) });
      out.textContent = 'Running…';
      await py.loadPackagesFromImports(code.textContent ?? '');
      const result = await py.runPythonAsync(code.textContent ?? '');
      if (result !== undefined && result !== null) lines.push(String(result));
      out.textContent = lines.join('\n') || '(no output)';
      out.classList.remove('error');
    } catch (e) {
      out.textContent = e instanceof Error ? e.message : String(e);
      out.classList.add('error');
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ Run again';
    }
  });
}

async function enhanceEmbed(el: HTMLElement) {
  const url = el.dataset.embedUrl!;
  try {
    const r = await fetch(`/api/embeds?url=${encodeURIComponent(url)}`, { credentials: 'same-origin' });
    if (!r.ok) return;
    const e = await r.json();
    const card = document.createElement('div');
    card.className = `embed-card embed-${e.kind}`;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (e.kind === 'github-pr' || e.kind === 'github-issue') {
      const state = e.merged ? 'merged' : e.draft ? 'draft' : e.state;
      a.innerHTML = `<span class="embed-badge state-${state}"></span><span class="embed-title"></span><span class="embed-meta"></span>`;
      a.querySelector('.embed-badge')!.textContent = `${e.kind === 'github-pr' ? 'PR' : 'Issue'} · ${state}`;
      a.querySelector('.embed-title')!.textContent = `${e.title} #${e.number}`;
      a.querySelector('.embed-meta')!.textContent = `${e.repo} · by ${e.author}${e.labels.length ? ' · ' + e.labels.join(', ') : ''}`;
      card.appendChild(a);
    } else if (e.kind === 'github-code') {
      a.className = 'embed-code-head';
      a.textContent = `${e.repo} · ${e.path} (lines ${e.startLine}-${e.endLine}) @ ${String(e.ref).slice(0, 10)}`;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const hljs = (await import('highlight.js/lib/common')).default;
      code.className = 'hljs';
      code.innerHTML = e.language && hljs.getLanguage(e.language) ? hljs.highlight(e.code, { language: e.language }).value : hljs.highlightAuto(e.code).value;
      code.style.counterReset = `line ${e.startLine - 1}`;
      pre.appendChild(code);
      card.append(a, pre);
    } else if (e.kind === 'jira') {
      a.innerHTML = '<span class="embed-badge"></span><span class="embed-title"></span><span class="embed-meta"></span>';
      a.querySelector('.embed-badge')!.textContent = `${e.type} · ${e.status}`;
      a.querySelector('.embed-title')!.textContent = `${e.key}: ${e.title}`;
      a.querySelector('.embed-meta')!.textContent = e.assignee ? `Assignee: ${e.assignee}` : 'Unassigned';
      card.appendChild(a);
    } else return;
    el.replaceWith(card);
  } catch {
    /* leave the plain link */
  }
}

/** Progressive enhancement of rendered Markdown: diagrams, charts, data and runnable blocks. */
export async function enhance(root: HTMLElement, ctx: EnhanceContext): Promise<void> {
  const jobs: Promise<unknown>[] = [];

  root.querySelectorAll<HTMLImageElement>('img[src^="/api/attachments/"]').forEach((img) => {
    img.src = withToken(img.getAttribute('src')!, ctx);
  });

  const mermaids = root.querySelectorAll('pre > code.language-mermaid');
  if (mermaids.length) {
    jobs.push(
      (async () => {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: ctx.theme === 'dark' ? 'dark' : 'default' });
        for (const code of mermaids) {
          const div = document.createElement('div');
          div.className = 'diagram mermaid-diagram';
          try {
            const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, code.textContent ?? '');
            div.innerHTML = svg;
          } catch (e) {
            div.appendChild(errorBox(`Mermaid: ${e instanceof Error ? e.message : e}`));
          }
          replacePre(code, div);
        }
      })(),
    );
  }

  const vegas = root.querySelectorAll('pre > code.language-vega-lite, pre > code.language-vegalite');
  if (vegas.length) {
    jobs.push(
      (async () => {
        const embed = (await import('vega-embed')).default;
        // CSP-safe: interpret expressions from the AST instead of compiling them with eval()
        const { expressionInterpreter } = await import('vega-interpreter');
        for (const code of vegas) {
          const div = document.createElement('div');
          div.className = 'diagram vega-chart';
          replacePre(code, div);
          try {
            const spec = JSON.parse(code.textContent ?? '{}');
            // never let a spec pull data from arbitrary origins
            if (spec?.data?.url && !safeSrc(spec.data.url)) throw new Error('data.url must point to an attachment (/api/attachments/…)');
            if (spec?.data?.url) spec.data.url = withToken(spec.data.url, ctx);
            await embed(div, spec, {
              actions: { export: true, source: false, compiled: false, editor: false },
              theme: ctx.theme === 'dark' ? 'dark' : undefined,
              renderer: 'svg',
              ast: true,
              expr: expressionInterpreter,
            } as never);
          } catch (e) {
            div.replaceChildren(errorBox(`Vega-Lite: ${e instanceof Error ? e.message : e}`));
          }
        }
      })(),
    );
  }

  const dots = root.querySelectorAll('pre > code.language-dot, pre > code.language-graphviz');
  if (dots.length) {
    jobs.push(
      (async () => {
        const { instance } = await import('@viz-js/viz');
        const viz = await instance();
        for (const code of dots) {
          const div = document.createElement('div');
          div.className = 'diagram graphviz-diagram';
          try {
            div.appendChild(viz.renderSVGElement(code.textContent ?? ''));
          } catch (e) {
            div.appendChild(errorBox(`Graphviz: ${e instanceof Error ? e.message : e}`));
          }
          replacePre(code, div);
        }
      })(),
    );
  }

  const plantumls = root.querySelectorAll('pre > code.language-plantuml');
  if (plantumls.length && ctx.config?.plantumlServer) {
    jobs.push(
      (async () => {
        const { encode } = (await import('plantuml-encoder')) as any;
        for (const code of plantumls) {
          const img = document.createElement('img');
          img.alt = 'PlantUML diagram';
          img.src = `${ctx.config!.plantumlServer!.replace(/\/$/, '')}/svg/${encode(code.textContent ?? '')}`;
          const div = document.createElement('div');
          div.className = 'diagram plantuml-diagram';
          div.appendChild(img);
          replacePre(code, div);
        }
      })(),
    );
  }

  root.querySelectorAll('pre > code.language-csv').forEach((code) => {
    const parsed = Papa.parse<string[]>((code.textContent ?? '').trim(), { skipEmptyLines: true });
    const [head, ...rows] = parsed.data;
    if (head) replacePre(code, sortableTable(head, rows));
  });

  root.querySelectorAll('pre > code.language-notebook').forEach((code) => {
    const args = parseBlockArgs(code.textContent ?? '');
    const src = safeSrc(args.src);
    const holder = document.createElement('div');
    holder.className = 'notebook-embed';
    replacePre(code, holder);
    if (!src) {
      holder.appendChild(errorBox('notebook: "src:" must be an attachment URL (/api/attachments/<id>)'));
      return;
    }
    jobs.push(
      fetch(withToken(src, ctx), { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((nb: Notebook) => holder.appendChild(renderNotebook(nb, { cells: args.cells })))
        .catch((e) => holder.appendChild(errorBox(`notebook: ${e.message}`))),
    );
  });

  root.querySelectorAll('pre > code.language-dataset').forEach((code) => {
    const args = parseBlockArgs(code.textContent ?? '');
    const src = safeSrc(args.src);
    const holder = document.createElement('div');
    holder.className = 'dataset-embed';
    replacePre(code, holder);
    if (!src) {
      holder.appendChild(errorBox('dataset: "src:" must be an attachment URL (/api/attachments/<id>)'));
      return;
    }
    jobs.push(renderDataset(holder, withToken(src, ctx), Number(args.limit) || 500));
  });

  root.querySelectorAll<HTMLElement>('pre > code[data-run]').forEach((code) => enhanceRunnable(code, ctx));
  root.querySelectorAll<HTMLElement>('.embed-candidate[data-embed-url]').forEach((el) => jobs.push(enhanceEmbed(el)));

  await Promise.allSettled(jobs);
}

export async function renderDataset(holder: HTMLElement, url: string, limit = 500) {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = r.headers.get('content-type') ?? '';
    if (type.includes('parquet') || /\.parquet($|\?)/i.test(url)) {
      const buf = await r.arrayBuffer();
      const { parquetReadObjects, parquetMetadata, parquetSchema } = await import('hyparquet');
      const meta = parquetMetadata(buf);
      const cols = parquetSchema(meta).children.map((c: any) => c.element.name);
      const rows = await parquetReadObjects({ file: buf, rowEnd: limit });
      holder.appendChild(
        sortableTable(
          cols,
          rows.map((o: any) => cols.map((c: string) => o[c])),
          { total: Number(meta.num_rows), caption: `parquet · ${cols.length} columns` },
        ),
      );
    } else {
      const text = await r.text();
      const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true, delimiter: url.includes('.tsv') ? '\t' : undefined });
      const [head, ...rows] = parsed.data;
      holder.appendChild(sortableTable(head ?? [], rows.slice(0, limit), { total: rows.length, caption: 'csv' }));
    }
  } catch (e) {
    holder.appendChild(errorBox(`dataset: ${e instanceof Error ? e.message : e}`));
  }
}
