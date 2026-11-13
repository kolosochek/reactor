// packages/reactor-service/src/routes/kaironPage.ts
//
// GET /kairon - the DEV-1364 forecast prototype chat page. Served from the
// service origin so the page posts to /reactor/execute without CORS. The
// file is read on every request, so page edits need no restart.
// GET /kairon/assets/kairon-render.mjs - the card renderer module the page
// imports (DEV-1376); one fixed file, no path from the request.
// GET /kairon/demo-phrases - the phrases the sample model answers (Task 16).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { DEMO_PHRASES } from '../kairon/sampleLlm.js';

const PAGE = fileURLToPath(new URL('../../web/kairon-forecast.html', import.meta.url));
const RENDER = fileURLToPath(new URL('../../web/kairon-render.mjs', import.meta.url));

export function registerKaironPageRoute(app: FastifyInstance): void {
  app.get('/kairon', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(await readFile(PAGE, 'utf8')),
  );
  app.get('/kairon/demo-phrases', async () => ({ phrases: [...DEMO_PHRASES] }));
  app.get('/kairon/assets/kairon-render.mjs', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').send(await readFile(RENDER, 'utf8')),
  );
}
