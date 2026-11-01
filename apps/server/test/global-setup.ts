import type { TestProject } from 'vitest/node';

/**
 * Provides a Postgres server for the integration tests.
 * - TEST_DATABASE_URL set: use that server (CI service container, local docker).
 * - otherwise: start a throwaway container with Testcontainers.
 * Every test file then creates its own database on that server.
 */
export default async function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('pgUrl', process.env.TEST_DATABASE_URL);
    return;
  }
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer(process.env.TEST_PG_IMAGE ?? 'postgres:16-alpine').start();
  project.provide('pgUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}
