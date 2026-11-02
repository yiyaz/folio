import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Storage } from '../src/storage/s3.js';
import { createDoc, createTestEnv, personalWorkspace, signup, type TestEnv } from './helpers.js';

/**
 * Runs the S3 driver against an S3-compatible server. Uses TEST_S3_ENDPOINT if set,
 * otherwise starts adobe/s3mock with Testcontainers. Skipped when neither is possible.
 */
let endpoint = process.env.TEST_S3_ENDPOINT ?? '';
let stop: (() => Promise<unknown>) | null = null;

beforeAll(async () => {
  if (endpoint) return;
  try {
    process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
    const { GenericContainer, Wait } = await import('testcontainers');
    const c = await new GenericContainer(process.env.TEST_S3_IMAGE ?? 'adobe/s3mock:latest')
      .withExposedPorts(9090)
      .withWaitStrategy(Wait.forHttp('/', 9090).forStatusCodeMatching((s) => s < 500))
      .start();
    endpoint = `http://${c.getHost()}:${c.getMappedPort(9090)}`;
    stop = () => c.stop();
  } catch (e) {
    console.warn('S3 tests skipped: no S3 endpoint available', (e as Error).message);
  }
}, 180_000);
afterAll(async () => {
  await stop?.();
});

describe('S3 storage driver', () => {
  it('stores, reads, checks and deletes objects (creating the bucket on demand)', async (ctx) => {
    if (!endpoint) return ctx.skip();
    const s = new S3Storage({ bucket: `folio-${Date.now()}`, region: 'us-east-1', endpoint, accessKeyId: 'x', secretAccessKey: 'y', forcePathStyle: true });
    await s.ping();
    await s.put('workspaces/w/docs/d.md', '# hi', 'text/markdown');
    expect((await s.get('workspaces/w/docs/d.md')).toString()).toBe('# hi');
    expect(await s.exists('workspaces/w/docs/d.md')).toBe(true);
    await s.delete('workspaces/w/docs/d.md');
    expect(await s.exists('workspaces/w/docs/d.md')).toBe(false);
    await expect(s.get('nope')).rejects.toThrow(/not found/);
  });

  describe('full app on S3', () => {
    let env: TestEnv | null = null;
    beforeAll(async () => {
      if (!endpoint) return;
      env = await createTestEnv({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: endpoint,
        S3_BUCKET: `folio-app-${Date.now()}`,
        S3_ACCESS_KEY_ID: 'x',
        S3_SECRET_ACCESS_KEY: 'y',
      });
    });
    afterAll(async () => {
      await env?.close();
    });

    it('creates, saves and reads documents through S3', async (ctx) => {
      if (!env) return ctx.skip();
      const u = await signup(env.app, 's3user');
      const ws = await personalWorkspace(u);
      const d = await createDoc(u, ws, 'On S3', 'one');
      await u.put(`/api/documents/${d.id}/content`, { content: 'two', baseVersion: 1 });
      expect((await u.get(`/api/documents/${d.id}`)).data.content).toBe('two');
      expect((await env.app.inject('/readyz')).statusCode).toBe(200);
    });
  });
});
