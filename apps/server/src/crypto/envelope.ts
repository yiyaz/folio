import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider } from './keys.js';
import { KeyError } from './keys.js';

/**
 * Self-contained encrypted file format used for restricted documents, their revisions,
 * attachments and library copies:
 *
 *   {"folio":"encrypted","v":1,"alg":"AES-256-GCM","doc":"<document id>","kind":"document",
 *    "kek":"<kek id>","dek":"<wrapped data key>","iv":"…","tag":"…","ct":"…"}
 *
 * The wrapped data key travels with the file, so it can be decrypted with nothing but the
 * key-encryption key (e.g. from a backup, without the database). The document id and kind are
 * authenticated (AAD): a file cannot be passed off as another document's content.
 */
export const MAGIC = '{"folio":"encrypted"';
export type Kind = 'document' | 'attachment' | 'comment';

export interface Envelope {
  folio: 'encrypted';
  v: 1;
  alg: 'AES-256-GCM';
  doc: string;
  kind: Kind;
  kek: string;
  dek: string;
  iv: string;
  tag: string;
  ct: string;
}

export const isEncrypted = (data: Buffer | string) => (typeof data === 'string' ? data : data.subarray(0, MAGIC.length).toString('utf8')).startsWith(MAGIC);
export const aad = (docId: string, kind: Kind) => Buffer.from(`folio:v1:${kind}:${docId}`);
export const dekContext = (docId: string) => `folio:dek:${docId}`;

export function seal(plaintext: Buffer, dek: Buffer, wrapped: { wrapped: string; kekId: string }, docId: string, kind: Kind): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  c.setAAD(aad(docId, kind));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const env: Envelope = {
    folio: 'encrypted',
    v: 1,
    alg: 'AES-256-GCM',
    doc: docId,
    kind,
    kek: wrapped.kekId,
    dek: wrapped.wrapped,
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  return JSON.stringify(env);
}

export function parse(data: Buffer | string): Envelope {
  let env: Envelope;
  try {
    env = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
  } catch {
    throw new KeyError('not a Folio encrypted file');
  }
  if (env.folio !== 'encrypted' || env.v !== 1 || env.alg !== 'AES-256-GCM') throw new KeyError('unsupported encrypted file format');
  return env;
}

export function openWithDek(env: Envelope, dek: Buffer, expectDoc?: string): Buffer {
  if (expectDoc && env.doc !== expectDoc) throw new KeyError('encrypted file belongs to a different document');
  try {
    const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(env.iv, 'base64'));
    d.setAAD(aad(env.doc, env.kind));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]);
  } catch {
    throw new KeyError('decryption failed (wrong key or tampered file)');
  }
}

/** Decrypt using only the key provider (the wrapped data key is inside the file). */
export async function open(data: Buffer | string, keys: KeyProvider, expectDoc?: string): Promise<Buffer> {
  const env = parse(data);
  const dek = await keys.unwrap(env.dek, env.kek, dekContext(env.doc));
  return openWithDek(env, dek, expectDoc);
}
