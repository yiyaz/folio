import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';
import { useQueryClient } from '@tanstack/react-query';
import { post, patch } from '../api';
import { useAuth, useClientConfig } from '../auth';
import { useWorkspace } from '../workspace';
import { useTree } from '../hooks';
import { realtime } from '../realtime';
import { FileTree } from './FileTree';
import { NotificationBell } from './NotificationBell';
import { Palette, type PaletteItem } from './Palette';
import { ShareDialog } from './ShareDialog';
import { TemplatePicker } from './TemplatePicker';
import { AiDialog } from './AiDialog';
import { Avatar, Menu, useToast } from './ui';
import { useDialogs } from './dialogs';
import { can } from '../roles';
import { errMsg, modKey } from '../util';
import type { TreeFolder } from '../types';

interface CommandCtx {
  register: (key: string, items: PaletteItem[]) => () => void;
}
const CommandsContext = createContext<CommandCtx>({ register: () => () => {} });
export const useCommands = () => useContext(CommandsContext);

export function Layout() {
  const { me, setMe } = useAuth();
  const { workspaces, current, setCurrentId } = useWorkspace();
  const { data: tree } = useTree(current?.id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { prompt } = useDialogs();
  const [palette, setPalette] = useState<'switcher' | 'commands' | null>(null);
  const [shareFolder, setShareFolder] = useState<TreeFolder | null>(null);
  const [templateFolder, setTemplateFolder] = useState<string | null | undefined>(undefined);
  const [aiNew, setAiNew] = useState(false);
  const config = useClientConfig();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const registry = useRef(new Map<string, PaletteItem[]>());
  const [, force] = useState(0);
  const register = useCallback((key: string, items: PaletteItem[]) => {
    registry.current.set(key, items);
    force((x) => x + 1);
    return () => {
      registry.current.delete(key);
      force((x) => x + 1);
    };
  }, []);

  useEffect(() => {
    realtime.start();
    const off = realtime.on((m) => {
      if (m.type === 'tree-changed') {
        void qc.invalidateQueries({ queryKey: ['tree', m.workspaceId] });
        void qc.invalidateQueries({ queryKey: ['names', m.workspaceId] });
      }
    });
    return () => {
      off();
      realtime.stop();
    };
  }, [qc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPalette('switcher');
      } else if (mod && (e.key.toLowerCase() === 'k' ? !document.activeElement?.closest('.cm-editor') : e.shiftKey && e.key.toLowerCase() === 'p')) {
        e.preventDefault();
        setPalette('commands');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const logout = async () => {
    await post('/api/auth/logout').catch(() => {});
    setMe(null);
    navigate('/login');
  };

  const createWorkspace = async () => {
    const name = await prompt({ title: 'New workspace', label: 'Workspace name', confirmText: 'Create' });
    if (!name) return;
    try {
      const ws = await post('/api/workspaces', { name });
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      setCurrentId(ws.id);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const canEdit = can(current?.role, 'edit');

  const switcherItems: PaletteItem[] = useMemo(
    () => (tree?.documents ?? []).map((d) => ({ id: d.id, label: d.name, hint: d.title !== d.name ? d.title : undefined, run: () => navigate(`/d/${d.id}`) })),
    [tree, navigate],
  );

  const commandItems: PaletteItem[] = useMemo(() => {
    const base: PaletteItem[] = [
      { id: 'go-home', label: 'Go to home', run: () => navigate('/') },
      { id: 'go-search', label: 'Search documents', run: () => navigate('/search') },
      { id: 'go-tags', label: 'Browse tags', run: () => navigate('/tags') },
      { id: 'go-shared', label: 'Shared with me', run: () => navigate('/shared') },
      { id: 'go-settings', label: 'Open settings', run: () => navigate('/settings') },
      { id: 'quick-open', label: 'Quick open document…', hint: `${modKey}+P`, run: () => setTimeout(() => setPalette('switcher'), 0) },
      { id: 'new-workspace', label: 'Create workspace…', run: createWorkspace },
      {
        id: 'toggle-theme',
        label: 'Toggle dark mode',
        run: async () => {
          const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
          const r = await patch('/api/users/me', { prefs: { theme: next } });
          setMe(r.user);
        },
      },
      ...(['default', 'vim', 'emacs'] as const).map((k) => ({
        id: `keymap-${k}`,
        label: `Editor keybindings: ${k}`,
        run: async () => {
          const r = await patch('/api/users/me', { prefs: { keymap: k } });
          setMe(r.user);
          toast(`Keybindings set to ${k}`);
        },
      })),
    ];
    if (current && canEdit && config?.ai) base.push({ id: 'ai-new', label: 'Write a new document with AI…', run: () => setAiNew(true) });
    if (current && canEdit) {
      base.push(
        { id: 'new-doc-template', label: 'New document from template…', run: () => setTemplateFolder(null) },
        { id: 'ws-settings', label: 'Workspace settings', run: () => navigate(`/workspace/${current.id}`) },
        { id: 'ws-trash', label: 'Open trash', run: () => navigate(`/workspace/${current.id}/trash`) },
      );
    }
    if (current) base.push({ id: 'ws-export', label: 'Export workspace as .zip', run: () => (window.location.href = `/api/workspaces/${current.id}/export`) });
    if (me?.isAdmin) base.push({ id: 'admin', label: 'Administration', run: () => navigate('/admin') });
    return [...[...registry.current.values()].flat(), ...base];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry.current.size, current, canEdit, me, navigate]);

  return (
    <CommandsContext.Provider value={{ register }}>
      <div className={`app ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <aside className="sidebar" onClick={(e) => (e.target as HTMLElement).closest('a') && setSidebarOpen(false)}>
          <div className="brand">
            <Link to="/">
              <img src="/favicon.svg" alt="" width={22} height={22} /> Folio
            </Link>
          </div>
          <div className="ws-select">
            <select
              value={current?.id ?? ''}
              onChange={(e) => (e.target.value === '__new' ? createWorkspace() : setCurrentId(e.target.value))}
              aria-label="Workspace"
              data-testid="workspace-select"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
              <option value="__new">＋ New workspace…</option>
            </select>
          </div>
          <nav className="side-nav">
            <NavLink to="/" end>
              🏠 Home
            </NavLink>
            <NavLink to="/search">🔍 Search</NavLink>
            <NavLink to="/tags"># Tags</NavLink>
            <NavLink to="/shared">👥 Shared with me</NavLink>
            {current && canEdit && <NavLink to={`/workspace/${current.id}/trash`}>🗑 Trash</NavLink>}
            {current && <NavLink to={`/workspace/${current.id}`}>⚙ Workspace</NavLink>}
          </nav>
          {current && canEdit && (
            <button className="btn btn-small template-btn" onClick={() => setTemplateFolder(null)} data-testid="new-from-template">
              ＋ New from template
            </button>
          )}
          {current && canEdit && config?.ai && (
            <button className="btn btn-small template-btn" onClick={() => setAiNew(true)} data-testid="new-with-ai">
              ✨ Write with AI
            </button>
          )}
          {current && tree && (
            <FileTree workspaceId={current.id} tree={tree} canEdit={canEdit} onShareFolder={setShareFolder} onNewFromTemplate={(f) => setTemplateFolder(f)} />
          )}
        </aside>
        <div className="main">
          <header className="topbar">
            <button className="icon-btn hamburger" onClick={() => setSidebarOpen((o) => !o)} aria-label="Toggle sidebar">
              ☰
            </button>
            <form
              className="top-search"
              onSubmit={(e) => {
                e.preventDefault();
                const q = new FormData(e.currentTarget).get('q') as string;
                if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
              }}
            >
              <input name="q" placeholder={`Search…   (${modKey}+P to jump)`} aria-label="Search" />
            </form>
            <button className="btn btn-small" onClick={() => setPalette('commands')} title={`Command palette (${modKey}+K)`}>
              ⌘ Commands
            </button>
            <NotificationBell />
            <Menu
              align="right"
              trigger={(toggle) => (
                <button className="icon-btn" onClick={toggle} aria-label="Account menu" data-testid="account-menu">
                  <Avatar user={me} size={28} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <div className="menu-label">
                    {me?.displayName}
                    <br />
                    <span className="muted small">@{me?.username}</span>
                  </div>
                  <button onClick={() => (close(), navigate('/settings'))}>Settings</button>
                  {me?.isAdmin && <button onClick={() => (close(), navigate('/admin'))}>Administration</button>}
                  <button onClick={() => (close(), logout())} data-testid="logout">
                    Sign out
                  </button>
                </>
              )}
            </Menu>
          </header>
          <main className="content">
            <ErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>
      </div>
      {palette === 'switcher' && (
        <Palette
          title="Open document"
          placeholder="Type a document name…"
          items={switcherItems}
          onClose={() => setPalette(null)}
          emptyText="No documents match"
        />
      )}
      {palette === 'commands' && <Palette title="Commands" placeholder="Type a command…" items={commandItems} onClose={() => setPalette(null)} />}
      {shareFolder && <ShareDialog type="folder" id={shareFolder.id} name={shareFolder.name} onClose={() => setShareFolder(null)} />}
      {aiNew && current && <AiDialog workspaceId={current.id} mode="new" onClose={() => setAiNew(false)} />}
      {templateFolder !== undefined && current && (
        <TemplatePicker workspaceId={current.id} folderId={templateFolder} onClose={() => setTemplateFolder(undefined)} />
      )}
    </CommandsContext.Provider>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.title = `${typeof children === 'string' ? children : 'Folio'} · Folio`;
  }, [children]);
  return null;
}
