import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { normalizeName, headingSlug } from '@folio/markdown';
import { ApiError, api, del, get, isRetryable, patch, post, put } from '../api';
import { useAuth, useClientConfig } from '../auth';
import { useNames, useTags } from '../hooks';
import { realtime } from '../realtime';
import { Editor, type EditorHandle } from '../editor/Editor';
import { toggleWrap, setHeading, toggleLinePrefix, insertLink, insertBlock, insertCodeBlock, TABLE_SNIPPET } from '../editor/commands';
import { Preview } from '../render/Preview';
import { OutlinePanel, BacklinksPanel, CommentsPanel, HistoryPanel } from '../components/DocPanels';
import { ShareDialog } from '../components/ShareDialog';
import { Avatar, Menu, Modal, Spinner, useToast } from '../components/ui';
import { useDialogs } from '../components/dialogs';
import { useCommands, PageTitle } from '../components/Layout';
import { can } from '../roles';
import { cx, errMsg, timeAgo, modKey } from '../util';
import type { Comment, Doc, EditorMode, PublicUser } from '../types';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
type Panel = 'outline' | 'backlinks' | 'comments' | 'history' | null;

export function DocPage() {
  const { docId } = useParams<{ docId: string }>();
  const {
    data: doc,
    error,
    isLoading,
  } = useQuery({ queryKey: ['doc', docId], queryFn: () => get<Doc>(`/api/documents/${docId}`), staleTime: Infinity, retry: false });
  if (isLoading) return <Spinner />;
  if (error || !doc)
    return (
      <div className="empty">
        <h3>{error instanceof ApiError && error.status === 404 ? 'Document not found' : 'Could not load the document'}</h3>
        <p className="muted">It may have been deleted, or you may not have access.</p>
        <Link to="/">Go home</Link>
      </div>
    );
  return <DocEditor key={doc.id} doc={doc} />;
}

function DocEditor({ doc }: { doc: Doc }) {
  const { me, setMe } = useAuth();
  const config = useClientConfig();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { prompt, confirm } = useDialogs();
  const { register } = useCommands();
  const [params] = useSearchParams();
  const editorRef = useRef<EditorHandle>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const canEdit = can(doc.role, 'edit') && !doc.deletedAt;
  const canComment = can(doc.role, 'comment') && !doc.deletedAt;
  const [content, setContent] = useState(doc.content);
  const contentRef = useRef(doc.content);
  const versionRef = useRef(doc.version);
  const [saveState, setSaveStateRaw] = useState<SaveState>('saved');
  const saveStateRef = useRef<SaveState>('saved');
  const setSaveState = useCallback((s: SaveState | ((p: SaveState) => SaveState)) => {
    setSaveStateRaw((prev) => {
      const next = typeof s === 'function' ? s(prev) : s;
      saveStateRef.current = next;
      return next;
    });
  }, []);
  const [conflict, setConflict] = useState<{ content: string; version: number } | null>(null);
  const [remoteUpdate, setRemoteUpdate] = useState<string | null>(null);
  const [presence, setPresence] = useState<PublicUser[]>([]);
  const [mode, setModeState] = useState<EditorMode>(() => (canEdit ? (me?.prefs.editorMode ?? 'live') : 'read'));
  const [panel, setPanel] = useState<Panel>(() => (params.get('comment') ? 'comments' : null));
  const [share, setShare] = useState<{ user?: string } | null>(null);
  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null);
  const [name, setName] = useState(doc.name);
  const [showResolved, setShowResolved] = useState(false);
  const [ai, setAi] = useState<{ title: string; text: string | null } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const retries = useRef(0);

  const { data: names = [] } = useNames(doc.workspaceId);
  const { data: tags = [] } = useTags(doc.workspaceId);
  const nameSet = useMemo(() => new Set(names.map((n) => normalizeName(n.name))), [names]);
  const nameMap = useMemo(() => new Map(names.map((n) => [normalizeName(n.name), n.id])), [names]);
  const { data: comments = [] } = useQuery({ queryKey: ['comments', doc.id], queryFn: () => get<Comment[]>(`/api/documents/${doc.id}/comments`) });

  useEffect(() => editorRef.current?.refresh(), [nameSet]);

  // ---- saving ----
  const save = useCallback(async (): Promise<void> => {
    if (inFlight.current) await inFlight.current;
    saveTimer.current = null;
    const text = contentRef.current;
    setSaveState('saving');
    const p = (async () => {
      try {
        const r = await put<{ version: number; title: string; mentionedWithoutAccess: { username: string }[] }>(`/api/documents/${doc.id}/content`, {
          content: text,
          baseVersion: versionRef.current,
        });
        versionRef.current = r.version;
        if (retries.current > 0) toast('Saved again — all changes are stored', 'success');
        retries.current = 0;
        setSaveState(contentRef.current === text ? 'saved' : 'dirty');
        if (r.mentionedWithoutAccess.length) {
          const u = r.mentionedWithoutAccess[0].username;
          toast(`@${u} was mentioned but can't open this document. Use Share to invite them.`, 'info');
          setShare({ user: u });
        }
        void qc.invalidateQueries({ queryKey: ['links', doc.id] });
        if (contentRef.current !== text) scheduleSave();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setConflict({ content: e.details.content, version: e.details.version });
          setSaveState('conflict');
        } else if (isRetryable(e)) {
          // keep the edit and retry with backoff (offline, deploy in progress, ...)
          setSaveState('error');
          const delay = Math.min(30_000, 1000 * 2 ** retries.current++);
          if (retries.current === 1) toast(`Couldn't save (${errMsg(e)}). Retrying automatically…`, 'error');
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => void save(), delay);
        } else {
          setSaveState('error');
          toast(`Saving failed: ${errMsg(e)}`, 'error');
        }
      }
    })();
    inFlight.current = p;
    await p;
    inFlight.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, setSaveState]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), 800);
  }, [save]);

  const onChange = useCallback(
    (text: string) => {
      contentRef.current = text;
      setContent(text);
      if (!canEdit) return;
      setSaveState((s) => (s === 'conflict' ? s : 'dirty'));
      scheduleSave();
    },
    [canEdit, scheduleSave, setSaveState],
  );

  // flush on unmount / tab close
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (saveTimer.current || inFlight.current) {
        void save();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        void save();
      }
    };
  }, [save]);

  const replaceContent = (text: string, version: number) => {
    versionRef.current = version;
    contentRef.current = text;
    setContent(text);
    editorRef.current?.setContent(text);
    setSaveState('saved');
  };

  const reloadFromServer = async () => {
    const fresh = await get<Doc>(`/api/documents/${doc.id}`);
    replaceContent(fresh.content, fresh.version);
    setRemoteUpdate(null);
    qc.setQueryData(['doc', doc.id], fresh);
  };

  // ---- realtime ----
  useEffect(() => {
    realtime.join(doc.id);
    const off = realtime.on(async (m) => {
      if (m.type === 'presence' && m.docId === doc.id) setPresence(m.users);
      if (m.type === 'connected') realtime.join(doc.id);
      if (m.type === 'comments-changed' && m.docId === doc.id) void qc.invalidateQueries({ queryKey: ['comments', doc.id] });
      if (m.type === 'doc-updated' && m.docId === doc.id && m.version > versionRef.current) {
        void qc.invalidateQueries({ queryKey: ['revisions', doc.id] });
        void qc.invalidateQueries({ queryKey: ['backlinks', doc.id] });
        const pristine = !saveTimer.current && !inFlight.current && (saveStateRef.current === 'saved' || !canEdit);
        if (pristine) await reloadFromServer();
        else setRemoteUpdate(m.byName);
      }
    });
    return () => {
      off();
      realtime.leave(doc.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  // ---- comment highlights in the editor ----
  const anchorRange = useCallback((c: Comment): { from: number; to: number } | null => {
    if (!c.anchorText) return null;
    const text = contentRef.current;
    const hint = c.anchorStart ?? 0;
    // re-anchor: nearest occurrence of the quoted text to where it was originally
    let best = -1;
    for (let i = text.indexOf(c.anchorText); i >= 0; i = text.indexOf(c.anchorText, i + 1)) {
      if (best < 0 || Math.abs(i - hint) < Math.abs(best - hint)) best = i;
    }
    return best >= 0 ? { from: best, to: best + c.anchorText.length } : null;
  }, []);

  useEffect(() => {
    const ranges = comments
      .filter((c) => !c.parentId && !c.resolvedAt && c.anchorText)
      .map((c) => ({ id: c.id, ...anchorRange(c)! }))
      .filter((r) => r.from != null);
    editorRef.current?.setComments(ranges as any);
  }, [comments, content, anchorRange, mode]);

  const focusAnchor = (c: Comment) => {
    const r = anchorRange(c);
    const v = editorRef.current?.view;
    if (!r || !v) return;
    if (mode === 'read') setMode('live');
    setTimeout(() => {
      const view = editorRef.current?.view;
      if (!view) return;
      view.dispatch({ selection: { anchor: r.from, head: r.to }, scrollIntoView: true });
      view.focus();
    }, 30);
  };

  useEffect(() => {
    const id = params.get('comment');
    if (!id) return;
    setPanel('comments');
    setTimeout(() => document.getElementById(`comment-${id}`)?.scrollIntoView({ block: 'center' }), 300);
  }, [params]);

  // ---- mode ----
  const setMode = (m: EditorMode) => {
    setModeState(m);
    if (canEdit && me)
      void patch('/api/users/me', { prefs: { editorMode: m } })
        .then((r) => setMe(r.user))
        .catch(() => {});
  };

  // ---- actions ----
  const rename = async () => {
    const next = name.trim();
    if (!next || next === doc.name) return setName(doc.name);
    try {
      await patch(`/api/documents/${doc.id}`, { name: next });
      qc.setQueryData(['doc', doc.id], { ...doc, name: next });
      void qc.invalidateQueries({ queryKey: ['names', doc.workspaceId] });
      toast('Renamed. Links in other documents were updated.', 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
      setName(doc.name);
    }
  };

  const trash = async () => {
    if (
      !(await confirm({
        title: 'Move to trash?',
        message: `"${doc.name}" will be moved to the trash. You can restore it later.`,
        confirmText: 'Move to trash',
        danger: true,
      }))
    )
      return;
    await del(`/api/documents/${doc.id}`);
    toast('Moved to trash');
    navigate('/');
  };

  const restore = async () => {
    try {
      await post(`/api/documents/${doc.id}/restore`);
      await qc.invalidateQueries({ queryKey: ['doc', doc.id] });
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const addComment = async () => {
    if (!selection) return toast('Select some text first', 'info');
    const body = await prompt({
      title: 'Add comment',
      label: `On “${selection.text.slice(0, 60)}${selection.text.length > 60 ? '…' : ''}”`,
      confirmText: 'Comment',
    });
    if (!body) return;
    try {
      await post(`/api/documents/${doc.id}/comments`, {
        body,
        anchorText: selection.text.slice(0, 2000),
        anchorStart: selection.from,
        anchorEnd: selection.to,
      });
      setPanel('comments');
      void qc.invalidateQueries({ queryKey: ['comments', doc.id] });
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const upload = useCallback(
    async (file: File) => {
      const fd = new FormData();
      fd.append('workspaceId', doc.workspaceId);
      fd.append('documentId', doc.id);
      fd.append('file', file);
      const r = await api<{ markdown: string; mime: string; url: string }>('/api/attachments', { method: 'POST', body: fd });
      if (r.mime === 'application/x-ipynb+json') return `\`\`\`notebook\nsrc: ${r.url}\n\`\`\``;
      if (r.mime === 'application/vnd.apache.parquet' || r.mime === 'text/csv') return `\`\`\`dataset\nsrc: ${r.url}\nlimit: 200\n\`\`\``;
      return r.markdown;
    },
    [doc.id, doc.workspaceId],
  );

  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.pdf,.csv,.tsv,.txt,.json,.ipynb,.parquet';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const md = await upload(f);
        const v = editorRef.current?.view;
        if (v) insertBlock(v, md);
      } catch (e) {
        toast(errMsg(e), 'error');
      }
    };
    input.click();
  };

  const runAi = async (action: 'summarize' | 'explain' | 'docs' | 'improve') => {
    const text = selection?.text || contentRef.current;
    const titles = { summarize: 'Summary', explain: 'Explanation', docs: 'Generated documentation', improve: 'Improved text' };
    setAi({ title: titles[action], text: null });
    try {
      const r = await post<{ text: string }>('/api/ai', { action, text, documentId: doc.id });
      setAi({ title: titles[action], text: r.text });
    } catch (e) {
      setAi(null);
      toast(errMsg(e), 'error');
    }
  };

  const toggleTask = useCallback(
    (index: number, checked: boolean) => {
      if (!canEdit) return;
      let i = -1;
      const next = contentRef.current.replace(/^(\s*[-*+]\s+\[)([ xX])(\])/gm, (m, a, _b, c) => (++i === index ? `${a}${checked ? 'x' : ' '}${c}` : m));
      onChange(next);
      editorRef.current?.setContent(next);
    },
    [canEdit, onChange],
  );

  // ---- command palette entries for this document ----
  useEffect(
    () =>
      register('doc', [
        ...(['live', 'source', 'split', 'read'] as EditorMode[])
          .filter((m) => canEdit || m === 'read')
          .map((m) => ({ id: `mode-${m}`, label: `View: ${m} mode`, run: () => setMode(m) })),
        { id: 'doc-share', label: 'Share this document…', run: () => setShare({}) },
        { id: 'doc-history', label: 'Show version history', run: () => setPanel('history') },
        { id: 'doc-backlinks', label: 'Show backlinks', run: () => setPanel('backlinks') },
        { id: 'doc-outline', label: 'Show outline', run: () => setPanel('outline') },
        { id: 'doc-comments', label: 'Show comments', run: () => setPanel('comments') },
        { id: 'doc-export', label: 'Export this document (.md)', run: () => (window.location.href = `/api/documents/${doc.id}/export`) },
        ...(canEdit ? [{ id: 'doc-trash', label: 'Move this document to trash', run: trash }] : []),
        ...(config?.ai && !doc.restricted
          ? (['summarize', 'explain', 'docs', 'improve'] as const).map((a) => ({ id: `ai-${a}`, label: `AI: ${a}`, run: () => runAi(a) }))
          : []),
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [register, doc.id, canEdit, config?.ai, doc.restricted],
  );

  const hooks = useMemo(
    () => ({
      exists: (t: string) => nameSet.has(normalizeName(t)),
      onWikiLink: (target: string, anchor: string | null) => {
        if (!target) return;
        const id = nameMap.get(normalizeName(target));
        if (id) navigate(`/d/${id}${anchor ? `#${anchor.startsWith('^') ? `block-${anchor.slice(1)}` : headingSlug(anchor)}` : ''}`);
        else if (canEdit)
          void confirm({ title: 'Create document?', message: `"${target}" doesn't exist yet. Create it?`, confirmText: 'Create' }).then(async (ok) => {
            if (!ok) return;
            try {
              const d = await post('/api/documents', { workspaceId: doc.workspaceId, folderId: doc.folderId, name: target });
              void qc.invalidateQueries({ queryKey: ['names', doc.workspaceId] });
              navigate(`/d/${d.id}`);
            } catch (e) {
              toast(errMsg(e), 'error');
            }
          });
      },
      onMention: (u: string) => navigate(`/u/${u}`),
      onTag: (t: string) => navigate(`/tags/${encodeURIComponent(t)}`),
    }),
    [nameSet, nameMap, navigate, canEdit, doc.workspaceId, doc.folderId, confirm, qc, toast],
  );

  const completionData = useMemo(() => ({ docNames: () => names, tags: () => tags.map((t) => t.tag) }), [names, tags]);
  const view = () => editorRef.current?.view;
  const fmt = (fn: (v: NonNullable<ReturnType<typeof view>>) => unknown) => () => {
    const v = view();
    if (v) fn(v);
  };

  const editorMode: 'live' | 'source' = mode === 'source' || mode === 'split' ? 'source' : 'live';
  const showEditor = mode !== 'read';
  const showPreview = mode === 'read' || mode === 'split';
  const openComments = comments.filter((c) => !c.parentId && !c.resolvedAt).length;

  return (
    <div className={cx('doc-page', panel && 'with-panel')}>
      <PageTitle>{doc.title}</PageTitle>
      {doc.deletedAt && (
        <div className="banner banner-warn">
          This document is in the trash.{' '}
          {can(doc.role, 'edit') && (
            <button className="btn btn-small" onClick={restore}>
              Restore
            </button>
          )}
        </div>
      )}
      {remoteUpdate && (
        <div className="banner">
          {remoteUpdate} updated this document.{' '}
          <button className="btn btn-small" onClick={reloadFromServer}>
            Load their changes
          </button>{' '}
          <span className="muted small">(your unsaved edits will be replaced)</span>
        </div>
      )}
      <div className="doc-header">
        <div className="breadcrumb small muted">
          <span>{doc.workspaceName}</span>
          {doc.folderPath.map((f) => (
            <span key={f.id}> / {f.name}</span>
          ))}
        </div>
        <div className="doc-title-row">
          <input
            className="doc-title"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            readOnly={!canEdit}
            aria-label="Document name"
            data-testid="doc-name"
          />
          <span className={`save-state save-${saveState}`} data-testid="save-state">
            {saveState === 'saved'
              ? 'Saved'
              : saveState === 'saving'
                ? 'Saving…'
                : saveState === 'dirty'
                  ? 'Editing…'
                  : saveState === 'conflict'
                    ? 'Conflict'
                    : 'Not saved'}
          </span>
          <div className="presence" data-testid="presence">
            {presence
              .filter((p) => p.id !== me?.id)
              .map((p) => (
                <Avatar key={p.id} user={p} size={26} />
              ))}
          </div>
          <div className="mode-switch" role="tablist" aria-label="View mode">
            {(['live', 'source', 'split', 'read'] as EditorMode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={cx(mode === m && 'active')}
                onClick={() => setMode(m)}
                disabled={!canEdit && m !== 'read'}
                data-testid={`mode-${m}`}
              >
                {m === 'live' ? 'Live' : m === 'source' ? 'Source' : m === 'split' ? 'Split' : 'Read'}
              </button>
            ))}
          </div>
          {can(doc.role, 'read') && (
            <button className="btn btn-primary btn-small" onClick={() => setShare({})} data-testid="share-btn">
              Share
            </button>
          )}
          <Menu
            align="right"
            trigger={(t) => (
              <button className="icon-btn" onClick={t} aria-label="More actions" data-testid="doc-menu">
                ⋯
              </button>
            )}
          >
            {(close) => (
              <>
                <button onClick={() => (close(), setPanel('history'))}>Version history</button>
                {canEdit && (
                  <button
                    onClick={async () => {
                      close();
                      const d = await post(`/api/documents/${doc.id}/duplicate`);
                      navigate(`/d/${d.id}`);
                    }}
                  >
                    Duplicate
                  </button>
                )}
                <a href={`/api/documents/${doc.id}/export`} onClick={close}>
                  Download .md
                </a>
                <button onClick={() => (close(), window.print())}>Print / PDF</button>
                {config?.ai && !doc.restricted && (
                  <>
                    <div className="menu-label small">AI assist {selection ? '(selection)' : '(document)'}</div>
                    <button onClick={() => (close(), runAi('summarize'))}>Summarize</button>
                    <button onClick={() => (close(), runAi('explain'))}>Explain code</button>
                    <button onClick={() => (close(), runAi('docs'))}>Generate docs</button>
                    <button onClick={() => (close(), runAi('improve'))}>Improve writing</button>
                  </>
                )}
                {canEdit && (
                  <button className="danger" onClick={() => (close(), trash())}>
                    Move to trash
                  </button>
                )}
              </>
            )}
          </Menu>
        </div>
        <div className="doc-meta small muted">
          {doc.updatedByUser ? `Edited by ${doc.updatedByUser.displayName}` : ''} {timeAgo(doc.updatedAt)} · {doc.role}
          {doc.sharedOnly ? ' (shared with you)' : ''}
          {doc.restricted && (
            <button
              className="restricted-badge"
              onClick={() => setShare({})}
              title="Only listed people can open this document; encrypted at rest"
              data-testid="restricted-badge"
            >
              🔒 Restricted
            </button>
          )}
        </div>
      </div>

      {canEdit && showEditor && (
        <div className="toolbar" role="toolbar" aria-label="Formatting">
          <button onClick={fmt((v) => toggleWrap(v, '**'))} title={`Bold (${modKey}+B)`} aria-label="Bold" data-testid="tb-bold">
            <b>B</b>
          </button>
          <button onClick={fmt((v) => toggleWrap(v, '*'))} title={`Italic (${modKey}+I)`} aria-label="Italic">
            <i>I</i>
          </button>
          <button onClick={fmt((v) => toggleWrap(v, '~~'))} title="Strikethrough" aria-label="Strikethrough">
            <s>S</s>
          </button>
          <button onClick={fmt((v) => toggleWrap(v, '`'))} title={`Inline code (${modKey}+E)`} aria-label="Inline code">
            {'</>'}
          </button>
          <span className="sep" />
          <button onClick={fmt((v) => setHeading(v, 1))} title="Heading 1" aria-label="Heading 1" data-testid="tb-h1">
            H1
          </button>
          <button onClick={fmt((v) => setHeading(v, 2))} title="Heading 2" aria-label="Heading 2">
            H2
          </button>
          <button onClick={fmt((v) => setHeading(v, 3))} title="Heading 3" aria-label="Heading 3">
            H3
          </button>
          <span className="sep" />
          <button onClick={fmt((v) => toggleLinePrefix(v, '- '))} title="Bulleted list" aria-label="Bulleted list">
            •
          </button>
          <button onClick={fmt((v) => toggleLinePrefix(v, '1. '))} title="Numbered list" aria-label="Numbered list">
            1.
          </button>
          <button onClick={fmt((v) => toggleLinePrefix(v, '- [ ] '))} title="Task list" aria-label="Task list">
            ☑
          </button>
          <button onClick={fmt((v) => toggleLinePrefix(v, '> '))} title="Quote" aria-label="Quote">
            ❝
          </button>
          <span className="sep" />
          <button onClick={fmt(insertLink)} title={`Link (${modKey}+K)`} aria-label="Link">
            🔗
          </button>
          <button onClick={fmt((v) => insertBlock(v, TABLE_SNIPPET, 2))} title="Table" aria-label="Table">
            ▦
          </button>
          <button onClick={fmt((v) => insertCodeBlock(v))} title="Code block" aria-label="Code block">
            {'{ }'}
          </button>
          <button onClick={fmt((v) => insertBlock(v, '$$\n\n$$', 3))} title="Math block" aria-label="Math block">
            ∑
          </button>
          <button onClick={fmt((v) => insertBlock(v, '```mermaid\nflowchart LR\n  A --> B\n```', 11))} title="Diagram" aria-label="Mermaid diagram">
            ⧉
          </button>
          <button onClick={pickFile} title="Upload image or file" aria-label="Upload file">
            📎
          </button>
          {canComment && (
            <>
              <span className="sep" />
              <button onClick={addComment} disabled={!selection} title="Comment on selection" aria-label="Comment on selection" data-testid="tb-comment">
                💬 Comment
              </button>
            </>
          )}
        </div>
      )}
      {!canEdit && canComment && showEditor && (
        <div className="toolbar">
          <button onClick={addComment} disabled={!selection} data-testid="tb-comment">
            💬 Comment on selection
          </button>
        </div>
      )}

      <div className="doc-body">
        <div className={cx('doc-panes', mode === 'split' && 'split')}>
          <div className="pane-editor" hidden={!showEditor}>
            <Editor
              ref={editorRef}
              initialValue={doc.content}
              mode={editorMode}
              readOnly={!canEdit}
              keymapMode={me?.prefs.keymap ?? 'default'}
              showLineNumbers={!!me?.prefs.lineNumbers || mode === 'source'}
              hooks={hooks}
              completionData={completionData}
              onChange={onChange}
              onSelection={setSelection}
              onUpload={canEdit ? upload : undefined}
              onScroll={(r) => {
                const p = previewRef.current;
                if (p && mode === 'split') p.scrollTop = r * (p.scrollHeight - p.clientHeight);
              }}
            />
          </div>
          {showPreview && (
            <div className="pane-preview" ref={previewRef}>
              <Preview source={content} names={names} onToggleTask={canEdit ? toggleTask : undefined} />
            </div>
          )}
        </div>
        <aside className="doc-side">
          <div className="side-tabs" role="tablist">
            {(['outline', 'backlinks', 'comments', 'history'] as const).map((p) => (
              <button
                key={p}
                role="tab"
                aria-selected={panel === p}
                className={cx(panel === p && 'active')}
                onClick={() => setPanel(panel === p ? null : p)}
                data-testid={`panel-${p}`}
              >
                {p === 'outline' ? '☰' : p === 'backlinks' ? '↩' : p === 'comments' ? '💬' : '🕘'}
                <span className="tab-label">{p}</span>
                {p === 'comments' && openComments > 0 && <span className="count">{openComments}</span>}
              </button>
            ))}
          </div>
          {panel && (
            <div className="side-panel">
              {panel === 'outline' && (
                <OutlinePanel
                  content={content}
                  onJump={(line, slug) => {
                    if (mode === 'read') document.getElementById(slug)?.scrollIntoView({ behavior: 'smooth' });
                    else editorRef.current?.scrollToLine(line);
                  }}
                />
              )}
              {panel === 'backlinks' && <BacklinksPanel docId={doc.id} />}
              {panel === 'comments' && (
                <CommentsPanel
                  docId={doc.id}
                  role={doc.role}
                  focusId={params.get('comment')}
                  onFocusAnchor={focusAnchor}
                  showResolved={showResolved}
                  setShowResolved={setShowResolved}
                />
              )}
              {panel === 'history' && <HistoryPanel docId={doc.id} current={content} canRestore={canEdit} onRestored={reloadFromServer} />}
            </div>
          )}
        </aside>
      </div>

      {conflict && (
        <Modal title="Someone else changed this document" onClose={() => {}} wide>
          <p>Your edits and theirs overlap. Choose which version to keep — the other one stays available in the version history.</p>
          <div className="row-end">
            <button
              className="btn"
              onClick={() => {
                replaceContent(conflict.content, conflict.version);
                setConflict(null);
              }}
              data-testid="conflict-theirs"
            >
              Use their version
            </button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                versionRef.current = conflict.version;
                setConflict(null);
                setSaveState('dirty');
                await save();
              }}
              data-testid="conflict-mine"
            >
              Keep my version
            </button>
          </div>
        </Modal>
      )}
      {share && (
        <ShareDialog
          type="document"
          id={doc.id}
          name={doc.name}
          publicToken={doc.publicToken}
          initialUser={share.user}
          canEdit={canEdit}
          onClose={() => setShare(null)}
        />
      )}
      {ai && (
        <Modal title={ai.title} onClose={() => setAi(null)} wide>
          {ai.text == null ? (
            <Spinner />
          ) : (
            <>
              <Preview source={ai.text} names={names} />
              {canEdit && (
                <div className="row-end">
                  <button
                    className="btn"
                    onClick={() => {
                      const v = view();
                      if (v) insertBlock(v, ai.text!);
                      setAi(null);
                    }}
                  >
                    Insert at cursor
                  </button>
                </div>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
