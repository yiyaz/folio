import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'lcov'],
      thresholds: { lines: 95, statements: 90, functions: 90, branches: 82 },
    },
  },
});
