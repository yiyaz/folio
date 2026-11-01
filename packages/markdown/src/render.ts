import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import { visit, SKIP } from 'unist-util-visit';
import GithubSlugger from 'github-slugger';
import type { Root, Text, PhrasingContent, Paragraph, Link, Code } from 'mdast';
import type { Root as HRoot, Element } from 'hast';
import { findWikiLinks, findMentions, findTags, BLOCK_ID_RE } from './syntax.js';

export interface ResolvedLink {
  href: string;
  exists: boolean;
}

export interface RenderOptions {
  /** Resolve a wiki-link target to an href. Unresolved links render as "broken". */
  resolveWikiLink?: (target: string, anchor: string | null) => ResolvedLink | null;
  mentionHref?: (username: string) => string;
  tagHref?: (tag: string) => string;
  /** URL patterns that should become rich embeds when a link sits alone in a paragraph. */
  isEmbeddableUrl?: (url: string) => boolean;
}

/** Fenced-code languages rendered by client-side enhancers instead of a highlighter. */
export const ENHANCED_LANGUAGES = ['mermaid', 'vega-lite', 'vegalite', 'graphviz', 'dot', 'plantuml', 'csv', 'notebook', 'dataset'];

type Seg = PhrasingContent;

function anchorToFragment(anchor: string | null): string {
  if (!anchor) return '';
  if (anchor.startsWith('^')) return `#block-${anchor.slice(1)}`;
  return `#${new GithubSlugger().slug(anchor)}`;
}

const remarkFolio: Plugin<[RenderOptions?], Root> = (opts = {}) => {
  return (tree) => {
    // 1. block ids: "text ^my-id" at the end of a paragraph
    visit(tree, 'paragraph', (p: Paragraph) => {
      const last = p.children[p.children.length - 1];
      if (last && last.type === 'text') {
        const m = BLOCK_ID_RE.exec(last.value);
        if (m) {
          last.value = last.value.slice(0, m.index).replace(/\s+$/, '');
          p.data = { ...(p.data || {}), hProperties: { ...((p.data?.hProperties as object) || {}), dataBlockId: m[1] } };
        }
      }
      // 2. embeds: a paragraph containing only a bare link to an embeddable URL
      if (opts.isEmbeddableUrl && p.children.length === 1 && p.children[0].type === 'link') {
        const link = p.children[0] as Link;
        if (opts.isEmbeddableUrl(link.url)) {
          p.data = { ...(p.data || {}), hProperties: { ...((p.data?.hProperties as object) || {}), className: ['embed-candidate'], dataEmbedUrl: link.url } };
        }
      }
    });

    // 3. runnable code blocks: ```python run
    visit(tree, 'code', (c: Code) => {
      if (c.meta && /(^|\s)run(\s|$)/.test(c.meta)) {
        c.data = { ...(c.data || {}), hProperties: { dataRun: 'true' } };
      }
    });

    // 4. inline syntax inside text nodes
    visit(tree, (node, index, parent) => {
      if (
        node.type === 'code' ||
        node.type === 'inlineCode' ||
        node.type === 'link' ||
        node.type === 'html' ||
        node.type === 'yaml' ||
        (node.type as string) === 'math' ||
        (node.type as string) === 'inlineMath'
      )
        return SKIP;
      if (node.type !== 'text' || !parent || index == null) return;
      const value = (node as Text).value;
      type Hit = { index: number; length: number; make: () => Seg };
      const hits: Hit[] = [];
      for (const w of findWikiLinks(value)) {
        hits.push({
          index: w.index,
          length: w.length,
          make: () => {
            const resolved = opts.resolveWikiLink?.(w.target, w.anchor) ?? null;
            const label = w.alias ?? (w.target ? w.target + (w.anchor ? ` › ${w.anchor.replace(/^\^/, '')}` : '') : w.anchor!.replace(/^\^/, ''));
            const href = resolved ? resolved.href : w.target ? '#' : anchorToFragment(w.anchor);
            const exists = w.target ? !!resolved?.exists : true;
            return {
              type: 'link',
              url: href,
              children: [{ type: 'text', value: label }],
              data: { hProperties: { className: exists ? ['wikilink'] : ['wikilink', 'broken'], dataTarget: w.target, dataAnchor: w.anchor ?? undefined } },
            } as Link;
          },
        });
      }
      for (const m of findMentions(value)) {
        hits.push({
          index: m.index,
          length: m.length,
          make: () =>
            ({
              type: 'link',
              url: opts.mentionHref?.(m.value) ?? `/u/${m.value}`,
              children: [{ type: 'text', value: `@${m.value}` }],
              data: { hProperties: { className: ['mention'], dataUser: m.value } },
            }) as Link,
        });
      }
      for (const t of findTags(value)) {
        hits.push({
          index: t.index,
          length: t.length,
          make: () =>
            ({
              type: 'link',
              url: opts.tagHref?.(t.value) ?? `/tags/${encodeURIComponent(t.value)}`,
              children: [{ type: 'text', value: `#${t.value}` }],
              data: { hProperties: { className: ['tag'], dataTag: t.value } },
            }) as Link,
        });
      }
      if (!hits.length) return;
      hits.sort((a, b) => a.index - b.index);
      const out: Seg[] = [];
      let pos = 0;
      for (const h of hits) {
        if (h.index < pos) continue; // overlapping (e.g. a #tag inside a wikilink)
        if (h.index > pos) out.push({ type: 'text', value: value.slice(pos, h.index) });
        out.push(h.make());
        pos = h.index + h.length;
      }
      if (pos < value.length) out.push({ type: 'text', value: value.slice(pos) });
      (parent.children as Seg[]).splice(index, 1, ...out);
      return [SKIP, index + out.length];
    });
  };
};

/** Converts data-block-id (which survives sanitising) into real element ids. */
const rehypeBlockIds: Plugin<[], HRoot> = () => (tree) => {
  visit(tree, 'element', (el: Element) => {
    const id = el.properties?.dataBlockId;
    if (typeof id === 'string') {
      el.properties.id = `block-${id}`;
      el.properties.className = [...((el.properties.className as string[]) || []), 'has-block-id'];
    }
  });
};

const withoutClass = (list: unknown[] | undefined) =>
  ((list || []) as never[]).filter((a) => !(a === 'className' || (Array.isArray(a) && a[0] === 'className')));

const schema: SanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: 'user-content-',
  tagNames: [...(defaultSchema.tagNames || []), 'mark', 'figure', 'figcaption', 'u'],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...withoutClass(defaultSchema.attributes?.['*']), 'className', 'dataBlockId', 'dataEmbedUrl'],
    a: [...withoutClass(defaultSchema.attributes?.a), 'dataTarget', 'dataAnchor', 'dataUser', 'dataTag', 'className'],
    code: [...withoutClass(defaultSchema.attributes?.code), 'className', 'dataRun'],
    input: [...(defaultSchema.attributes?.input || []), 'dataTask'],
    img: [...(defaultSchema.attributes?.img || []), 'width', 'height', 'title'],
  },
  protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto'], src: ['http', 'https'] },
};

function buildProcessor(opts: RenderOptions) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkMath)
    .use(remarkFolio, opts)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, schema)
    .use(rehypeBlockIds)
    .use(rehypeSlug)
    .use(rehypeKatex, { throwOnError: false, strict: false })
    .use(rehypeHighlight, { detect: false, plainText: ENHANCED_LANGUAGES, ignoreMissing: true } as never)
    .use(rehypeStringify);
}

/** Render Folio-flavoured Markdown to sanitised HTML. */
export function renderToHtml(source: string, opts: RenderOptions = {}): string {
  return String(buildProcessor(opts).processSync(source));
}
