// POST /kairon/save (DEV-1375, spec 5.3): the user's click saves one draft as
// an inactive Kairon forecast version. The server replays the draft lineage on
// the active forecast, creates the version with the replayed plan and, when the
// draft carries draws, PUTs its funding section. Nothing activates it. The fake
// API records the writes; no test writes to a stand.

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ManualDraw } from '../kairon/goals.js';
import { planHash, type DraftLineage } from '../kairon/lineage.js';
import { registerKaironSaveRoute } from '../routes/kaironSave.js';
import { baselineEvaluate, fakeKaironApi, fixtureDoc, readStage5, type WriteLog } from './_helpers/kaironFake.js';

const HASH = planHash(fixtureDoc);
const CONSTRUCTION = { type: 'cost_change' as const, lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 };
const COVER_GOAL = { type: 'funding_cover' as const, partnerId: 'cedar', fromMonth: '2026-09', months: 6 };
const coverBody = readStage5('cover-cedar.body.json') as { plan: unknown; draws: ManualDraw[] };
const releaseU2 = ['2026-11', '2027-06', '2028-01', '2028-06'].map((month) => ({ code: 'U2', month, amountMinor: '0' }));

function lineage(over: Partial<DraftLineage>): DraftLineage {
  return { activePlanHash: HASH, scenario: { type: 'free' }, leverPatch: null, steps: [], ...over };
}

function server(writes: WriteLog, fundingStatus?: number) {
  const app = Fastify({ logger: false });
  registerKaironSaveRoute(app, { api: () => fakeKaironApi(baselineEvaluate, { writes, fundingStatus }) });
  return app;
}

async function save(app: ReturnType<typeof server>, payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/kairon/save', payload });
  return { status: res.statusCode, json: res.json() as unknown };
}

describe('POST /kairon/save', () => {
  it('creates one draft version from the active forecast with the replayed plan', async () => {
    // SCENARIO: «Сохранить как черновик» on s2 v2 (construction +8 %, U2 released), no draws
    // INPUT: the v2 lineage, name «Стройка +8 %: v2»
    // EXPECTED: 200 { versionId draft-1, name }; one createVersion based on solstice-forecast-3 with s2-v2's plan; no putFunding
    const writes: WriteLog = [];
    const out = await save(server(writes), {
      name: 'Стройка +8 %: v2',
      lineage: lineage({ scenario: CONSTRUCTION, leverPatch: { name: 'v2', set: releaseU2 } }),
    });
    expect(out).toEqual({ status: 200, json: { versionId: 'draft-1', name: 'Стройка +8 %: v2' } });
    expect(writes).toEqual([
      {
        op: 'createVersion',
        args: [{ name: 'Стройка +8 %: v2', basedOnVersionId: 'solstice-forecast-3', payload: (readStage5('s2-v2.body.json') as { plan: unknown }).plan }],
      },
    ]);
  });

  it('puts the cover draws on the new version after creating it', async () => {
    // SCENARIO: the Cedar cover draft v1.1
    // INPUT: a lineage with one cover step carrying the recorded draws
    // EXPECTED: createVersion with the active plan, then putFunding on draft-1 with baseRevision 0 and the 6 cover draws
    const writes: WriteLog = [];
    const out = await save(server(writes), {
      name: 'Cedar покрывает 6 мес.',
      lineage: lineage({ steps: [{ type: 'cover', goal: COVER_GOAL, draws: coverBody.draws }] }),
    });
    expect(out).toEqual({ status: 200, json: { versionId: 'draft-1', name: 'Cedar покрывает 6 мес.' } });
    expect(writes).toEqual([
      { op: 'createVersion', args: [{ name: 'Cedar покрывает 6 мес.', basedOnVersionId: 'solstice-forecast-3', payload: coverBody.plan }] },
      { op: 'putFunding', args: ['draft-1', { baseRevision: 0, draws: coverBody.draws }] },
    ]);
  });

  it('refuses a lineage built on another active forecast without writing', async () => {
    // SCENARIO: Review Focus 2, the active forecast changed after the draft was built
    // INPUT: activePlanHash 'stale'
    // EXPECTED: 409 with the Russian refusal; no write
    const writes: WriteLog = [];
    const out = await save(server(writes), { name: 'x', lineage: lineage({ activePlanHash: 'stale' }) });
    expect(out).toEqual({ status: 409, json: { error: 'Активный прогноз изменился, начните новый сценарий' } });
    expect(writes).toEqual([]);
  });

  it('refuses a draft that changes the partners\' share target, without writing', async () => {
    // SCENARIO: a lever patch sets shareTarget; in Kairon the share target is a project setting, a version cannot hold it
    // INPUT: leverPatch with shareTarget equityShareBp 3000
    // EXPECTED: 422 with the Russian reason; no write
    const writes: WriteLog = [];
    const out = await save(server(writes), {
      name: 'x',
      lineage: lineage({ leverPatch: { name: 'v2', shareTarget: { equityShareBp: 3000 } } as DraftLineage['leverPatch'] }),
    });
    expect(out).toEqual({
      status: 422,
      json: { error: 'Черновик меняет целевую долю партнёров (shareTarget). Это настройка проекта, версия прогноза её не хранит; черновик не сохранён.' },
    });
    expect(writes).toEqual([]);
  });

  it('names the created version when the funding PUT is refused', async () => {
    // SCENARIO: the version was created, then Kairon refused its draws
    // INPUT: the cover lineage; the funding PUT answers 409
    // EXPECTED: 409 with Kairon's message and versionId draft-1, so the page says a draft exists without its draws
    const writes: WriteLog = [];
    const out = await save(server(writes, 409), {
      name: 'Cedar покрывает 6 мес.',
      lineage: lineage({ steps: [{ type: 'cover', goal: COVER_GOAL, draws: coverBody.draws }] }),
    });
    expect(out).toEqual({
      status: 409,
      json: {
        error: 'Черновик draft-1 создан без траншей: Kairon ответил 409: The funding section changed since you read it',
        versionId: 'draft-1',
      },
    });
  });
});
