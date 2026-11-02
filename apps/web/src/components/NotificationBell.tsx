import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../api';
import { realtime } from '../realtime';
import type { Notification } from '../types';
import { Avatar, Menu, useToast } from './ui';
import { timeAgo } from '../util';

export function describe(n: Notification): string {
  const p = n.payload;
  switch (n.type) {
    case 'mention':
      return `${p.actor.displayName} mentioned you in ${p.documentName}`;
    case 'share':
      return `${p.actor.displayName} shared ${p.documentName} with you (${p.role})`;
    case 'comment':
      return `${p.actor.displayName} commented on ${p.documentName}`;
    case 'reply':
      return `${p.actor.displayName} replied on ${p.documentName}`;
    case 'workspace-invite':
      return `${p.actor.displayName} added you to ${p.workspaceName}`;
  }
}

export function NotificationBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => get<{ items: Notification[]; unread: number }>('/api/notifications'),
    refetchInterval: 120_000,
  });

  useEffect(
    () =>
      realtime.on((m) => {
        if (m.type === 'notification') {
          void qc.invalidateQueries({ queryKey: ['notifications'] });
          if (m.notification.type === 'workspace-invite') void qc.invalidateQueries({ queryKey: ['workspaces'] });
          toast(describe(m.notification));
        }
      }),
    [qc, toast],
  );

  const open = async (n: Notification) => {
    if (!n.readAt) await post(`/api/notifications/${n.id}/read`).catch(() => {});
    void qc.invalidateQueries({ queryKey: ['notifications'] });
    if (n.payload.documentId) navigate(`/d/${n.payload.documentId}${n.payload.commentId ? `?comment=${n.payload.commentId}` : ''}`);
  };

  return (
    <Menu
      align="right"
      trigger={(toggle) => (
        <button className="icon-btn bell" onClick={toggle} aria-label={`Notifications${data?.unread ? ` (${data.unread} unread)` : ''}`} data-testid="bell">
          🔔{!!data?.unread && <span className="bell-count">{data.unread}</span>}
        </button>
      )}
    >
      {(close) => (
        <div className="notif-menu">
          <div className="notif-head">
            <strong>Notifications</strong>
            <button
              className="link-btn"
              onClick={async () => {
                await post('/api/notifications/read-all');
                void qc.invalidateQueries({ queryKey: ['notifications'] });
              }}
            >
              Mark all read
            </button>
          </div>
          {!data?.items.length && <p className="muted pad">Nothing yet.</p>}
          {data?.items.slice(0, 15).map((n) => (
            <button key={n.id} className={`notif ${n.readAt ? '' : 'unread'}`} onClick={() => (close(), open(n))} data-testid="notification">
              <Avatar user={n.payload.actor} size={22} />
              <span>
                {describe(n)}
                {n.payload.excerpt && <span className="notif-excerpt">“{n.payload.excerpt}”</span>}
                <span className="muted small">{timeAgo(n.createdAt)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}
