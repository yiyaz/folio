import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: true,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/main.ts', 'src/telemetry.ts', 'src/migrate-cli.ts'],
      reporter: ['text-summary', 'lcov'],
      // ratchet: raise these as coverage improves, never lower them
      thresholds: { lines: 80, statements: 77, functions: 76, branches: 64 },
    },
  },
});
