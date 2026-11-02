import type { Config } from '../config.js';
import { FsStorage } from './fs.js';
import { S3Storage } from './s3.js';

/** Blob storage for Markdown files, revisions and attachments. */
export interface Storage {
  put(key: string, body: Buffer | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Health check used by /readyz. */
  ping(): Promise<void>;
}

export function createStorage(cfg: Config): Storage {
  if (cfg.STORAGE_DRIVER === 's3') {
    return new S3Storage({
      bucket: cfg.S3_BUCKET,
      region: cfg.S3_REGION,
      endpoint: cfg.S3_ENDPOINT,
      accessKeyId: cfg.S3_ACCESS_KEY_ID,
      secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
    });
  }
  return new FsStorage(cfg.STORAGE_FS_ROOT);
}

export class NotFoundInStorage extends Error {
  constructor(key: string) {
    super(`object not found: ${key}`);
  }
}

export const keys = {
  /**
   * Immutable content blob. Every save writes a new blob and the database row is switched to it
   * in the same transaction that bumps the version, so storage can never get ahead of the DB.
   */
  blob: (ws: string, doc: string, id: string) => `workspaces/${ws}/blobs/${doc}/${id}.md`,
  attachment: (ws: string, id: string) => `workspaces/${ws}/attachments/${id}`,
  avatar: (user: string) => `avatars/${user}`,
};
