import type { AuthUser } from '../context.js';

export interface UserRow {
  id: string;
  email: string;
  username: string;
  display_name: string;
  is_admin: boolean;
  email_verified_at: Date | null;
  prefs: Record<string, unknown>;
  avatar_key: string | null;
}

export const USER_COLUMNS = 'u.id, u.email, u.username, u.display_name, u.is_admin, u.email_verified_at, u.prefs, u.avatar_key';

export function toAuthUser(r: UserRow, via: AuthUser['via']): AuthUser {
  return {
    id: r.id,
    email: r.email,
    username: r.username,
    displayName: r.display_name,
    isAdmin: r.is_admin,
    emailVerified: !!r.email_verified_at,
    prefs: r.prefs ?? {},
    hasAvatar: !!r.avatar_key,
    via,
  };
}

export function actorOf(u: AuthUser) {
  return { id: u.id, username: u.username, displayName: u.displayName };
}

/** Public projection of a user, safe to show to other users. */
export const PUBLIC_USER_SQL = `json_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name, 'hasAvatar', u.avatar_key IS NOT NULL)`;
