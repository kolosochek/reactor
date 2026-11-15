// packages/reactor-service/src/routes/kaironPage.ts
//
// GET /kairon - the DEV-1364 forecast prototype chat page. Served from the
// service origin so the page posts to /reactor/execute without CORS. The
// file is read on every request, so page edits need no restart.
// GET /kairon/assets/kairon-render.mjs - the card renderer module the page
// imports (DEV-1376); one fixed file, no path from the request.
// GET /kairon/demo-phrases - the phrases the sample model answers (Task 16).
// GET /kairon/assets/widgets/browser.mjs - the forecast widgets bundle (DEV-1380),
// read from the directory KAIRON_WIDGETS_DIST names; 404 when there is none, and
// the page then draws with its own renderers. One fixed file, no path from the request.
// GET /kairon/widgets - whether a bundle exists and of which build, so the page
// imports it only when it does and a missing bundle costs no failed request.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { DEMO_PHRASES } from '../kairon/sampleLlm.js';
import { widgetsDistDir } from '../kairon/widgetCatalog.js';

const PAGE = fileURLToPath(new URL('../../web/kairon-forecast.html', import.meta.url));
const RENDER = fileURLToPath(new URL('../../web/kairon-render.mjs', import.meta.url));

const WIDGETS_BUNDLE = 'browser.mjs';

export function registerKaironPageRoute(app: FastifyInstance): void {
  app.get('/kairon', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(await readFile(PAGE, 'utf8')),
  );
  app.get('/kairon/demo-phrases', async () => ({ phrases: [...DEMO_PHRASES] }));
  app.get('/kairon/assets/kairon-render.mjs', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').send(await readFile(RENDER, 'utf8')),
  );
  app.get('/kairon/widgets', async () => {
    const dir = widgetsDistDir(process.env);
    if (dir === null || !existsSync(join(dir, WIDGETS_BUNDLE)) || !existsSync(join(dir, 'manifest.json'))) return { bundle: null, buildId: null };
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { buildId?: unknown };
    return { bundle: `/kairon/assets/widgets/${WIDGETS_BUNDLE}`, buildId: typeof manifest.buildId === 'string' ? manifest.buildId : null };
  });
  app.get('/kairon/assets/widgets/browser.mjs', async (_request, reply) => {
    const dir = widgetsDistDir(process.env);
    if (dir === null) return reply.status(404).send({ error: 'No widgets bundle: KAIRON_WIDGETS_DIST is not set' });
    try {
      const bundle = await readFile(join(dir, WIDGETS_BUNDLE), 'utf8');
      return reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-store').send(bundle);
    } catch {
      return reply.status(404).send({ error: 'No widgets bundle: KAIRON_WIDGETS_DIST has no browser.mjs' });
    }
  });
}
