import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Storage } from './index.js';
import { NotFoundInStorage } from './index.js';

export class FsStorage implements Storage {
  private root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('invalid storage key');
    return p;
  }

  async put(key: string, body: Buffer | string): Promise<void> {
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    // write-then-rename so readers never observe a half-written file
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, p);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (e: any) {
      if (e.code === 'ENOENT') throw new NotFoundInStorage(key);
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async ping(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.access(this.root, fs.constants?.W_OK ?? 2);
  }
}
