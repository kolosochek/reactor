// packages/reactor-service/src/__tests__/_helpers/testcontainerSetup.ts
//
// Spins an isolated postgres:16-alpine container per test suite. Returns a
// Drizzle client + cleanup. Migrations from ./drizzle/migrations are applied
// after the container is healthy.

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { createDbClient, type ReactorDb } from '../../db/client.js';

export interface TestContainerHandle {
  url: string;
  db: ReactorDb;
  stop: () => Promise<void>;
}

export async function startTestPostgres(): Promise<TestContainerHandle> {
  const container: StartedTestContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'reactor_test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/i, 2))
    .start();

  const port = container.getMappedPort(5432);
  const url = `postgres://test:test@127.0.0.1:${port}/reactor_test`;

  const db = createDbClient(url);
  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  return {
    url,
    db,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function truncateAll(db: ReactorDb): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE experience, lessons, ideas, predictions, tools RESTART IDENTITY CASCADE`);
}
