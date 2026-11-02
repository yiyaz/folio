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
    const p = this.resolve(key);
    await fs.rm(p, { force: true });
    // prune now-empty directories so the readable library doesn't accumulate empty folders
    for (let dir = path.dirname(p); dir.startsWith(this.root + path.sep); dir = path.dirname(dir)) {
      try {
        await fs.rmdir(dir);
      } catch {
        break;
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    // the prefix may end inside a directory name ("library/ML Plat") or at a separator
    const dirPart = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
    const start = dirPart ? this.resolve(dirPart) : this.root;
    const out: string[] = [];
    const walk = async (abs: string) => {
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch (e: any) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
      for (const e of entries) {
        const p = path.join(abs, e.name);
        if (e.isDirectory()) await walk(p);
        else if (!e.name.endsWith('.tmp')) {
          const key = path.relative(this.root, p).split(path.sep).join('/');
          if (key.startsWith(prefix)) out.push(key);
        }
      }
    };
    await walk(start);
    return out.sort();
  }

  locate(key: string): string {
    if (!key) return this.root;
    // keep a trailing separator for "directory" keys so callers can tell them apart
    return this.resolve(key) + (key.endsWith('/') ? path.sep : '');
  }

  async ping(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.access(this.root, fs.constants?.W_OK ?? 2);
  }
}
