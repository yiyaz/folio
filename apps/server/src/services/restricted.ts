import { randomBytes } from 'node:crypto';
import { setFrontmatterField } from '@folio/markdown';
import type { AppContext } from '../context.js';
import { dekContext, isEncrypted, open, openWithDek, parse, seal, type Kind } from '../crypto/envelope.js';

export type Classification = 'standard' | 'restricted';

export interface KeyedDoc {
  id: string;
  classification: string;
  dek_wrapped: string | null;
  kek_id: string | null;
}

/**
 * Unwrapped data keys are cached briefly so a burst of autosaves doesn't call the key service
 * every time. Bounded in size and time; keyed by the wrapped key so rotation invalidates it.
 */
const DEK_TTL_MS = 5 * 60_000;
const DEK_CACHE_MAX = 1000;
const dekCache = new Map<string, { dek: Buffer; expires: number }>();

async function unwrapCached(ctx: AppContext, docId: string, wrapped: string, kekId: string): Promise<Buffer> {
  const hit = dekCache.get(wrapped);
  if (hit && hit.expires > Date.now()) return hit.dek;
  const dek = await ctx.keys.unwrap(wrapped, kekId, dekContext(docId));
  if (dekCache.size >= DEK_CACHE_MAX) dekCache.delete(dekCache.keys().next().value!);
  dekCache.set(wrapped, { dek, expires: Date.now() + DEK_TTL_MS });
  return dek;
}

export function clearDekCache() {
  dekCache.clear();
}

/** Create a fresh data key for a document. */
export async function newDataKey(ctx: AppContext, docId: string) {
  const dek = randomBytes(32);
  const wrapped = await ctx.keys.wrap(dek, dekContext(docId));
  dekCache.set(wrapped.wrapped, { dek, expires: Date.now() + DEK_TTL_MS });
  return { dek, ...wrapped };
}

async function docKey(ctx: AppContext, doc: KeyedDoc) {
  if (!doc.dek_wrapped || !doc.kek_id) throw new Error(`restricted document ${doc.id} has no data key`);
  return { dek: await unwrapCached(ctx, doc.id, doc.dek_wrapped, doc.kek_id), wrapped: doc.dek_wrapped, kekId: doc.kek_id };
}

export const isRestricted = (doc: { classification?: string | null }) => doc.classification === 'restricted';

/** Encrypt content for storage if the document is restricted; otherwise return it unchanged. */
export async function protect(ctx: AppContext, doc: KeyedDoc, plaintext: Buffer | string, kind: Kind = 'document'): Promise<Buffer | string> {
  if (!isRestricted(doc)) return plaintext;
  const { dek, wrapped, kekId } = await docKey(ctx, doc);
  return seal(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext), dek, { wrapped, kekId }, doc.id, kind);
}

/**
 * Decrypt stored data when it is an encrypted envelope. Detection is by content, not by the
 * document's current classification, so reads stay correct while a document changes class.
 */
export async function reveal(ctx: AppContext, docId: string, stored: Buffer): Promise<Buffer> {
  if (!isEncrypted(stored)) return stored;
  const env = parse(stored);
  const dek = await unwrapCached(ctx, env.doc, env.dek, env.kek);
  return openWithDek(env, dek, docId);
}

/** Decrypt with only the key provider: used by the admin CLI for recovery from storage. */
export const decryptFile = open;

/** Comment bodies on restricted documents are stored encrypted in the database. */
export async function protectComment(ctx: AppContext, doc: KeyedDoc, body: string): Promise<{ body: string; encrypted: boolean }> {
  if (!isRestricted(doc)) return { body, encrypted: false };
  return { body: (await protect(ctx, doc, body, 'comment')) as string, encrypted: true };
}

export async function revealComment(ctx: AppContext, docId: string, body: string, encrypted: boolean): Promise<string> {
  return encrypted ? (await reveal(ctx, docId, Buffer.from(body))).toString('utf8') : body;
}

/**
 * How a document appears in the readable library: plain Markdown with its id in the front
 * matter, or (restricted) the encrypted envelope exactly as stored.
 */
export async function renderLibraryEntry(_ctx: AppContext, doc: { id: string; classification: string }, stored: string) {
  if (isRestricted(doc) || isEncrypted(stored)) {
    return { suffix: '.md.folio-encrypted', body: stored, contentType: 'application/json' };
  }
  return { suffix: '.md', body: setFrontmatterField(stored, 'id', doc.id), contentType: 'text/markdown; charset=utf-8' };
}
