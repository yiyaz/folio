import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestEnv, type TestEnv } from './helpers.js';

describe('single-page app serving', () => {
  let env: TestEnv;
  let dist: string;
  beforeAll(async () => {
    dist = mkdtempSync(path.join(os.tmpdir(), 'folio-dist-'));
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Folio</title>');
    // regression: files named index-*.js must not be answered with index.html
    writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>');
    env = await createTestEnv({ WEB_DIST: dist });
  });
  afterAll(async () => {
    await env.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('serves hashed assets with long-lived caching', async () => {
    const r = await env.app.inject('/assets/index-abc123.js');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('javascript');
    expect(r.body).toBe('console.log(1)');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to index.html for client-side routes, not for the API', async () => {
    for (const p of ['/', '/d/123', '/p/token', '/settings']) {
      const r = await env.app.inject(p);
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('<title>Folio</title>');
      expect(r.headers['cache-control']).toBe('no-cache');
    }
    const api = await env.app.inject('/api/unknown');
    expect(api.statusCode).toBe(404);
    expect(api.json().error).toBe('not_found');
  });

  it('sends a strict content security policy', async () => {
    const csp = (await env.app.inject('/')).headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
  });
});
