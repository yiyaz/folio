import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * A key-encryption key (KEK) service. Data keys (DEKs) are generated per document and only
 * ever stored wrapped by a KEK; the KEK itself never touches the database or object storage.
 */
export interface KeyProvider {
  /** Identifier of the KEK new data keys are wrapped with. */
  readonly activeKekId: string;
  wrap(dek: Buffer, context: string): Promise<{ wrapped: string; kekId: string }>;
  unwrap(wrapped: string, kekId: string, context: string): Promise<Buffer>;
  /** Short description for logs and the admin UI (never includes key material). */
  describe(): string;
}

export class KeyError extends Error {}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

/**
 * Keys held by the application, supplied as FOLIO_KEYS="id1:base64key,id2:base64key".
 * The first key is active; older keys stay listed until every DEK has been re-wrapped
 * (`admin-cli keys:rotate`). Without FOLIO_KEYS a key is derived from APP_SECRET.
 */
export class LocalKeyRing implements KeyProvider {
  private keys = new Map<string, Buffer>();
  readonly activeKekId: string;

  constructor(spec: string, appSecret: string) {
    const entries = spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!entries.length) {
      const derived = Buffer.from(hkdfSync('sha256', appSecret, 'folio-kek-salt', 'folio key-encryption key v1', 32));
      this.keys.set('app-secret', derived);
      this.activeKekId = 'app-secret';
      return;
    }
    for (const entry of entries) {
      const i = entry.indexOf(':');
      if (i < 1) throw new KeyError('FOLIO_KEYS entries must look like "<id>:<base64 32-byte key>"');
      const id = entry.slice(0, i);
      const key = Buffer.from(entry.slice(i + 1), 'base64');
      if (key.length !== 32) throw new KeyError(`FOLIO_KEYS key "${id}" must be 32 bytes (base64), got ${key.length}`);
      if (this.keys.has(id)) throw new KeyError(`FOLIO_KEYS has duplicate id "${id}"`);
      this.keys.set(id, key);
    }
    this.activeKekId = entries[0].slice(0, entries[0].indexOf(':'));
  }

  async wrap(dek: Buffer, context: string) {
    const kek = this.keys.get(this.activeKekId)!;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', kek, iv);
    c.setAAD(Buffer.from(context));
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return { wrapped: [b64(iv), b64(c.getAuthTag()), b64(ct)].join('.'), kekId: this.activeKekId };
  }

  async unwrap(wrapped: string, kekId: string, context: string) {
    const kek = this.keys.get(kekId);
    if (!kek) throw new KeyError(`unknown key-encryption key "${kekId}" (is it still listed in FOLIO_KEYS?)`);
    const [iv, tag, ct] = wrapped.split('.');
    try {
      const d = createDecipheriv('aes-256-gcm', kek, unb64(iv));
      d.setAAD(Buffer.from(context));
      d.setAuthTag(unb64(tag));
      return Buffer.concat([d.update(unb64(ct)), d.final()]);
    } catch {
      throw new KeyError('could not unwrap data key (wrong key or tampered data)');
    }
  }

  describe() {
    return `local key ring (${this.keys.size} key${this.keys.size === 1 ? '' : 's'}, active "${this.activeKekId}")`;
  }
}

/**
 * HashiCorp Vault Transit: the KEK lives in Vault and never leaves it; Vault handles key
 * versions and rotation (`vault write -f transit/keys/<key>/rotate`).
 */
export class VaultTransit implements KeyProvider {
  readonly activeKekId: string;
  constructor(
    private addr: string,
    private token: string,
    private keyName: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.activeKekId = `vault-transit:${keyName}`;
  }

  private async call(op: 'encrypt' | 'decrypt', body: object) {
    const r = await this.fetchImpl(`${this.addr.replace(/\/$/, '')}/v1/transit/${op}/${encodeURIComponent(this.keyName)}`, {
      method: 'POST',
      headers: { 'x-vault-token': this.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new KeyError(`Vault transit ${op} failed with HTTP ${r.status}`);
    return ((await r.json()) as { data: Record<string, string> }).data;
  }

  async wrap(dek: Buffer, context: string) {
    // the context is bound by the content encryption (AAD); Vault ciphertext carries the key version
    void context;
    const data = await this.call('encrypt', { plaintext: dek.toString('base64') });
    return { wrapped: data.ciphertext, kekId: this.activeKekId };
  }

  async unwrap(wrapped: string, kekId: string, context: string) {
    void context;
    if (kekId !== this.activeKekId) throw new KeyError(`data key was wrapped by "${kekId}", but this deployment uses "${this.activeKekId}"`);
    const data = await this.call('decrypt', { ciphertext: wrapped });
    return Buffer.from(data.plaintext, 'base64');
  }

  describe() {
    return `HashiCorp Vault transit key "${this.keyName}"`;
  }
}

export function createKeyProvider(cfg: {
  KEY_PROVIDER: string;
  FOLIO_KEYS: string;
  APP_SECRET: string;
  VAULT_ADDR?: string;
  VAULT_TOKEN?: string;
  VAULT_TRANSIT_KEY: string;
}): KeyProvider {
  if (cfg.KEY_PROVIDER === 'vault') {
    if (!cfg.VAULT_ADDR || !cfg.VAULT_TOKEN) throw new KeyError('KEY_PROVIDER=vault needs VAULT_ADDR and VAULT_TOKEN');
    return new VaultTransit(cfg.VAULT_ADDR, cfg.VAULT_TOKEN, cfg.VAULT_TRANSIT_KEY);
  }
  return new LocalKeyRing(cfg.FOLIO_KEYS, cfg.APP_SECRET);
}
