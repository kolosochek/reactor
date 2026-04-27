// packages/reactor-service/src/routes/health.ts
//
// GET /reactor/health - liveness probe. v0.1.0 returns { ok: true }
// without touching the DB; consumer probes (Docker healthcheck, extension
// 'is service alive?' check) only need the HTTP plane to respond.

import type { FastifyInstance } from 'fastify';

export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/reactor/health', async () => ({ ok: true }));
}
