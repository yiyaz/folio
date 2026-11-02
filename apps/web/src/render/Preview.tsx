import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { renderToHtml, normalizeName, headingSlug } from '@folio/markdown';
import { enhance } from './enhance';
import { useClientConfig } from '../auth';
import { highlightRendered, type AuthorMeta, type AuthorshipMode } from '../authorship';
import type { Span } from '@folio/markdown';

export interface PreviewProps {
  source: string;
  names?: { id: string; name: string }[];
  publicToken?: string;
  className?: string;
  onToggleTask?: (index: number, checked: boolean) => void;
  /** Who wrote which part of `source`, and how to show it. */
  authorship?: { spans: Span[]; mode: AuthorshipMode; meta: AuthorMeta };
}

export function usePrefersDark() {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function Preview({ source, names = [], publicToken, className, onToggleTask, authorship }: PreviewProps) {
  const showAuthors = !!authorship && authorship.mode !== 'off' && authorship.spans.length > 0;
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const config = useClientConfig();
  const dark = usePrefersDark();

  const byName = useMemo(() => new Map(names.map((n) => [normalizeName(n.name), n.id])), [names]);
  const patterns = useMemo(() => (config?.embedPatterns ?? []).map((p) => new RegExp(p)), [config]);

  const html = useMemo(
    () =>
      renderToHtml(source, {
        resolveWikiLink: (target, anchor) => {
          const id = byName.get(normalizeName(target));
          if (!id) return null;
          const frag = anchor ? (anchor.startsWith('^') ? `#block-${anchor.slice(1)}` : `#${headingSlug(anchor)}`) : '';
          return { href: `/d/${id}${frag}`, exists: true };
        },
        isEmbeddableUrl: publicToken ? undefined : (u) => patterns.some((p) => p.test(u)),
        sourceSpans: showAuthors,
      }),
    [source, byName, patterns, publicToken, showAuthors],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html;
    if (showAuthors) highlightRendered(el, source, authorship!.spans, authorship!.mode, authorship!.meta);
    // task list checkboxes are rendered disabled by GFM; make them interactive when editing is allowed
    el.querySelectorAll<HTMLInputElement>('li.task-list-item > input[type=checkbox]').forEach((box, i) => {
      if (!onToggleTask) return;
      box.disabled = false;
      box.addEventListener('change', () => onToggleTask(i, box.checked));
    });
    void enhance(el, { config, publicToken, theme: dark ? 'dark' : 'light' });
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, config, publicToken, dark, onToggleTask, showAuthors && authorship!.spans, authorship?.mode, authorship?.meta]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    if (a.classList.contains('broken')) {
      e.preventDefault();
      return;
    }
    if (href.startsWith('#')) {
      e.preventDefault();
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'smooth' });
      history.replaceState(null, '', href);
      return;
    }
    if (href.startsWith('/') && !href.startsWith('/api/') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      navigate(href);
    } else if (/^https?:/.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  };

  return <div ref={ref} className={`markdown-body ${className ?? ''}`} onClick={onClick} data-testid="preview" />;
}
