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
import { registerKaironPageRoute } from './routes/kaironPage.js';
import { registerKaironRunRoute } from './routes/kaironRun.js';
import { registerKaironSaveRoute } from './routes/kaironSave.js';
import { sharedKaironClient } from './kairon/client.js';
import { buildReactor } from './reactor/buildReactor.js';
import { createStreamingOpenRouter } from './kairon/openrouter.js';
import { createSampleLLM, SAMPLE_MODEL } from './kairon/sampleLlm.js';

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
  registerKaironPageRoute(app);
  registerKaironRunRoute(app, {
    defaultApiKey: () => process.env.OPENROUTER_API_KEY,
    createLLM: (config) => (config.model === SAMPLE_MODEL ? createSampleLLM(config) : createStreamingOpenRouter(config)),
    buildReactor: (llm) => buildReactor(llm, opts.repositories),
  });
  registerKaironSaveRoute(app, { api: () => sharedKaironClient() });

  return app;
}
