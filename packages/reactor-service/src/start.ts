// packages/reactor-service/src/start.ts
//
// Production entry point. Run via `npm run service:start` (tsx src/start.ts).
// Loads .env, applies pending migrations, builds repositories, listens.

import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig } from './config.js';
import { createDbClient } from './db/client.js';
import { createRepositoriesProvider } from './db/repositories/index.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = createDbClient(config.databaseUrl);

  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  const repositories = createRepositoriesProvider(db);
  const app = await buildServer({ repositories, logLevel: config.logLevel });

  await app.listen({ host: config.httpHost, port: config.httpPort });
  app.log.info({ host: config.httpHost, port: config.httpPort }, 'reactor-service listening');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      app.log.info({ signal }, 'shutting down');
      await app.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('reactor-service failed to start:', err);
  process.exit(1);
});
