import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../api';
import type { PublicUser } from '../types';
import { Avatar, Modal, useToast } from './ui';
import { useDialogs } from './dialogs';
import { errMsg } from '../util';

interface Perms {
  direct: { id: string; role: string; user: PublicUser }[];
  inherited: { id: string; role: string; fromFolder: string; user: PublicUser }[];
  members: { role: string; user: PublicUser }[];
  owner: PublicUser | null;
  restricted: boolean;
  canShare: boolean;
}

interface AuditEntry {
  id: string;
  at: string;
  action: string;
  ip: string | null;
  actor: PublicUser | null;
  details: Record<string, unknown>;
}

const AUDIT_LABELS: Record<string, string> = {
  'document.view': 'opened the document',
  'document.export': 'downloaded the document',
  'document.revision_view': 'viewed an older version',
  'document.classified': 'restricted the document',
  'document.declassified': 'lifted the restriction',
  'attachment.view': 'opened an attachment',
  'permission.granted': 'granted access',
  'permission.revoked': 'removed access',
};

export function ShareDialog({
  type,
  id,
  name,
  publicToken,
  onClose,
  initialUser,
  canEdit = false,
}: {
  type: 'document' | 'folder';
  id: string;
  name: string;
  publicToken?: string | null;
  onClose: () => void;
  initialUser?: string;
  /** May change the document's classification (editors). */
  canEdit?: boolean;
}) {
  const { confirm } = useDialogs();
  const [showLog, setShowLog] = useState(false);
  const { data: log } = useQuery({ queryKey: ['audit', id], queryFn: () => get<AuditEntry[]>(`/api/documents/${id}/audit`), enabled: showLog });
  const setClassification = async (classification: 'restricted' | 'standard') => {
    const ok =
      classification === 'restricted'
        ? await confirm({
            title: 'Restrict this document?',
            message:
              'Only you and the people you list here will be able to open it — workspace admins and folder shares lose access. ' +
              'Its content, history, comments and attachments are encrypted at rest, and it is left out of search snippets, exports, Git sync, e-mails and AI assist. Any public link is removed.',
            confirmText: 'Restrict',
          })
        : await confirm({
            title: 'Lift the restriction?',
            message: 'Everyone with access to the workspace or folder will be able to open this document again, and it will be stored unencrypted.',
            confirmText: 'Lift restriction',
            danger: true,
          });
    if (!ok) return;
    try {
      await put(`/api/documents/${id}/classification`, { classification });
      toast(classification === 'restricted' ? 'Document restricted and encrypted' : 'Restriction lifted', 'success');
      setLink(null);
      void refetch();
      void qc.invalidateQueries({ queryKey: ['doc', id] });
      void qc.invalidateQueries({ queryKey: ['tree'] });
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  };
  const base = type === 'document' ? `/api/documents/${id}` : `/api/folders/${id}`;
  const qc = useQueryClient();
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['perms', type, id], queryFn: () => get<Perms>(`${base}/permissions`) });
  const [user, setUser] = useState(initialUser ?? '');
  const [role, setRole] = useState('editor');
  const [suggest, setSuggest] = useState<PublicUser[]>([]);
  const [link, setLink] = useState<string | null>(publicToken ? `${location.origin}/p/${publicToken}` : null);

  const search = async (q: string) => {
    setUser(q);
    if (q.trim().length < 1) return setSuggest([]);
    try {
      setSuggest(await get(`/api/users/search?q=${encodeURIComponent(q)}`));
    } catch {
      setSuggest([]);
    }
  };

  const share = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user.trim()) return;
    try {
      await post(`${base}/permissions`, { user: user.trim(), role });
      toast(`Shared with ${user}`, 'success');
      setUser('');
      setSuggest([]);
      void refetch();
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  };

  const remove = async (userId: string) => {
    try {
      await del(`${base}/permissions/${userId}`);
      void refetch();
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  };

  const togglePublic = async () => {
    try {
      if (link) {
        await del(`${base}/public-link`);
        setLink(null);
      } else {
        const r = await post<{ url: string; token: string }>(`${base}/public-link`);
        setLink(`${location.origin}/p/${r.token}`);
      }
      void qc.invalidateQueries({ queryKey: ['doc', id] });
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  };

  return (
    <Modal title={`Share "${name}"`} onClose={onClose} wide>
      {data?.canShare !== false && (
        <form className="share-form" onSubmit={share}>
          <div className="autocomplete">
            <input
              placeholder="Username or e-mail"
              value={user}
              onChange={(e) => search(e.target.value)}
              aria-label="Username or e-mail"
              data-testid="share-user"
            />
            {suggest.length > 0 && (
              <ul className="autocomplete-list">
                {suggest.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setUser(u.username);
                        setSuggest([]);
                      }}
                    >
                      <Avatar user={u} size={20} /> {u.displayName} <span className="muted">@{u.username}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role" data-testid="share-role">
            <option value="viewer">Can view</option>
            <option value="commenter">Can comment</option>
            <option value="editor">Can edit</option>
          </select>
          <button className="btn btn-primary" type="submit" data-testid="share-submit">
            Share
          </button>
        </form>
      )}

      {type === 'document' && data?.restricted && (
        <div className="restricted-box" data-testid="restricted-box">
          <strong>🔒 Restricted</strong>
          <p className="small">
            Only the owner and the people listed below can open this document. Workspace admins and folder shares have no access. Content, history, comments and
            attachments are encrypted at rest; the document is excluded from exports, Git sync, search snippets, e-mails and AI assist. Every access is logged.
          </p>
          {data.canShare && (
            <div className="row">
              <button className="btn btn-small" onClick={() => setShowLog((s) => !s)} data-testid="show-audit">
                {showLog ? 'Hide access log' : 'View access log'}
              </button>
              <button className="btn btn-small btn-danger" onClick={() => setClassification('standard')} data-testid="unrestrict">
                Lift restriction
              </button>
            </div>
          )}
          {showLog && (
            <ul className="audit-log" data-testid="audit-log">
              {log?.map((e) => (
                <li key={e.id}>
                  <span className="muted small">{new Date(e.at).toLocaleString()}</span> <strong>{e.actor?.displayName ?? 'Someone'}</strong>{' '}
                  {AUDIT_LABELS[e.action] ?? e.action}
                </li>
              ))}
              {log && !log.length && <li className="muted">No entries yet.</li>}
            </ul>
          )}
        </div>
      )}
      {type === 'document' && data && !data.restricted && canEdit && (
        <div className="restrict-offer">
          <span className="small muted">Sensitive content? Limit this document to specific people and encrypt it at rest.</span>
          <button className="btn btn-small" onClick={() => setClassification('restricted')} data-testid="restrict">
            🔒 Restrict…
          </button>
        </div>
      )}

      <h4>People with access</h4>
      <ul className="perm-list">
        {data?.owner && (
          <li>
            <Avatar user={data.owner} /> <span>{data.owner.displayName}</span> <span className="muted">@{data.owner.username}</span>
            <span className="spacer" />
            <span className="badge">owner</span>
          </li>
        )}
        {data?.direct.map((p) => (
          <li key={p.id}>
            <Avatar user={p.user} /> <span>{p.user.displayName}</span> <span className="muted">@{p.user.username}</span>
            <span className="spacer" />
            <span className="badge">{p.role}</span>
            {data.canShare && (
              <button className="btn btn-small" onClick={() => remove(p.user.id)}>
                Remove
              </button>
            )}
          </li>
        ))}
        {data?.inherited.map((p) => (
          <li key={p.id} className="muted">
            <Avatar user={p.user} /> <span>{p.user.displayName}</span>
            <span className="spacer" />
            <span className="badge">{p.role}</span> <span className="small">via 📁 {p.fromFolder}</span>
          </li>
        ))}
        {data?.members.map((m) => (
          <li key={m.user.id} className="muted">
            <Avatar user={m.user} /> <span>{m.user.displayName}</span>
            <span className="spacer" />
            <span className="badge">{m.role}</span> <span className="small">workspace member</span>
          </li>
        ))}
      </ul>

      {type === 'document' && data?.canShare && !data.restricted && (
        <div className="public-link">
          <h4>Public link</h4>
          <p className="muted small">Anyone with the link can read this document without signing in.</p>
          {link ? (
            <div className="row">
              <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Public link" data-testid="public-link" />
              <button className="btn" onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Link copied', 'success'))}>
                Copy
              </button>
              <button className="btn btn-danger" onClick={togglePublic}>
                Disable
              </button>
            </div>
          ) : (
            <button className="btn" onClick={togglePublic} data-testid="enable-public-link">
              Create public link
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
