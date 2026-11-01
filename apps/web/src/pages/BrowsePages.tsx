import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '../api';
import { useAuth } from '../auth';
import { useWorkspace } from '../workspace';
import { useTags } from '../hooks';
import { Avatar, EmptyState, Spinner, useToast } from '../components/ui';
import { useDialogs } from '../components/dialogs';
import { PageTitle } from '../components/Layout';
import { Preview } from '../render/Preview';
import { can } from '../roles';
import { errMsg, timeAgo } from '../util';
import type { PublicUser, Tree } from '../types';

interface DocHit {
  id: string;
  name: string;
  title: string;
  workspaceName?: string;
  updatedAt: string;
  updatedByName?: string;
  snippet?: string;
  tags?: string[];
}

export function HomePage() {
  const { me } = useAuth();
  const { current } = useWorkspace();
  const { data: recent, isLoading } = useQuery({ queryKey: ['recent'], queryFn: () => get<DocHit[]>('/api/recent') });
  const { data: tags = [] } = useTags(current?.id);
  return (
    <div className="page">
      <PageTitle>Home</PageTitle>
      <h1>Welcome back, {me?.displayName.split(' ')[0]}</h1>
      <section>
        <h2>Recently updated</h2>
        {isLoading ? (
          <Spinner />
        ) : recent?.length ? (
          <ul className="doc-list" data-testid="recent">
            {recent.map((d) => (
              <li key={d.id}>
                <Link to={`/d/${d.id}`}>{d.title}</Link>
                <span className="muted small">
                  {d.workspaceName} · {d.updatedByName ? `${d.updatedByName}, ` : ''}
                  {timeAgo(d.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Nothing here yet">Create a document from the sidebar.</EmptyState>
        )}
      </section>
      {tags.length > 0 && (
        <section>
          <h2>Popular tags</h2>
          <div className="tag-cloud">
            {tags.slice(0, 30).map((t) => (
              <Link key={t.tag} to={`/tags/${encodeURIComponent(t.tag)}`} className="tag-pill">
                #{t.tag} <span className="muted">{t.count}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
      <section className="tips muted small">
        <p>Tips: press Ctrl/⌘+P to jump to a document, Ctrl/⌘+K for commands, type / in the editor for blocks, [[ to link and @ to mention.</p>
      </section>
    </div>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const { current } = useWorkspace();
  const q = params.get('q') ?? '';
  const [scope, setScope] = useState<'all' | 'ws'>('all');
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  const { data, isFetching } = useQuery({
    queryKey: ['search', q, scope, current?.id],
    queryFn: () => get<DocHit[]>(`/api/search?q=${encodeURIComponent(q)}${scope === 'ws' && current ? `&workspaceId=${current.id}` : ''}`),
    enabled: q.trim().length > 0,
  });
  return (
    <div className="page">
      <PageTitle>Search</PageTitle>
      <h1>Search</h1>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setParams({ q: input });
        }}
      >
        <input className="grow" value={input} onChange={(e) => setInput(e.target.value)} placeholder='Words, "exact phrase", -exclude' autoFocus aria-label="Search query" data-testid="search-input" />
        <select value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'ws')} aria-label="Scope">
          <option value="all">All workspaces</option>
          <option value="ws">This workspace</option>
        </select>
        <button className="btn btn-primary">Search</button>
      </form>
      {isFetching && <Spinner />}
      {data && (
        <ul className="search-results" data-testid="search-results">
          {data.map((d) => (
            <li key={d.id}>
              <Link to={`/d/${d.id}`}>{d.title}</Link> <span className="muted small">{d.workspaceName}</span>
              {/* snippet comes from Postgres ts_headline over plain text; only <mark> is injected */}
              {d.snippet && <p className="snippet" dangerouslySetInnerHTML={{ __html: escapeExceptMark(d.snippet) }} />}
            </li>
          ))}
          {!data.length && <EmptyState title="No results">Try different words.</EmptyState>}
        </ul>
      )}
    </div>
  );
}

function escapeExceptMark(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}

export function TagsPage() {
  const { current } = useWorkspace();
  const { data: tags = [], isLoading } = useTags(current?.id);
  return (
    <div className="page">
      <PageTitle>Tags</PageTitle>
      <h1>Tags in {current?.name}</h1>
      {isLoading ? (
        <Spinner />
      ) : tags.length ? (
        <div className="tag-cloud">
          {tags.map((t) => (
            <Link key={t.tag} to={`/tags/${encodeURIComponent(t.tag)}`} className="tag-pill" style={{ fontSize: `${Math.min(1.6, 0.85 + t.count * 0.08)}rem` }}>
              #{t.tag} <span className="muted">{t.count}</span>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState title="No tags yet">Add #tags to your documents or a `tags:` list in front matter.</EmptyState>
      )}
    </div>
  );
}

export function TagPage() {
  const { tag = '' } = useParams();
  const { data, isLoading } = useQuery({ queryKey: ['tag', tag], queryFn: () => get<DocHit[]>(`/api/tags/${encodeURIComponent(tag)}`) });
  return (
    <div className="page">
      <PageTitle>{`#${tag}`}</PageTitle>
      <h1>#{tag}</h1>
      {isLoading ? (
        <Spinner />
      ) : (
        <ul className="doc-list" data-testid="tag-docs">
          {data?.map((d) => (
            <li key={d.id}>
              <Link to={`/d/${d.id}`}>{d.title}</Link>
              <span className="muted small">
                {d.tags?.map((t) => `#${t}`).join(' ')} · {timeAgo(d.updatedAt)}
              </span>
            </li>
          ))}
          {!data?.length && <EmptyState title="No documents with this tag" />}
        </ul>
      )}
    </div>
  );
}

export function SharedPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['shared'],
    queryFn: () => get<{ type: 'document' | 'folder'; id: string; name: string; role: string; sharedByName: string; sharedAt: string }[]>('/api/shared'),
  });
  return (
    <div className="page">
      <PageTitle>Shared with me</PageTitle>
      <h1>Shared with me</h1>
      {isLoading ? (
        <Spinner />
      ) : data?.length ? (
        <ul className="doc-list" data-testid="shared-list">
          {data.map((s) => (
            <li key={s.id}>
              <Link to={s.type === 'document' ? `/d/${s.id}` : `/f/${s.id}`}>
                {s.type === 'folder' ? '📁 ' : '📄 '}
                {s.name}
              </Link>
              <span className="muted small">
                {s.role} · shared by {s.sharedByName} {timeAgo(s.sharedAt)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nothing shared with you yet" />
      )}
    </div>
  );
}

export function FolderPage() {
  const { folderId } = useParams();
  const { data, isLoading } = useQuery({ queryKey: ['folder', folderId], queryFn: () => get<Tree & { id: string; role: string }>(`/api/folders/${folderId}`) });
  if (isLoading) return <Spinner />;
  if (!data) return <EmptyState title="Folder not found" />;
  const root = data.folders.find((f) => f.id === data.id);
  const render = (parent: string, depth: number): React.ReactNode => (
    <ul style={{ paddingLeft: depth ? 16 : 0 }}>
      {data.folders
        .filter((f) => f.parentId === parent)
        .map((f) => (
          <li key={f.id}>
            📁 {f.name}
            {render(f.id, depth + 1)}
          </li>
        ))}
      {data.documents
        .filter((d) => d.folderId === parent)
        .map((d) => (
          <li key={d.id}>
            <Link to={`/d/${d.id}`}>📄 {d.name}</Link>
          </li>
        ))}
    </ul>
  );
  return (
    <div className="page">
      <PageTitle>{root?.name ?? 'Folder'}</PageTitle>
      <h1>📁 {root?.name}</h1>
      <p className="muted small">Your access: {data.role}</p>
      {render(data.id, 0)}
    </div>
  );
}

export function UserPage() {
  const { username = '' } = useParams();
  const { data, isLoading } = useQuery({ queryKey: ['user', username], queryFn: () => get<PublicUser & { createdAt: string }>(`/api/users/by-username/${username}`) });
  if (isLoading) return <Spinner />;
  if (!data) return <EmptyState title="User not found" />;
  return (
    <div className="page">
      <PageTitle>{data.displayName}</PageTitle>
      <div className="row">
        <Avatar user={data} size={56} />
        <div>
          <h1>{data.displayName}</h1>
          <p className="muted">
            @{data.username} · member since {new Date(data.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>
    </div>
  );
}

export function TrashPage() {
  const { wsId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useDialogs();
  const { data, refetch } = useQuery({
    queryKey: ['trash', wsId],
    queryFn: () => get<{ documents: { id: string; name: string; deletedAt: string }[]; folders: { id: string; name: string; deletedAt: string }[] }>(`/api/workspaces/${wsId}/trash`),
  });
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refetch();
      void qc.invalidateQueries({ queryKey: ['tree', wsId] });
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };
  return (
    <div className="page">
      <PageTitle>Trash</PageTitle>
      <h1>Trash</h1>
      {!data?.documents.length && !data?.folders.length && <EmptyState title="Trash is empty" />}
      <ul className="doc-list" data-testid="trash-list">
        {data?.folders.map((f) => (
          <li key={f.id}>
            <span>📁 {f.name}</span>
            <span className="muted small">deleted {timeAgo(f.deletedAt)}</span>
            <button className="btn btn-small" onClick={() => act(() => post(`/api/folders/${f.id}/restore`))}>
              Restore
            </button>
          </li>
        ))}
        {data?.documents.map((d) => (
          <li key={d.id}>
            <Link to={`/d/${d.id}`}>📄 {d.name}</Link>
            <span className="muted small">deleted {timeAgo(d.deletedAt)}</span>
            <button className="btn btn-small" onClick={() => act(() => post(`/api/documents/${d.id}/restore`))} data-testid="restore-doc">
              Restore
            </button>
            <button
              className="btn btn-small btn-danger"
              onClick={async () => {
                if (await confirm({ title: 'Delete permanently?', message: `"${d.name}" and its history will be deleted forever.`, danger: true, confirmText: 'Delete forever' }))
                  await act(() => del(`/api/documents/${d.id}/permanent`));
              }}
            >
              Delete forever
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PublicDocPage() {
  const { token = '' } = useParams();
  const { data, error, isLoading } = useQuery({ queryKey: ['public', token], queryFn: () => get<{ title: string; content: string; updatedAt: string }>(`/api/public/${token}`), retry: false });
  useEffect(() => {
    if (data) document.title = `${data.title} · Folio`;
  }, [data]);
  if (isLoading) return <Spinner />;
  if (error || !data) return <EmptyState title="This link is no longer available" />;
  return (
    <div className="public-page">
      <header className="public-head">
        <span className="muted small">Shared via Folio · updated {timeAgo(data.updatedAt)}</span>
      </header>
      <article className="public-article">
        <Preview source={data.content} publicToken={token} />
      </article>
    </div>
  );
}

export function NotFound() {
  const navigate = useNavigate();
  return (
    <EmptyState title="Page not found">
      <button className="btn" onClick={() => navigate('/')}>
        Go home
      </button>
    </EmptyState>
  );
}

void can;
