// packages/reactor-service/src/server.ts
//
// Fastify factory. Returns the app instance ready for `.listen()` (start.ts)
// or `.inject()` (tests). Routes register inside this factory so wiring stays
// single-source-of-truth.

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { RepositoriesProvider } from '@kolosochek/reactor-core';
import { registerExecuteRoute } from './routes/execute.js';
import { registerExperienceRoute } from './routes/experience.js';
import { registerHealthRoute } from './routes/health.js';

export interface BuildServerOptions {
  repositories: RepositoriesProvider;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: opts.logLevel ?? 'info' },
  });

  await app.register(cors, { origin: '*' });

  registerHealthRoute(app);
  registerExperienceRoute(app, opts.repositories);
  registerExecuteRoute(app, opts.repositories);

  return app;
}
