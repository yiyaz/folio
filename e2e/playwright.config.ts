import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const MAIL_DIR = path.resolve(import.meta.dirname, '../.mail/e2e');
const dbUrl = process.env.E2E_DATABASE_URL ?? 'postgres://folio:folio@localhost:5432/folio_e2e';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  webServer: {
    command: 'node e2e/start-server.mjs',
    cwd: path.resolve(import.meta.dirname, '..'),
    url: `http://localhost:${PORT}/readyz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      DATABASE_URL: dbUrl,
      WEB_DIST: 'apps/web/dist',
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: '.data/e2e-storage',
      MAIL_TRANSPORT: `file:${MAIL_DIR}`,
      REQUIRE_EMAIL_VERIFICATION: 'true',
      RATE_LIMIT_AUTH_PER_MIN: '1000',
      PUBLIC_URL: `http://localhost:${PORT}`,
      LOG_LEVEL: 'warn',
      APP_SECRET: 'e2e-secret-e2e-secret-e2e-secret',
      // deterministic stand-in for the language model
      AI_PROVIDER: 'fake',
    },
  },
});
