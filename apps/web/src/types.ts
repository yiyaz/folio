export type Role = 'viewer' | 'commenter' | 'editor' | 'admin' | 'owner';
export type EditorMode = 'live' | 'source' | 'split' | 'read';

export interface Me {
  id: string;
  email: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  emailVerified: boolean;
  hasAvatar: boolean;
  prefs: { editorMode?: EditorMode; keymap?: 'default' | 'vim' | 'emacs'; theme?: 'system' | 'light' | 'dark'; emailNotifications?: boolean; lineNumbers?: boolean };
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  hasAvatar: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  role: Role;
  memberCount: number;
}

export interface TreeFolder {
  id: string;
  parentId: string | null;
  name: string;
}
export interface TreeDoc {
  id: string;
  folderId: string | null;
  name: string;
  title: string;
  updatedAt: string;
}
export interface Tree {
  folders: TreeFolder[];
  documents: TreeDoc[];
}

export interface Doc {
  id: string;
  workspaceId: string;
  folderId: string | null;
  name: string;
  title: string;
  version: number;
  content: string;
  role: Role;
  sharedOnly: boolean;
  workspaceName: string;
  folderPath: { id: string; name: string }[];
  publicToken: string | null;
  updatedAt: string;
  createdAt: string;
  deletedAt: string | null;
  updatedByUser: PublicUser | null;
  createdByUser: PublicUser | null;
}

export interface Comment {
  id: string;
  parentId: string | null;
  body: string;
  anchorText: string | null;
  anchorStart: number | null;
  anchorEnd: number | null;
  resolvedAt: string | null;
  createdAt: string;
  author: PublicUser | null;
}

export interface Notification {
  id: string;
  type: 'mention' | 'share' | 'comment' | 'reply' | 'workspace-invite';
  payload: { actor: PublicUser; documentId?: string; documentName?: string; workspaceName?: string; commentId?: string; excerpt?: string; role?: string };
  readAt: string | null;
  createdAt: string;
}

export interface ClientConfig {
  plantumlServer: string | null;
  pyodideUrl: string;
  embedPatterns: string[];
  ai: boolean;
  maxUploadMb: number;
}
