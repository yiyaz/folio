import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { diffLines } from 'diff';
import { parseDocument } from '@folio/markdown';
import { del, get, patch, post } from '../api';
import type { Comment, PublicUser, Role } from '../types';
import { Avatar, useToast } from './ui';
import { useDialogs } from './dialogs';
import { can } from '../roles';
import { errMsg, timeAgo } from '../util';
import { useAuth } from '../auth';

export function OutlinePanel({ content, onJump }: { content: string; onJump: (line: number, slug: string) => void }) {
  const headings = useMemo(() => parseDocument(content).headings, [content]);
  if (!headings.length) return <p className="muted small pad">Add headings (# Title) to build an outline.</p>;
  const min = Math.min(...headings.map((h) => h.depth));
  return (
    <ul className="outline">
      {headings.map((h, i) => (
        <li key={i} style={{ paddingLeft: (h.depth - min) * 12 }}>
          <button className="link-btn" onClick={() => onJump(h.line, h.slug)}>
            {h.text || '(empty heading)'}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function BacklinksPanel({ docId }: { docId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['backlinks', docId],
    queryFn: () => get<{ id: string; name: string; title: string; anchors: string[]; excerpt: string }[]>(`/api/documents/${docId}/backlinks`),
  });
  const { data: links } = useQuery({
    queryKey: ['links', docId],
    queryFn: () => get<{ targetName: string; targetId: string | null; anchor: string | null; targetTitle: string | null }[]>(`/api/documents/${docId}/links`),
  });
  if (isLoading) return <p className="muted small pad">Loading…</p>;
  const broken = (links ?? []).filter((l) => !l.targetId);
  return (
    <div className="backlinks" data-testid="backlinks">
      <h4>Linked from ({data?.length ?? 0})</h4>
      {!data?.length && <p className="muted small">No other document links here yet. Link to it with [[name]].</p>}
      <ul>
        {data?.map((b) => (
          <li key={b.id}>
            <Link to={`/d/${b.id}`}>{b.title}</Link>
            {b.anchors.length > 0 && <span className="muted small"> → {b.anchors.map((a) => (a.startsWith('^') ? a : `#${a}`)).join(', ')}</span>}
            {b.excerpt && <div className="excerpt">{b.excerpt}</div>}
          </li>
        ))}
      </ul>
      {broken.length > 0 && (
        <>
          <h4>Broken links ({broken.length})</h4>
          <ul>
            {broken.map((l, i) => (
              <li key={i} className="broken-link">
                [[{l.targetName}
                {l.anchor ? `#${l.anchor}` : ''}]]
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function CommentsPanel({ docId, role, focusId, onFocusAnchor, showResolved, setShowResolved }: { docId: string; role: Role; focusId: string | null; onFocusAnchor: (c: Comment) => void; showResolved: boolean; setShowResolved: (b: boolean) => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useDialogs();
  const { data = [] } = useQuery({ queryKey: ['comments', docId], queryFn: () => get<Comment[]>(`/api/documents/${docId}/comments`) });
  const [reply, setReply] = useState<Record<string, string>>({});
  const threads = data.filter((c) => !c.parentId && (showResolved || !c.resolvedAt));
  const replies = (id: string) => data.filter((c) => c.parentId === id);
  const refresh = () => qc.invalidateQueries({ queryKey: ['comments', docId] });
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };
  const canComment = can(role, 'comment');

  return (
    <div className="comments" data-testid="comments">
      <label className="small muted">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
      </label>
      {!threads.length && <p className="muted small">No comments. {canComment ? 'Select text in the editor and click 💬 Comment.' : ''}</p>}
      {threads.map((t) => (
        <div key={t.id} className={`thread ${t.resolvedAt ? 'resolved' : ''} ${focusId === t.id ? 'focused' : ''}`} id={`comment-${t.id}`} data-testid="comment-thread">
          {t.anchorText && (
            <button className="anchor-quote" onClick={() => onFocusAnchor(t)} title="Show in document">
              “{t.anchorText.slice(0, 120)}
              {t.anchorText.length > 120 ? '…' : ''}”
            </button>
          )}
          {[t, ...replies(t.id)].map((c) => (
            <CommentItem
              key={c.id}
              c={c}
              mine={c.author?.id === me?.id}
              canModerate={can(role, 'edit')}
              onDelete={async () => {
                if (await confirm({ title: 'Delete comment?', message: 'This cannot be undone.', danger: true, confirmText: 'Delete' })) await act(() => del(`/api/comments/${c.id}`));
              }}
              onEdit={(body) => act(() => patch(`/api/comments/${c.id}`, { body }))}
            />
          ))}
          {canComment && (
            <div className="thread-actions">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const body = (reply[t.id] ?? '').trim();
                  if (!body) return;
                  void act(() => post(`/api/documents/${docId}/comments`, { body, parentId: t.id })).then(() => setReply((r) => ({ ...r, [t.id]: '' })));
                }}
              >
                <input placeholder="Reply… (@mention someone)" value={reply[t.id] ?? ''} onChange={(e) => setReply((r) => ({ ...r, [t.id]: e.target.value }))} aria-label="Reply" />
              </form>
              <button className="btn btn-small" onClick={() => act(() => patch(`/api/comments/${t.id}`, { resolved: !t.resolvedAt }))}>
                {t.resolvedAt ? 'Reopen' : 'Resolve'}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CommentItem({ c, mine, canModerate, onDelete, onEdit }: { c: Comment; mine: boolean; canModerate: boolean; onDelete: () => void; onEdit: (body: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(c.body);
  return (
    <div className="comment">
      <div className="comment-head">
        <Avatar user={c.author as PublicUser} size={20} />
        <strong>{c.author?.displayName ?? 'Deleted user'}</strong>
        <span className="muted small">{timeAgo(c.createdAt)}</span>
        <span className="spacer" />
        {mine && !editing && (
          <button className="link-btn small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {(mine || canModerate) && (
          <button className="link-btn small" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onEdit(body);
            setEditing(false);
          }}
        >
          <input value={body} onChange={(e) => setBody(e.target.value)} autoFocus aria-label="Edit comment" />
        </form>
      ) : (
        <div className="comment-body">{c.body}</div>
      )}
    </div>
  );
}

interface Revision {
  id: string;
  version: number;
  size: number;
  createdAt: string;
  author: PublicUser | null;
}

export function HistoryPanel({ docId, current, canRestore, onRestored }: { docId: string; current: string; canRestore: boolean; onRestored: () => void }) {
  const { data = [] } = useQuery({ queryKey: ['revisions', docId], queryFn: () => get<Revision[]>(`/api/documents/${docId}/revisions`) });
  const [selected, setSelected] = useState<string | null>(null);
  const { data: rev } = useQuery({ queryKey: ['revision', docId, selected], queryFn: () => get<{ content: string; version: number }>(`/api/documents/${docId}/revisions/${selected}`), enabled: !!selected });
  const toast = useToast();
  const { confirm } = useDialogs();
  const parts = useMemo(() => (rev ? diffLines(rev.content, current) : []), [rev, current]);

  return (
    <div className="history" data-testid="history">
      <ul className="rev-list">
        {data.map((r) => (
          <li key={r.id}>
            <button className={`link-btn ${selected === r.id ? 'active' : ''}`} onClick={() => setSelected(r.id)}>
              v{r.version} · {timeAgo(r.createdAt)}
            </button>
            <span className="muted small"> {r.author?.displayName}</span>
          </li>
        ))}
      </ul>
      {rev && (
        <div className="diff">
          <div className="row">
            <strong className="small">Changes from v{rev.version} → current</strong>
            <span className="spacer" />
            {canRestore && (
              <button
                className="btn btn-small"
                data-testid="restore-revision"
                onClick={async () => {
                  if (!(await confirm({ title: `Restore version ${rev.version}?`, message: 'The current content will be replaced; it stays available in the history.', confirmText: 'Restore' }))) return;
                  try {
                    await post(`/api/documents/${docId}/revisions/${selected}/restore`);
                    toast(`Restored version ${rev.version}`, 'success');
                    onRestored();
                  } catch (e) {
                    toast(errMsg(e), 'error');
                  }
                }}
              >
                Restore this version
              </button>
            )}
          </div>
          <pre className="diff-view">
            {parts.map((p, i) => (
              <span key={i} className={p.added ? 'diff-add' : p.removed ? 'diff-del' : 'diff-same'}>
                {p.value
                  .split('\n')
                  .filter((_l, j, arr) => j < arr.length - 1 || _l !== '')
                  .map((l) => `${p.added ? '+ ' : p.removed ? '- ' : '  '}${l}`)
                  .join('\n') + '\n'}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
