import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { extractZip, parseArgs, zipMarkdownDir, Api } from '../src/lib.js';

describe('cli helpers', () => {
  it('parses flags', () => {
    expect(parseArgs(['push', 'docs', '--workspace', 'w1', '--dry', '--folder=f'])).toEqual({ _: ['push', 'docs'], flags: { workspace: 'w1', dry: true, folder: 'f' } });
  });

  it('zips only markdown files and skips hidden folders', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'folio-cli-'));
    mkdirSync(path.join(dir, 'a/.git'), { recursive: true });
    writeFileSync(path.join(dir, 'a/one.md'), '1');
    writeFileSync(path.join(dir, 'a/.git/x.md'), 'x');
    writeFileSync(path.join(dir, 'pic.png'), 'p');
    writeFileSync(path.join(dir, 'two.markdown'), '2');
    const { files } = await zipMarkdownDir(dir);
    expect(files).toEqual(['a/one.md', 'two.markdown']);
  });

  it('extracts zips without escaping the target directory', async () => {
    const zip = new JSZip();
    zip.file('Guides/Install.md', '# hi');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'folio-cli-'));
    expect(await extractZip(await zip.generateAsync({ type: 'nodebuffer' }), dir)).toEqual(['Guides/Install.md']);
    expect(readFileSync(path.join(dir, 'Guides/Install.md'), 'utf8')).toBe('# hi');
    // entries with ".." never escape the target directory
    const evil = new JSZip();
    evil.file('../../escape.md', 'x');
    const written = await extractZip(await evil.generateAsync({ type: 'nodebuffer' }), dir);
    for (const w of written) expect(path.resolve(dir, w).startsWith(dir)).toBe(true);
  });

  it('sends the bearer token and surfaces API errors', async () => {
    const seen: any[] = [];
    const fake = (async (url: string, init: any) => {
      seen.push({ url, auth: init.headers.authorization });
      return new Response(JSON.stringify({ message: 'nope' }), { status: 403 });
    }) as unknown as typeof fetch;
    const api = new Api({ url: 'https://folio.test', token: 't0k' }, fake);
    await expect(api.json('GET', '/api/workspaces')).rejects.toThrow('GET /api/workspaces failed (403): nope');
    expect(seen[0]).toEqual({ url: 'https://folio.test/api/workspaces', auth: 'Bearer t0k' });
  });
});
