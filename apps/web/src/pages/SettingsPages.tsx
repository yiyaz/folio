import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, del, get, patch, post, put } from '../api';
import { useAuth } from '../auth';
import { useWorkspace } from '../workspace';
import { Avatar, Spinner, useToast } from '../components/ui';
import { useDialogs } from '../components/dialogs';
import { PageTitle } from '../components/Layout';
import { can } from '../roles';
import { errMsg, timeAgo } from '../util';
import type { PublicUser, Role, Workspace } from '../types';

export function SettingsPage() {
  const { me, setMe } = useAuth();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const { data: tokens = [], refetch } = useQuery({
    queryKey: ['tokens'],
    queryFn: () => get<{ id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }[]>('/api/tokens'),
  });
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState('');
  if (!me) return null;

  const savePrefs = async (prefs: Record<string, unknown>) => {
    try {
      const r = await patch('/api/users/me', { prefs });
      setMe(r.user);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  return (
    <div className="page narrow">
      <PageTitle>Settings</PageTitle>
      <h1>Settings</h1>
      <section className="card">
        <h2>Profile</h2>
        <div className="row">
          <Avatar user={me} size={56} />
          <label className="btn btn-small">
            Upload avatar
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const fd = new FormData();
                fd.append('file', f);
                try {
                  await api('/api/users/me/avatar', { method: 'POST', body: fd });
                  setMe({ ...me, hasAvatar: true });
                  location.reload();
                } catch (err) {
                  toast(errMsg(err), 'error');
                }
              }}
            />
          </label>
        </div>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await patch('/api/users/me', { displayName });
            setMe(r.user);
            toast('Profile saved', 'success');
          }}
        >
          <label className="field grow">
            <span>Display name</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
          <button className="btn">Save</button>
        </form>
        <p className="muted small">
          @{me.username} · {me.email}
        </p>
      </section>

      <section className="card">
        <h2>Editor</h2>
        <label className="field">
          <span>Default view</span>
          <select value={me.prefs.editorMode ?? 'live'} onChange={(e) => savePrefs({ editorMode: e.target.value })}>
            <option value="live">Live preview (format next to the text)</option>
            <option value="source">Source</option>
            <option value="split">Split (source + preview)</option>
            <option value="read">Read</option>
          </select>
        </label>
        <label className="field">
          <span>Show authorship</span>
          <select value={me.prefs.authorship ?? 'ai'} onChange={(e) => savePrefs({ authorship: e.target.value })}>
            <option value="ai">Highlight AI-written text and people's edits to it</option>
            <option value="all">Highlight every author (AI and coworkers)</option>
            <option value="off">Don't highlight</option>
          </select>
        </label>
        <label className="field">
          <span>Keybindings</span>
          <select value={me.prefs.keymap ?? 'default'} onChange={(e) => savePrefs({ keymap: e.target.value })} data-testid="keymap-select">
            <option value="default">Default</option>
            <option value="vim">Vim</option>
            <option value="emacs">Emacs</option>
          </select>
        </label>
        <label className="field">
          <span>Theme</span>
          <select value={me.prefs.theme ?? 'system'} onChange={(e) => savePrefs({ theme: e.target.value })}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={!!me.prefs.lineNumbers} onChange={(e) => savePrefs({ lineNumbers: e.target.checked })} /> Show line numbers
        </label>
        <label className="check">
          <input type="checkbox" checked={me.prefs.emailNotifications !== false} onChange={(e) => savePrefs({ emailNotifications: e.target.checked })} /> E-mail
          me about mentions, shares and comments
        </label>
      </section>

      <section className="card">
        <h2>Password</h2>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post('/api/auth/change-password', pw);
              setPw({ currentPassword: '', newPassword: '' });
              toast('Password changed', 'success');
            } catch (err) {
              toast(errMsg(err), 'error');
            }
          }}
        >
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              value={pw.currentPassword}
              onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })}
              autoComplete="current-password"
            />
          </label>
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              value={pw.newPassword}
              onChange={(e) => setPw({ ...pw, newPassword: e.target.value })}
              minLength={10}
              autoComplete="new-password"
            />
          </label>
          <button className="btn">Change password</button>
        </form>
      </section>

      <section className="card">
        <h2>API tokens</h2>
        <p className="muted small">
          Use tokens with the REST API (<code>Authorization: Bearer …</code>) or the <code>folio</code> CLI.
        </p>
        {newToken && (
          <div className="alert" data-testid="new-token">
            Copy your token now — it won't be shown again:
            <br />
            <code>{newToken}</code>
          </div>
        )}
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await post<{ token: string }>('/api/tokens', { name: tokenName || 'CLI' });
              setNewToken(r.token);
              setTokenName('');
              void refetch();
            } catch (err) {
              toast(errMsg(err), 'error');
            }
          }}
        >
          <input
            className="grow"
            placeholder="Token name, e.g. laptop CLI"
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            aria-label="Token name"
          />
          <button className="btn">Create token</button>
        </form>
        <ul className="doc-list">
          {tokens.map((t) => (
            <li key={t.id}>
              <span>
                {t.name} <code className="muted">{t.prefix}…</code>
              </span>
              <span className="muted small">{t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : 'never used'}</span>
              <button className="btn btn-small btn-danger" onClick={() => del(`/api/tokens/${t.id}`).then(() => refetch())}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

interface Member extends PublicUser {
  role: Role;
}
interface GitCfg {
  remote: string;
  branch: string;
  username: string;
  subdir: string;
  hasToken: boolean;
  lastPushAt?: string;
  lastPullAt?: string;
  lastCommit?: string;
  lastError?: string | null;
}

export function WorkspaceSettingsPage() {
  const { wsId = '' } = useParams();
  const { workspaces, setCurrentId } = useWorkspace();
  const { me } = useAuth();
  const ws = workspaces.find((w) => w.id === wsId) as Workspace | undefined;
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useDialogs();
  const navigate = useNavigate();
  const isAdmin = can(ws?.role, 'manage');
  const { data: members = [], refetch } = useQuery({ queryKey: ['members', wsId], queryFn: () => get<Member[]>(`/api/workspaces/${wsId}/members`) });
  const { data: git, refetch: refetchGit } = useQuery({
    queryKey: ['git', wsId],
    queryFn: () => get<GitCfg | null>(`/api/workspaces/${wsId}/git`),
    enabled: isAdmin,
  });
  const [name, setName] = useState(ws?.name ?? '');
  const [invite, setInvite] = useState({ user: '', role: 'editor' });
  const [gitForm, setGitForm] = useState<{ remote: string; branch: string; username: string; subdir: string; token: string }>({
    remote: '',
    branch: 'main',
    username: 'x-access-token',
    subdir: '',
    token: '',
  });
  const [gitBusy, setGitBusy] = useState(false);
  const [gitLoaded, setGitLoaded] = useState(false);
  if (git && !gitLoaded) {
    setGitForm({ remote: git.remote, branch: git.branch, username: git.username, subdir: git.subdir, token: '' });
    setGitLoaded(true);
  }
  if (!ws) return <Spinner />;

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok, 'success');
      void refetch();
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  return (
    <div className="page narrow">
      <PageTitle>{ws.name}</PageTitle>
      <h1>Workspace: {ws.name}</h1>
      {isAdmin && (
        <section className="card">
          <h2>General</h2>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => patch(`/api/workspaces/${wsId}`, { name }), 'Renamed');
            }}
          >
            <input className="grow" value={name} onChange={(e) => setName(e.target.value)} aria-label="Workspace name" />
            <button className="btn">Rename</button>
          </form>
        </section>
      )}

      <section className="card">
        <h2>Members</h2>
        {isAdmin && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const r = await post(`/api/workspaces/${wsId}/members`, invite);
                toast(r.invited ? `Invitation e-mailed to ${invite.user}` : `${invite.user} added`, 'success');
                setInvite({ ...invite, user: '' });
              });
            }}
          >
            <input
              className="grow"
              placeholder="Username or e-mail (e-mail invites new people)"
              value={invite.user}
              onChange={(e) => setInvite({ ...invite, user: e.target.value })}
              aria-label="Invite member"
              data-testid="member-input"
            />
            <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })} aria-label="Member role">
              <option value="viewer">Viewer</option>
              <option value="commenter">Commenter</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
            <button className="btn btn-primary">Add</button>
          </form>
        )}
        <ul className="perm-list" data-testid="members">
          {members.map((m) => (
            <li key={m.id}>
              <Avatar user={m} /> {m.displayName} <span className="muted">@{m.username}</span>
              <span className="spacer" />
              {isAdmin && m.role !== 'owner' ? (
                <select
                  value={m.role}
                  onChange={(e) => act(() => patch(`/api/workspaces/${wsId}/members/${m.id}`, { role: e.target.value }))}
                  aria-label={`Role for ${m.username}`}
                >
                  <option value="viewer">Viewer</option>
                  <option value="commenter">Commenter</option>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </select>
              ) : (
                <span className="badge">{m.role}</span>
              )}
              {m.role !== 'owner' && (isAdmin || m.id === me?.id) && (
                <button className="btn btn-small" onClick={() => act(() => del(`/api/workspaces/${wsId}/members/${m.id}`))}>
                  {m.id === me?.id ? 'Leave' : 'Remove'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {isAdmin && <StorageCard wsId={wsId} />}

      <section className="card">
        <h2>Import & export</h2>
        <p className="muted small">Export everything as plain Markdown files, or import .md files / a .zip of a folder (e.g. an Obsidian vault).</p>
        <div className="row">
          <a className="btn" href={`/api/workspaces/${wsId}/export`}>
            Download .zip
          </a>
          {can(ws.role, 'edit') && (
            <label className="btn">
              Import files…
              <input
                type="file"
                multiple
                accept=".md,.markdown,.zip"
                hidden
                data-testid="import-input"
                onChange={async (e) => {
                  const files = [...(e.target.files ?? [])];
                  if (!files.length) return;
                  const fd = new FormData();
                  files.forEach((f) => fd.append('files', f, f.name));
                  try {
                    const r = await api<{ created: number; updated: number; unchanged: number; skipped: string[] }>(`/api/workspaces/${wsId}/import`, {
                      method: 'POST',
                      body: fd,
                    });
                    toast(
                      `Imported: ${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`,
                      'success',
                    );
                    void qc.invalidateQueries({ queryKey: ['tree', wsId] });
                  } catch (err) {
                    toast(errMsg(err), 'error');
                  }
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
      </section>

      {isAdmin && (
        <section className="card">
          <h2>Git sync</h2>
          <p className="muted small">Push this workspace as Markdown files to a Git repository (docs-as-code), or pull changes made there.</p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const { token, ...rest } = gitForm;
              void act(() => put(`/api/workspaces/${wsId}/git`, token ? { ...rest, token } : rest), 'Git settings saved').then(() => refetchGit());
            }}
          >
            <label className="field">
              <span>Repository URL (https)</span>
              <input
                value={gitForm.remote}
                onChange={(e) => setGitForm({ ...gitForm, remote: e.target.value })}
                placeholder="https://github.com/acme/docs.git"
              />
            </label>
            <div className="row">
              <label className="field grow">
                <span>Branch</span>
                <input value={gitForm.branch} onChange={(e) => setGitForm({ ...gitForm, branch: e.target.value })} />
              </label>
              <label className="field grow">
                <span>Sub-folder (optional)</span>
                <input value={gitForm.subdir} onChange={(e) => setGitForm({ ...gitForm, subdir: e.target.value })} placeholder="docs" />
              </label>
            </div>
            <div className="row">
              <label className="field grow">
                <span>Username</span>
                <input value={gitForm.username} onChange={(e) => setGitForm({ ...gitForm, username: e.target.value })} />
              </label>
              <label className="field grow">
                <span>Access token {git?.hasToken && <em className="muted">(saved — leave blank to keep)</em>}</span>
                <input type="password" value={gitForm.token} onChange={(e) => setGitForm({ ...gitForm, token: e.target.value })} autoComplete="off" />
              </label>
            </div>
            <div className="row">
              <button className="btn">Save</button>
              {git && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={gitBusy}
                    onClick={async () => {
                      setGitBusy(true);
                      await act(async () => {
                        const r = await post(`/api/workspaces/${wsId}/git/push`, {});
                        toast(r.pushed ? `Pushed ${r.files} files (${String(r.commit).slice(0, 7)})` : 'Nothing to push — already up to date', 'success');
                      });
                      setGitBusy(false);
                      void refetchGit();
                    }}
                  >
                    Push now
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={gitBusy}
                    onClick={async () => {
                      setGitBusy(true);
                      await act(async () => {
                        const r = await post(`/api/workspaces/${wsId}/git/pull`, {});
                        toast(`Pulled: ${r.created} new, ${r.updated} updated`, 'success');
                        void qc.invalidateQueries({ queryKey: ['tree', wsId] });
                      });
                      setGitBusy(false);
                      void refetchGit();
                    }}
                  >
                    Pull now
                  </button>
                </>
              )}
            </div>
          </form>
          {git && (
            <p className="muted small">
              {git.lastPushAt && `Last push ${timeAgo(git.lastPushAt)}. `}
              {git.lastPullAt && `Last pull ${timeAgo(git.lastPullAt)}. `}
              {git.lastCommit && `Commit ${git.lastCommit.slice(0, 7)}.`}
              {git.lastError && <span className="error-text"> Last error: {git.lastError}</span>}
            </p>
          )}
        </section>
      )}

      {ws.role === 'owner' && (
        <section className="card danger-zone">
          <h2>Danger zone</h2>
          <button
            className="btn btn-danger"
            onClick={async () => {
              if (
                !(await confirm({
                  title: 'Delete workspace?',
                  message: `"${ws.name}" and all of its documents will be permanently deleted.`,
                  danger: true,
                  confirmText: 'Delete workspace',
                }))
              )
                return;
              await act(() => del(`/api/workspaces/${wsId}`), 'Workspace deleted');
              const other = workspaces.find((w) => w.id !== wsId);
              if (other) setCurrentId(other.id);
              navigate('/');
            }}
          >
            Delete workspace
          </button>
        </section>
      )}
    </div>
  );
}

export function AdminPage() {
  const toast = useToast();
  const { data: settings, refetch } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => get<{ signup: { mode: string; allowedDomains: string[] } }>('/api/admin/settings'),
  });
  const { data: users = [], refetch: refetchUsers } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () =>
      get<
        {
          id: string;
          email: string;
          username: string;
          displayName: string;
          isAdmin: boolean;
          emailVerified: boolean;
          disabledAt: string | null;
          createdAt: string;
        }[]
      >('/api/admin/users'),
  });
  const [inviteEmail, setInviteEmail] = useState('');
  const [domains, setDomains] = useState<string | null>(null);
  if (!settings) return <Spinner />;
  const save = async (mode: string, allowed: string[]) => {
    try {
      await put('/api/admin/settings', { signup: { mode, allowedDomains: allowed } });
      toast('Saved', 'success');
      void refetch();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };
  const domainText = domains ?? settings.signup.allowedDomains.join(', ');
  return (
    <div className="page narrow">
      <PageTitle>Administration</PageTitle>
      <h1>Administration</h1>
      <section className="card">
        <h2>Sign-up</h2>
        <label className="field">
          <span>Who can create an account?</span>
          <select value={settings.signup.mode} onChange={(e) => save(e.target.value, settings.signup.allowedDomains)} data-testid="signup-mode">
            <option value="open">Anyone</option>
            <option value="domain">Only e-mail addresses from allowed domains</option>
            <option value="invite">Invited people only</option>
            <option value="closed">Nobody (closed)</option>
          </select>
        </label>
        {settings.signup.mode === 'domain' && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void save(
                'domain',
                domainText
                  .split(',')
                  .map((d) => d.trim())
                  .filter(Boolean),
              );
            }}
          >
            <input
              className="grow"
              value={domainText}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="example.com, example.org"
              aria-label="Allowed domains"
            />
            <button className="btn">Save domains</button>
          </form>
        )}
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post('/api/admin/invites', { email: inviteEmail });
              toast(`Invitation sent to ${inviteEmail}`, 'success');
              setInviteEmail('');
            } catch (err) {
              toast(errMsg(err), 'error');
            }
          }}
        >
          <input
            className="grow"
            type="email"
            placeholder="Invite by e-mail"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            aria-label="Invite e-mail"
          />
          <button className="btn">Send invite</button>
        </form>
      </section>
      <section className="card">
        <h2>Users ({users.length})</h2>
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>E-mail</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.displayName} <span className="muted">@{u.username}</span>
                </td>
                <td>{u.email}</td>
                <td>
                  {u.isAdmin && <span className="badge">admin</span>}{' '}
                  {u.disabledAt ? <span className="badge badge-danger">disabled</span> : !u.emailVerified ? <span className="badge">unverified</span> : null}
                </td>
                <td className="row">
                  <button
                    className="btn btn-small"
                    onClick={() =>
                      patch(`/api/admin/users/${u.id}`, { isAdmin: !u.isAdmin }).then(
                        () => refetchUsers(),
                        (e) => toast(errMsg(e), 'error'),
                      )
                    }
                  >
                    {u.isAdmin ? 'Revoke admin' : 'Make admin'}
                  </button>
                  <button
                    className="btn btn-small"
                    onClick={() =>
                      patch(`/api/admin/users/${u.id}`, { disabled: !u.disabledAt }).then(
                        () => refetchUsers(),
                        (e) => toast(errMsg(e), 'error'),
                      )
                    }
                  >
                    {u.disabledAt ? 'Enable' : 'Disable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

interface StorageInfo {
  driver: 'fs' | 's3';
  libraryEnabled: boolean;
  library: string;
  manifest: string;
  versions: string;
  attachments: string;
  lastReconciledAt: string | null;
  documents: number;
  restrictedDocuments: number;
  keyProvider: string;
  keyWarning: boolean;
}

/** Shows admins exactly where this workspace's files live, so they can be found without the app. */
function StorageCard({ wsId }: { wsId: string }) {
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['storage', wsId], queryFn: () => get<StorageInfo>(`/api/workspaces/${wsId}/storage`) });
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const copy = (s: string) => navigator.clipboard?.writeText(s).then(() => toast('Copied', 'success'));
  const Row = ({ label, value, hint }: { label: string; value: string; hint: string }) => (
    <div className="storage-row">
      <div>
        <strong>{label}</strong>
        <div className="muted small">{hint}</div>
      </div>
      <code>{value}</code>
      <button className="btn btn-small" onClick={() => copy(value)} aria-label={`Copy ${label} location`}>
        Copy
      </button>
    </div>
  );
  return (
    <section className="card" data-testid="storage-card">
      <h2>Where your files are stored</h2>
      <p className="muted small">
        {data.driver === 's3' ? 'Object storage (S3-compatible).' : 'Local disk of the server.'} Every document also exists as a plain Markdown file you can
        open, copy or back up without Folio.
      </p>
      {data.libraryEnabled && (
        <>
          <Row label="Readable library" value={data.library} hint="Latest version of every document, as folders and .md files" />
          <Row label="Manifest" value={data.manifest} hint="Index of the library: ids, names and paths" />
        </>
      )}
      <Row label="Version history" value={data.versions} hint="Every saved version (used by the app)" />
      <Row label="Attachments" value={data.attachments} hint="Uploaded images and files" />
      <p className="muted small">
        {data.documents} documents{data.restrictedDocuments ? `, ${data.restrictedDocuments} restricted (stored encrypted as .md.folio-encrypted)` : ''}. Keys:{' '}
        {data.keyProvider}. Last full check: {data.lastReconciledAt ? timeAgo(data.lastReconciledAt) : 'not yet'}.
      </p>
      {data.keyWarning && (
        <p className="alert alert-error small" data-testid="key-warning">
          Restricted documents are encrypted with a key derived from APP_SECRET. Ask your administrator to set FOLIO_KEYS (and back it up): changing APP_SECRET
          would make restricted documents unreadable.
        </p>
      )}
      {data.libraryEnabled && (
        <button
          className="btn btn-small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await post<{ synced: number; removed: number }>(`/api/workspaces/${wsId}/storage/reconcile`, {});
              toast(`Library checked: ${r.synced} file(s) updated, ${r.removed} stray file(s) removed`, 'success');
              void refetch();
            } catch (e) {
              toast(errMsg(e), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          Check & repair library now
        </button>
      )}
    </section>
  );
}
