import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';

export type AuditAction =
  | 'document.view'
  | 'document.export'
  | 'document.revision_view'
  | 'document.classified'
  | 'document.declassified'
  | 'attachment.view'
  | 'permission.granted'
  | 'permission.revoked';

/**
 * Append-only audit trail. Failures to write it are logged loudly but don't fail the request:
 * availability of the document matters more than a missing log line, and the app log keeps it.
 */
export async function audit(
  ctx: AppContext,
  req: FastifyRequest,
  e: { action: AuditAction; resourceType: 'document' | 'folder' | 'attachment'; resourceId: string; workspaceId?: string; details?: Record<string, unknown> },
) {
  try {
    await ctx.db.query(
      `INSERT INTO audit_log (actor_id, action, resource_type, resource_id, workspace_id, ip, user_agent, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.user?.id ?? null,
        e.action,
        e.resourceType,
        e.resourceId,
        e.workspaceId ?? null,
        req.ip,
        req.headers['user-agent']?.slice(0, 300) ?? null,
        e.details ?? {},
      ],
    );
  } catch (err) {
    ctx.log.error({ err, audit: e, actor: req.user?.id }, 'failed to write audit log entry');
  }
}
