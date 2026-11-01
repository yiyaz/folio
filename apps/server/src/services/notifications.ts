import type { AppContext } from '../context.js';
import { one } from '../db.js';

export type NotificationType = 'mention' | 'share' | 'comment' | 'reply' | 'workspace-invite';

export interface NotificationPayload {
  actor: { id: string; username: string; displayName: string };
  documentId?: string;
  documentName?: string;
  workspaceId?: string;
  workspaceName?: string;
  commentId?: string;
  excerpt?: string;
  role?: string;
}

const SUBJECTS: Record<NotificationType, (p: NotificationPayload) => string> = {
  mention: (p) => `${p.actor.displayName} mentioned you in "${p.documentName}"`,
  share: (p) => `${p.actor.displayName} shared ${p.documentName ? `"${p.documentName}"` : 'a folder'} with you`,
  comment: (p) => `${p.actor.displayName} commented on "${p.documentName}"`,
  reply: (p) => `${p.actor.displayName} replied to your comment on "${p.documentName}"`,
  'workspace-invite': (p) => `${p.actor.displayName} added you to the workspace "${p.workspaceName}"`,
};

export async function notify(ctx: AppContext, userId: string, type: NotificationType, payload: NotificationPayload) {
  if (userId === payload.actor.id) return; // never notify yourself
  const row = await one(
    ctx.db,
    `INSERT INTO notifications (user_id, type, payload) VALUES ($1, $2, $3)
     RETURNING id, type, payload, read_at AS "readAt", created_at AS "createdAt"`,
    [userId, type, payload],
  );
  await ctx.bus.publish({ type: 'notification', userId, notification: row });

  const user = await one<{ email: string; prefs: Record<string, unknown> }>(ctx.db, 'SELECT email, prefs FROM users WHERE id = $1', [userId]);
  if (!user || user.prefs?.emailNotifications === false) return;
  const subject = SUBJECTS[type](payload);
  const link = payload.documentId
    ? `${ctx.cfg.PUBLIC_URL}/d/${payload.documentId}${payload.commentId ? `?comment=${payload.commentId}` : ''}`
    : ctx.cfg.PUBLIC_URL;
  const text = `${subject}\n\n${payload.excerpt ? `> ${payload.excerpt}\n\n` : ''}Open: ${link}\n\nYou can turn off e-mail notifications in your Folio settings.`;
  ctx.mailer.send({ to: user.email, subject, text }).catch((err) => ctx.log.warn({ err }, 'failed to send notification email'));
}
