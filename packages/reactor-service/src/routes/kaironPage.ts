// packages/reactor-service/src/routes/kaironPage.ts
//
// GET /kairon - the DEV-1364 forecast prototype chat page. Served from the
// service origin so the page posts to /reactor/execute without CORS. The
// file is read on every request, so page edits need no restart.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const PAGE = fileURLToPath(new URL('../../web/kairon-forecast.html', import.meta.url));

export function registerKaironPageRoute(app: FastifyInstance): void {
  app.get('/kairon', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(await readFile(PAGE, 'utf8')),
  );
}
