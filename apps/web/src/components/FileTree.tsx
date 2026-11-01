import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { del, patch, post } from '../api';
import type { Tree, TreeDoc, TreeFolder } from '../types';
import { useDialogs } from './dialogs';
import { Menu, useToast } from './ui';
import { cx, errMsg } from '../util';

interface Node {
  folder: TreeFolder | null;
  folders: Node[];
  docs: TreeDoc[];
}

function buildTree(t: Tree): Node {
  const root: Node = { folder: null, folders: [], docs: [] };
  const nodes = new Map<string, Node>();
  for (const f of t.folders) nodes.set(f.id, { folder: f, folders: [], docs: [] });
  for (const f of t.folders) (f.parentId && nodes.get(f.parentId) ? nodes.get(f.parentId)! : root).folders.push(nodes.get(f.id)!);
  for (const d of t.documents) (d.folderId && nodes.get(d.folderId) ? nodes.get(d.folderId)! : root).docs.push(d);
  return root;
}

const EXPANDED_KEY = 'folio.tree.expanded';
function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

export function FileTree({ workspaceId, tree, canEdit, onShareFolder, onNewFromTemplate }: { workspaceId: string; tree: Tree; canEdit: boolean; onShareFolder: (f: TreeFolder) => void; onNewFromTemplate: (folderId: string | null) => void }) {
  const root = useMemo(() => buildTree(tree), [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { docId } = useParams();
  const { prompt, confirm } = useDialogs();
  const toast = useToast();

  const toggle = (id: string, force?: boolean) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (force ?? !n.has(id)) n.add(id);
      else n.delete(id);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...n]));
      } catch {
        /* ignore */
      }
      return n;
    });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tree', workspaceId] });
    void qc.invalidateQueries({ queryKey: ['names', workspaceId] });
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const newDoc = async (folderId: string | null) => {
    const name = await prompt({ title: 'New document', label: 'Document name', initial: 'Untitled', confirmText: 'Create' });
    if (!name) return;
    await run(async () => {
      const d = await post('/api/documents', { workspaceId, folderId, name });
      if (folderId) toggle(folderId, true);
      navigate(`/d/${d.id}`);
    });
  };

  const newFolder = async (parentId: string | null) => {
    const name = await prompt({ title: 'New folder', label: 'Folder name', confirmText: 'Create' });
    if (!name) return;
    await run(async () => {
      await post('/api/folders', { workspaceId, parentId, name });
      if (parentId) toggle(parentId, true);
    });
  };

  const onDrop = async (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    const raw = e.dataTransfer.getData('application/x-folio');
    if (!raw) return;
    const item = JSON.parse(raw) as { kind: 'doc' | 'folder'; id: string };
    if (item.kind === 'folder' && item.id === folderId) return;
    await run(() => (item.kind === 'doc' ? patch(`/api/documents/${item.id}`, { folderId }) : patch(`/api/folders/${item.id}`, { parentId: folderId })));
  };

  const dropProps = (target: string | null) =>
    canEdit
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes('application/x-folio')) return;
            e.preventDefault();
            e.stopPropagation();
            setDragOver(target ?? 'root');
          },
          onDragLeave: () => setDragOver(null),
          onDrop: (e: React.DragEvent) => onDrop(e, target),
        }
      : {};

  const dragProps = (kind: 'doc' | 'folder', id: string) =>
    canEdit
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData('application/x-folio', JSON.stringify({ kind, id }));
            e.dataTransfer.effectAllowed = 'move';
          },
        }
      : {};

  const renderNode = (n: Node, depth: number): React.ReactNode => (
    <>
      {n.folders.map((child) => {
        const f = child.folder!;
        const open = expanded.has(f.id);
        return (
          <li key={f.id}>
            <div className={cx('tree-row', dragOver === f.id && 'drop-target')} style={{ paddingLeft: 8 + depth * 14 }} {...dropProps(f.id)} {...dragProps('folder', f.id)} data-testid={`folder-${f.name}`}>
              <button className="tree-toggle" onClick={() => toggle(f.id)} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${f.name}`}>
                {open ? '▾' : '▸'}
              </button>
              <span className="tree-label" onClick={() => toggle(f.id)}>
                <span aria-hidden="true">📁 </span>
                {f.name}
              </span>
              {canEdit && (
                <Menu
                  align="right"
                  trigger={(open) => (
                    <button className="tree-more" onClick={open} aria-label={`Folder actions for ${f.name}`}>
                      ⋯
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <button onClick={() => (close(), newDoc(f.id))}>New document</button>
                      <button onClick={() => (close(), onNewFromTemplate(f.id))}>New from template…</button>
                      <button onClick={() => (close(), newFolder(f.id))}>New subfolder</button>
                      <button
                        onClick={async () => {
                          close();
                          const name = await prompt({ title: 'Rename folder', initial: f.name, confirmText: 'Rename' });
                          if (name && name !== f.name) await run(() => patch(`/api/folders/${f.id}`, { name }));
                        }}
                      >
                        Rename
                      </button>
                      <button onClick={() => (close(), onShareFolder(f))}>Share folder…</button>
                      <a href={`/api/workspaces/${workspaceId}/export?folderId=${f.id}`} onClick={close}>
                        Export as .zip
                      </a>
                      <button
                        className="danger"
                        onClick={async () => {
                          close();
                          if (await confirm({ title: 'Move folder to trash?', message: `"${f.name}" and everything in it will be moved to the trash.`, confirmText: 'Move to trash', danger: true }))
                            await run(() => del(`/api/folders/${f.id}`));
                        }}
                      >
                        Move to trash
                      </button>
                    </>
                  )}
                </Menu>
              )}
            </div>
            {open && <ul>{renderNode(child, depth + 1)}</ul>}
          </li>
        );
      })}
      {n.docs.map((d) => (
        <li key={d.id}>
          <NavLink to={`/d/${d.id}`} className={({ isActive }) => cx('tree-row tree-doc', (isActive || docId === d.id) && 'active')} style={{ paddingLeft: 22 + depth * 14 }} {...dragProps('doc', d.id)} title={d.title}>
            <span aria-hidden="true">📄 </span>
            {d.name}
          </NavLink>
        </li>
      ))}
    </>
  );

  return (
    <div className={cx('tree', dragOver === 'root' && 'drop-target')} {...dropProps(null)}>
      <div className="tree-head">
        <span>Documents</span>
        {canEdit && (
          <span className="tree-actions">
            <button className="icon-btn" onClick={() => newDoc(null)} title="New document" aria-label="New document" data-testid="new-doc">
              ＋
            </button>
            <button className="icon-btn" onClick={() => newFolder(null)} title="New folder" aria-label="New folder" data-testid="new-folder">
              🗀
            </button>
          </span>
        )}
      </div>
      <ul role="tree">{renderNode(root, 0)}</ul>
      {!tree.documents.length && !tree.folders.length && <p className="muted small pad">No documents yet.</p>}
    </div>
  );
}
