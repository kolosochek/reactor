// packages/reactor-service/src/routes/kaironSave.ts
//
// POST /kairon/save (DEV-1375, spec 5.3): the user's «Сохранить как черновик»
// click saves one draft as an inactive Kairon forecast version. The server
// replays the draft lineage on the active forecast (so the saved version is the
// body that was scored; a draft that changes the project's share target is
// refused, since a version cannot hold it), creates the version based on the active one with the
// replayed plan, and, when the draft carries draws, PUTs the whole funding
// section with the revision the create returned. Nothing activates the version:
// activation stays a Kairon action of the user.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { rulesOf } from '../kairon/activities.js';
import { loadDocument, readBaseline } from '../kairon/baseline.js';
import type { HttpResult, KaironApi } from '../kairon/client.js';
import { DraftLineageSchema, replayLineage, STALE_LINEAGE } from '../kairon/lineage.js';

const SaveBody = z.object({ name: z.string().min(1).max(120), lineage: DraftLineageSchema });

const Created = z.object({ id: z.string().min(1), fundingRevision: z.number().int() });

const SHARE_TARGET_NOT_SAVED =
  'Черновик меняет целевую долю партнёров (shareTarget). Это настройка проекта, версия прогноза её не хранит; черновик не сохранён.';

export interface KaironSaveDeps {
  api(): KaironApi;
}

function kaironMessage(result: HttpResult): string {
  const message = (result.json as { message?: unknown } | null)?.message;
  return `Kairon ответил ${result.status}: ${typeof message === 'string' ? message : JSON.stringify(result.json)}`;
}

export function registerKaironSaveRoute(app: FastifyInstance, deps: KaironSaveDeps): void {
  app.post('/kairon/save', async (request, reply) => {
    const parsed = SaveBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { name, lineage } = parsed.data;
    const api = deps.api();
    const b = await readBaseline(api);
    const doc = await loadDocument(api, b);
    const replayed = replayLineage(doc, rulesOf(b), lineage);
    if (replayed.body === null) {
      const stale = replayed.errors.includes(STALE_LINEAGE);
      return reply.status(stale ? 409 : 422).send({ error: replayed.errors.join('; ') });
    }
    // The share target is a project setting in Kairon (settings.funding.shareTarget); a version cannot carry it,
    // so a saved version would differ from the scored card.
    if (replayed.body.shareTarget !== undefined) return reply.status(422).send({ error: SHARE_TARGET_NOT_SAVED });
    const created = await api.createVersion({ name, basedOnVersionId: b.forecastVersion.id, payload: replayed.body.plan });
    if (created.status !== 200 && created.status !== 201) {
      return reply.status(created.status).send({ error: kaironMessage(created) });
    }
    const version = Created.parse(created.json);
    if (replayed.body.draws !== undefined) {
      const funded = await api.putFunding(version.id, { baseRevision: version.fundingRevision, draws: replayed.body.draws });
      if (funded.status !== 200) {
        return reply
          .status(funded.status)
          .send({ error: `Черновик ${version.id} создан без траншей: ${kaironMessage(funded)}`, versionId: version.id });
      }
    }
    return { versionId: version.id, name };
  });
}
