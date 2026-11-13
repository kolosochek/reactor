// The forecast prototype's reactor activities with a fake Kairon API and a
// scripted LLM (DEV-1364): baseline, propose with retry, score, explain.

import { describe, expect, it, vi } from 'vitest';
import type { ActivityContext, LLMCompletionRequest, LLMCompletionResponse, LLMProvider } from '@kolosochek/reactor-core';
import { createKaironActivities } from '../kairon/activities.js';
import type { Baseline } from '../kairon/baseline.js';
import type { KaironLLMRequest } from '../kairon/openrouter.js';
import { canonicalJson, planHash, type DraftLineage } from '../kairon/lineage.js';
import {
  baselineEvaluate,
  fakeKaironApi as fakeApi,
  fixtureDoc,
  readFixture as readJson,
  stage5Evaluate,
} from './_helpers/kaironFake.js';

const delay3Patch = readJson('patches/patch-delay-3.json') as Record<string, unknown>;

function scriptedLlm(replies: Array<string | Pick<LLMCompletionResponse, 'content' | 'finishReason'>>) {
  const queue = [...replies];
  const complete = vi.fn<[LLMCompletionRequest], Promise<LLMCompletionResponse>>(async () => {
    const next = queue.shift() ?? '{}';
    return typeof next === 'string' ? { content: next, model: 'scripted' } : { ...next, model: 'scripted' };
  });
  const llm: LLMProvider = { name: 'scripted', complete };
  return Object.assign(llm, { complete });
}

function ctxWith(llm: LLMProvider): ActivityContext {
  return { state: {}, llm };
}

async function loadBaseline(): Promise<Baseline> {
  const activities = createKaironActivities(fakeApi(baselineEvaluate));
  return (await activities['kairon.baseline']({}, ctxWith(scriptedLlm([])))) as Baseline;
}

describe('kairon.baseline', () => {
  it('reads the closed month, derived lines, promise and current IRR from the server', async () => {
    // SCENARIO: the first step of every chat turn
    // INPUT: fake API serving Forecast v3 and the approved budget, recorded {} evaluations
    // EXPECTED: closed through 2026-08, no derived lines, promise 18.91 / 20.15 %, current 23.55 / 27.14 %, R1 open cells = its 20 non-zero open months
    const b = await loadBaseline();
    expect(b.closedThrough).toBe('2026-08');
    expect(b.derivedLineCodes).toEqual([]);
    expect(b.forecastVersion).toEqual({ id: 'solstice-forecast-3', name: 'Forecast v3' });
    expect(b.approved.partners.map((p) => p.irr)).toEqual([0.18908679415677998, 0.20151451891859543]);
    expect(b.active.partners.map((p) => p.irr)).toEqual([0.23551969945622878, 0.2713521891177301]);
    expect(b.lines).toHaveLength(45);
    expect(b.lines.find((l) => l.code === 'R1')?.openCells).toEqual({
      '2026-09': '1467235793', '2026-10': '290412822', '2026-11': '704558916', '2026-12': '763755345',
      '2027-01': '715846025', '2027-02': '1290993078', '2027-03': '1083083331', '2027-04': '787212690',
      '2027-05': '864559344', '2027-06': '603594037', '2027-07': '846409119', '2027-08': '1107374426',
      '2027-09': '1112681545', '2027-10': '1083083331', '2027-11': '1048177996', '2027-12': '603594037',
      '2028-01': '514799394', '2028-02': '1249946876', '2028-04': '51094805595', '2028-06': '103071155910',
    });
    expect(b.lines.find((l) => l.code === 'D1')?.openCells).toEqual({});
  });

  it('reads the partners with their agreed shares and the approved plan', async () => {
    // SCENARIO: stage 5 red lines need the partners' shares and the diff view needs the approved plan (DEV-1375)
    // INPUT: fake API with settings.funding.partners; a fake API without them
    // EXPECTED: Solstice 0.3 and Cedar 0.7 in settings order; the approved plan's 45 lines over 2024-04..2028-09; no partners without settings
    const activities = createKaironActivities(fakeApi(baselineEvaluate, { partners: true }));
    const b = (await activities['kairon.baseline']({}, ctxWith(scriptedLlm([])))) as Baseline;
    expect(b.partners).toEqual([
      { partnerId: 'solstice', name: 'Solstice Sponsor', sharePct: 0.3 },
      { partnerId: 'cedar', name: 'Cedar Partners', sharePct: 0.7 },
    ]);
    expect(b.approvedPlan.lines).toHaveLength(45);
    expect(b.approvedPlan.monthRange).toEqual({ from: '2024-04', to: '2028-09' });
    expect((await loadBaseline()).partners).toEqual([]);
  });
});

describe('kairon.proposeVariants', () => {
  it('feeds a closed-month error back to the LLM and returns the corrected variant', async () => {
    // SCENARIO: the LLM's first answer shifts a line inside the closed period
    // INPUT: reply 1 shifts R1 from 2026-07; reply 2 is the recorded delay-3 patch
    // EXPECTED: 2 LLM calls, the 2nd prompt carries the R1 error, 1 valid variant, attempts log both
    const b = await loadBaseline();
    const bad = { variants: [{ id: 'v1', title: 't', rationale: 'r', levers: [], patch: { shift: [{ lineCodes: ['R1'], fromMonth: '2026-07', byMonths: 3 }] } }], openQuestions: [] };
    const { name: _name, ...good } = delay3Patch;
    const fixed = { variants: [{ id: 'v1', title: 'Сдвиг на 3 мес.', rationale: 'r', levers: [], patch: good }], openQuestions: ['A1?'] };
    const llm = scriptedLlm([`Here you go: ${JSON.stringify(bad)}`, JSON.stringify(fixed)]);
    const activities = createKaironActivities(fakeApi(baselineEvaluate));

    const out = (await activities['kairon.proposeVariants']({ scenario: 'kolaudace +3', baseline: b }, ctxWith(llm))) as {
      variants: Array<{ id: string }>;
      rejected: unknown[];
      openQuestions: string[];
      attempts: Array<{ attempt: number; errors: string[] }>;
    };

    expect(llm.complete).toHaveBeenCalledTimes(2);
    const secondCall = llm.complete.mock.calls[1]?.[0];
    expect(secondCall?.messages.at(-1)?.content).toContain(
      'v1: R1: the patch changes closed months 2026-07, 2026-08 (closed through 2026-08)',
    );
    expect(out.variants.map((v) => v.id)).toEqual(['v1']);
    expect(out.rejected).toEqual([]);
    expect(out.openQuestions).toEqual(['A1?']);
    expect(out.attempts).toEqual([
      { attempt: 1, errors: ['v1: R1: the patch changes closed months 2026-07, 2026-08 (closed through 2026-08); start the change at 2026-09 or later'] },
      { attempt: 2, errors: [] },
    ]);
  });
});

describe('kairon.proposeVariants on a stated scenario (stage 5)', () => {
  const CONSTRUCTION = { type: 'cost_change' as const, lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 };
  const releaseU2 = ['2026-11', '2027-06', '2028-01', '2028-06'].map((month) => ({ code: 'U2', month, amountMinor: '0' }));
  const r1 = (factorPpm: number) => ({ lineCodes: ['R1'], fromMonth: '2026-09', factorPpm });
  const empty = { stretch: [], shift: [], extend: [], scale: [], set: [], monthRangeTo: null, shareTarget: null };
  const levers = JSON.stringify({
    variants: [
      { id: 'v2', title: 'Резерв U2', rationale: 'r', levers: ['резерв'], patch: { ...empty, set: releaseU2 } },
      { id: 'v3', title: 'Цены +3 %', rationale: 'r', levers: ['цены'], patch: { ...empty, scale: [r1(1_030_000)] } },
      { id: 'v4', title: 'Резерв и цены', rationale: 'r', levers: ['резерв', 'цены'], patch: { ...empty, scale: [r1(1_023_000)], set: releaseU2 } },
    ],
    openQuestions: [],
  });

  it('builds v1 on the server and asks the LLM for the lever variants only', async () => {
    // SCENARIO: «Стройка дорожает на 8 % с 2026-09», count 4
    // INPUT: scenarioSpec cost_change D5, D8 × 1.08; the scripted LLM returns v2..v4
    // EXPECTED: ids v1..v4; v1 = the scenario alone with leverPatch null; one LLM call asking for 3 variants v2, v3, v4
    const b = await loadBaseline();
    const llm = scriptedLlm([levers]);
    const out = (await createKaironActivities(fakeApi(baselineEvaluate))['kairon.proposeVariants'](
      { scenario: 'Стройка дорожает на 8 % с 2026-09', baseline: b, count: 4, scenarioSpec: CONSTRUCTION, section: 'S2' },
      ctxWith(llm),
    )) as { section: string; variants: Array<{ id: string; parentId: string | null; lineage: DraftLineage }> };

    expect(out.section).toBe('S2');
    expect(out.variants.map((v) => [v.id, v.parentId])).toEqual([['v1', null], ['v2', null], ['v3', null], ['v4', null]]);
    expect(out.variants[0]?.lineage).toEqual({ activePlanHash: planHash(fixtureDoc), scenario: CONSTRUCTION, leverPatch: null, steps: [] });
    expect(out.variants[1]?.lineage.leverPatch).toEqual({ name: 'v2', set: releaseU2 });
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(llm.complete.mock.calls[0]?.[0].messages[0]?.content).toContain('Return exactly 3 variants with ids v2, v3, v4.');
  });

  it('keeps the stage 4 delay variant and gives it a free lineage', async () => {
    // SCENARIO: regression; the kolaudace phrase stays a free scenario
    // INPUT: one reply with the recorded delay-3 patch as v1
    // EXPECTED: v1 with the whole patch as its lever patch and scenario free
    const b = await loadBaseline();
    const { name: _name, ...good } = delay3Patch;
    const llm = scriptedLlm([JSON.stringify({ variants: [{ id: 'v1', title: 't', rationale: 'r', levers: [], patch: good }], openQuestions: [] })]);
    const out = (await createKaironActivities(fakeApi(baselineEvaluate))['kairon.proposeVariants'](
      { scenario: 'kolaudace +3', baseline: b, count: 1 },
      ctxWith(llm),
    )) as { variants: Array<{ id: string; lineage: DraftLineage }> };
    expect(out.variants.map((v) => v.id)).toEqual(['v1']);
    expect(out.variants[0]?.lineage).toEqual({
      activePlanHash: planHash(fixtureDoc),
      scenario: { type: 'free' },
      leverPatch: { ...good, name: 'v1' },
      steps: [],
    });
  });
});

describe('kairon.buildGoalDrafts', () => {
  const HASH = planHash(fixtureDoc);
  const CONSTRUCTION = { type: 'cost_change' as const, lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 };
  const releaseU2 = ['2026-11', '2027-06', '2028-01', '2028-06'].map((month) => ({ code: 'U2', month, amountMinor: '0' }));
  const r1 = (factorPpm: number) => ({ lineCodes: ['R1'], fromMonth: '2026-09', factorPpm });
  const s2 = (id: string, leverPatch: DraftLineage['leverPatch']) => ({
    id,
    lineage: { activePlanHash: HASH, scenario: CONSTRUCTION, leverPatch, steps: [] } as DraftLineage,
  });
  const S2_PARENTS = [
    s2('v1', null),
    s2('v2', { name: 'v2', set: releaseU2 }),
    s2('v3', { name: 'v3', scale: [r1(1_030_000)] }),
    s2('v4', { name: 'v4', scale: [r1(1_023_000)], set: releaseU2 }),
  ];

  it('pins Cedar to the need of the parent without an LLM call', async () => {
    // SCENARIO: «ближайшие 6 месяцев все затраты покрывает Cedar» on the stage 4 delay draft v2
    // INPUT: parent v2 = the delay-3 patch (evaluate serves eval-delay-3.json); existing ids v1..v3
    // EXPECTED: one child v2.1 with a cover step; its draws are Cedar = the delay-3 cash need 2026-09..2027-02
    const b = await loadBaseline();
    const { name: _name, ...good } = delay3Patch;
    const delayBody = canonicalJson(readJson('bodies/body-delay-3.json'));
    const delayEval = readJson('responses/eval-delay-3.json') as { walk: { cashNeedMinor: Record<string, string> } };
    const api = fakeApi((v, body) => (canonicalJson(body) === delayBody ? { status: 200, json: delayEval } : stage5Evaluate(v, body)), { partners: true });
    const llm = scriptedLlm([]);
    const goal = { type: 'funding_cover' as const, partnerId: 'cedar', fromMonth: '2026-09', months: 6 };
    const parent = { id: 'v2', lineage: { activePlanHash: HASH, scenario: { type: 'free' as const }, leverPatch: { ...good, name: 'v2' }, steps: [] } };
    const out = (await createKaironActivities(api)['kairon.buildGoalDrafts'](
      { baseline: { ...b, partners: [{ partnerId: 'solstice', name: 'Solstice Sponsor', sharePct: 0.3 }, { partnerId: 'cedar', name: 'Cedar Partners', sharePct: 0.7 }] }, goal, parents: [parent], existingIds: ['v1', 'v2', 'v3'] },
      ctxWith(llm),
    )) as { variants: Array<{ id: string; parentId: string; title: string; lineage: DraftLineage }>; answers: unknown[] };

    const months = ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
    const draws = months.map((m) => ({
      sourceId: '7c1962e8-a12d-42ca-82cc-4bea10338044',
      date: `${m}-01`,
      amountMinor: delayEval.walk.cashNeedMinor[m] ?? '0',
      origin: 'manual',
    }));
    expect(llm.complete).toHaveBeenCalledTimes(0);
    expect(out.answers).toEqual([]);
    expect(out.variants.map((v) => [v.id, v.parentId, v.title])).toEqual([
      ['v2.1', 'v2', 'Cedar Partners покрывает всю потребность 6 мес. с 2026-09'],
    ]);
    expect(out.variants[0]?.lineage).toEqual({ ...parent.lineage, steps: [{ type: 'cover', goal, draws }] });
  });

  it('answers instead of drafting when every parent already meets the IRR floor', async () => {
    // SCENARIO: «Хочу сохранить IRR только для Solstice» on S2 v1..v4, all above Solstice's promise
    // INPUT: irr_floor ['solstice'], the four S2 lineages; evaluate serves the recorded S2 bodies
    // EXPECTED: 4 answers «Цель уже выполнена в vN», no variants, no LLM call
    const b = await loadBaseline();
    const llm = scriptedLlm([]);
    const out = (await createKaironActivities(fakeApi(stage5Evaluate))['kairon.buildGoalDrafts'](
      { baseline: b, goal: { type: 'irr_floor', partnerIds: ['solstice'] }, parents: S2_PARENTS, existingIds: ['v1', 'v2', 'v3', 'v4'] },
      ctxWith(llm),
    )) as { variants: unknown[]; answers: Array<{ parentId: string; text: string }> };
    expect(llm.complete).toHaveBeenCalledTimes(0);
    expect(out.variants).toEqual([]);
    expect(out.answers).toEqual(['v1', 'v2', 'v3', 'v4'].map((id) => ({ parentId: id, text: `Цель уже выполнена в ${id}` })));
  });

  it('asks for one lever draft on top of the parent for a profit target', async () => {
    // SCENARIO: «Хочу добиться чистой прибыли в +10 000 000» on S2 v1
    // INPUT: net_profit_target delta 1 000 000 000; the scripted LLM returns R1 × 1.03 as v1.1
    // EXPECTED: one child v1.1 whose lineage adds a levers step; one LLM call asking for 1 variant with id v1.1
    const b = await loadBaseline();
    const empty = { stretch: [], shift: [], extend: [], scale: [], set: [], monthRangeTo: null, shareTarget: null };
    const llm = scriptedLlm([
      JSON.stringify({ variants: [{ id: 'v1.1', title: 'Цены +3 %', rationale: 'r', levers: ['цены'], patch: { ...empty, scale: [r1(1_030_000)] } }], openQuestions: [] }),
    ]);
    const goal = { type: 'net_profit_target' as const, amountMinor: '1000000000', basis: 'delta' as const };
    const out = (await createKaironActivities(fakeApi(stage5Evaluate))['kairon.buildGoalDrafts'](
      { baseline: b, goal, parents: [S2_PARENTS[0]], existingIds: ['v1', 'v2', 'v3', 'v4'] },
      ctxWith(llm),
    )) as { variants: Array<{ id: string; parentId: string; lineage: DraftLineage }> };
    expect(out.variants.map((v) => [v.id, v.parentId])).toEqual([['v1.1', 'v1']]);
    expect(out.variants[0]?.lineage.steps).toEqual([{ type: 'levers', goal, patch: { name: 'v1.1', scale: [r1(1_030_000)] } }]);
    expect(llm.complete.mock.calls[0]?.[0].messages[0]?.content).toContain('Return exactly 1 variants with ids v1.1.');
  });
});

describe('kairon.scoreVariants against parents (stage 5)', () => {
  const HASH = planHash(fixtureDoc);
  const CONSTRUCTION = { type: 'cost_change' as const, lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 };
  const releaseU2 = ['2026-11', '2027-06', '2028-01', '2028-06'].map((month) => ({ code: 'U2', month, amountMinor: '0' }));
  const r1 = (factorPpm: number) => ({ lineCodes: ['R1'], fromMonth: '2026-09', factorPpm });
  const lineage = (over: Partial<DraftLineage>): DraftLineage => ({ activePlanHash: HASH, scenario: { type: 'free' }, leverPatch: null, steps: [], ...over });
  const draft = (id: string, levers: string[], l: DraftLineage, parentId: string | null = null) => ({ id, parentId, title: id, rationale: '', levers, lineage: l });
  const S2 = [
    draft('v1', [], lineage({ scenario: CONSTRUCTION })),
    draft('v2', ['резерв'], lineage({ scenario: CONSTRUCTION, leverPatch: { name: 'v2', set: releaseU2 } })),
    draft('v3', ['цены'], lineage({ scenario: CONSTRUCTION, leverPatch: { name: 'v3', scale: [r1(1_030_000)] } })),
    draft('v4', ['резерв', 'цены'], lineage({ scenario: CONSTRUCTION, leverPatch: { name: 'v4', scale: [r1(1_023_000)], set: releaseU2 } })),
  ];
  const COVER_GOAL = { type: 'funding_cover' as const, partnerId: 'cedar', fromMonth: '2026-09', months: 6 };

  async function score(input: Record<string, unknown>) {
    const api = fakeApi(stage5Evaluate, { partners: true });
    const activities = createKaironActivities(api);
    const b = (await activities['kairon.baseline']({}, ctxWith(scriptedLlm([])))) as Baseline;
    return (await activities['kairon.scoreVariants']({ baseline: b, ...input }, ctxWith(scriptedLlm([])))) as {
      variants: Array<{
        id: string;
        status: string;
        redLines: Array<{ key: string; status: string; baseStatus: string }>;
        goalChecks: Array<{ draft: string; months: Array<{ draft: boolean }> }>;
      }>;
      ranking: string[];
      dropped: Array<{ id: string; sameAs: string }>;
      switches: Array<{ label: string; winner: string }>;
      rules: string[];
      answers: Array<{ parentId: string; text: string }>;
      facts: Record<string, string>;
    };
  }

  it('ranks construction +8 % with red lines, switches and the new facts', async () => {
    // SCENARIO: spec 5.7; the four S2 drafts against the active forecast
    // INPUT: lineages v1..v4; evaluate serves the recorded S2 bodies
    // EXPECTED: ranking v1..v4; v1's red lines as in redLines; switches v4, v4, v3; the promise rules; partners put in +44,6 млн for v1
    const out = await score({ proposals: { variants: S2 }, parents: [], goals: [] });
    expect(out.ranking).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(out.variants[0]?.redLines.map((l) => [l.key, l.status, l.baseStatus])).toEqual([
      ['cashGap', 'ok', 'ok'],
      ['frame.solstice', 'breach', 'breach'],
      ['frame.cedar', 'breach', 'breach'],
      ['parity', 'ok', 'ok'],
      ['irr', 'ok', 'ok'],
      ['ltc', 'unchecked', 'unchecked'],
      ['ltv', 'unchecked', 'unchecked'],
    ]);
    expect(out.switches).toEqual([
      { label: 'Важна прибыль как в плане', winner: 'v4' },
      { label: 'Меньше денег партнёров', winner: 'v4' },
      { label: 'Прибыль без траты резерва', winner: 'v3' },
    ]);
    expect(out.rules).toEqual([
      'Красные линии отсекают варианты: отсекает только нарушение, которое добавил сам вариант.',
      'Цель запроса не названа, поэтому цель по умолчанию: IRR каждого партнёра не ниже обещания и как можно ближе к нему.',
      'При равенстве выигрывает вариант с меньшим числом рычагов.',
    ]);
    expect([out.facts['v1.d.alloc'], out.facts['v1.d.alloc.solstice'], out.facts['v1.d.alloc.cedar']]).toEqual([
      '+44,6 млн CZK',
      '+13,4 млн CZK',
      '+31,2 млн CZK',
    ]);
  });

  it('drops the bank variant that changes nothing', async () => {
    // SCENARIO: «перерасход берёт банк», equity share 60 %
    // INPUT: S2 plus v5 = construction +8 % with shareTarget 6000
    // EXPECTED: dropped [{v5 same as v1}]; v5 is not ranked
    const v5 = draft('v5', ['банк'], lineage({ scenario: CONSTRUCTION, leverPatch: { name: 'v5', shareTarget: { equityShareBp: 6000 } } }));
    const out = await score({ proposals: { variants: [...S2, v5] }, parents: [], goals: [] });
    expect(out.dropped).toEqual([{ id: 'v5', sameAs: 'v1' }]);
    expect(out.ranking).toEqual(['v1', 'v2', 'v3', 'v4']);
  });

  it('warns on parity and meets the cover goal for v2.1', async () => {
    // SCENARIO: Cedar covers the need for six months on top of the active forecast
    // INPUT: parent v2 = the active forecast unchanged; child v2.1 adds the recorded cover draws
    // EXPECTED: parity warn on v2.1; its goal check is ok in 6 of 6 months
    const draws = (readJson('stage5/cover-cedar.body.json') as { draws: unknown[] }).draws;
    const child = draft('v2.1', [], lineage({ steps: [{ type: 'cover', goal: COVER_GOAL, draws } as DraftLineage['steps'][number]] }), 'v2');
    const out = await score({ proposals: { variants: [child] }, parents: [{ id: 'v2', lineage: lineage({}) }], goals: [COVER_GOAL] });
    const v21 = out.variants[0];
    expect(v21?.redLines.find((l) => l.key === 'parity')?.status).toBe('warn');
    expect(v21?.goalChecks[0]?.draft).toBe('ok');
    expect(v21?.goalChecks[0]?.months.filter((m) => m.draft)).toHaveLength(6);
  });

  it('answers that a goal is out of reach within the lever bounds', async () => {
    // SCENARIO: Review Focus 1, «+100 млн чистой прибыли» on S2 v1; the best lever R1 × 1.03 reaches 384,5 млн
    // INPUT: child v1.1 = v1 + R1 × 1 030 000 with a net_profit_target delta of 10 000 000 000 minor
    // EXPECTED: the goal check is breach; the answer names v1.1 as the closest draft
    const goal = { type: 'net_profit_target' as const, amountMinor: '10000000000', basis: 'delta' as const };
    const child = draft(
      'v1.1',
      ['цены'],
      lineage({ scenario: CONSTRUCTION, steps: [{ type: 'levers', goal, patch: { name: 'v1.1', scale: [r1(1_030_000)] } }] }),
      'v1',
    );
    const out = await score({ proposals: { variants: [child], answers: [] }, parents: [{ id: 'v1', lineage: S2[0]?.lineage }], goals: [goal] });
    expect(out.variants[0]?.goalChecks[0]?.draft).toBe('breach');
    expect(out.answers).toEqual([{ parentId: 'v1', text: 'Цель недостижима рычагами в пределах ±3 %: ближе всего v1.1' }]);
  });
});

describe('kairon.scoreVariants', () => {
  it('scores accepted variants, records a server refusal as data and ranks them', async () => {
    // SCENARIO: two proposals; the server accepts v1 and refuses v2 with 422
    // INPUT: v1 = delay-3 patch (evaluate returns eval-delay-3.json), v2 = any patch answered with 422
    // EXPECTED: v1 ok with IRR 20.71 / 23.46 %, v2 refused with status 422, ranking [v1, v2], facts for v1
    const b = await loadBaseline();
    const { name: _name, ...p1 } = delay3Patch;
    const p2 = { scale: [{ lineCodes: ['R1'], fromMonth: '2028-03', factorPpm: 1_010_000 }] };
    const activities = createKaironActivities(
      fakeApi((_v, body) => {
        if (JSON.stringify(body) === '{}') return { status: 200, json: readJson('responses/eval-active.json') };
        const plan = (body as { plan: { monthRange: { to: string } } }).plan;
        return plan.monthRange.to === '2028-10'
          ? { status: 200, json: readJson('responses/eval-delay-3.json') }
          : { status: 422, json: { statusCode: 422, message: 'closed month write' } };
      }),
    );

    const out = (await activities['kairon.scoreVariants'](
      {
        baseline: b,
        proposals: {
          variants: [
            { id: 'v1', title: 'a', rationale: 'r', levers: [], patch: p1 },
            { id: 'v2', title: 'b', rationale: 'r', levers: [], patch: p2 },
          ],
        },
      },
      ctxWith(scriptedLlm([])),
    )) as {
      variants: Array<{ id: string; status: string; httpStatus: number | null; errors: string[]; metrics: { partners: Array<{ irr: number | null }> } | null }>;
      ranking: string[];
      facts: Record<string, string>;
    };

    expect(out.variants.map((v) => [v.id, v.status, v.httpStatus])).toEqual([
      ['v1', 'ok', 200],
      ['v2', 'refused', 422],
    ]);
    expect(out.variants[1]?.errors).toEqual(['closed month write']);
    expect(out.variants[0]?.metrics?.partners.map((p) => p.irr)).toEqual([0.20713516356223352, 0.23464547979699193]);
    expect(out.ranking).toEqual(['v1', 'v2']);
    expect(out.facts['v1.irr.solstice']).toBe('20,71 %');
    expect(out.facts['approved.irr.solstice']).toBe('18,91 %');
  });

  it('attaches the diff against the active forecast and delta facts to a scored variant', async () => {
    // SCENARIO: the CFO report needs what v1 changes against Forecast v3
    // INPUT: v1 = delay-3 patch evaluated as eval-delay-3; the active forecast evaluated as eval-active
    // EXPECTED: v1.diff bridge overheads -267 385 860; delta facts: net profit -22,0, IRR -2,84 / -3,67 п.п.,
    //           trough -882,9 in 2028-06 against -851,0 in 2028-03, cash back to plus 2028-09, bridge overheads -2,7,
    //           walk interest +11,7 (12 956 739 085 - 11 789 401 998 minor)
    const b = await loadBaseline();
    const { name: _name, ...p1 } = delay3Patch;
    const activities = createKaironActivities(
      fakeApi((_v, body) =>
        JSON.stringify(body) === '{}'
          ? { status: 200, json: readJson('responses/eval-active.json') }
          : { status: 200, json: readJson('responses/eval-delay-3.json') },
      ),
    );
    const out = (await activities['kairon.scoreVariants'](
      { baseline: b, proposals: { variants: [{ id: 'v1', title: 'a', rationale: 'r', levers: [], patch: p1 }] } },
      ctxWith(scriptedLlm([])),
    )) as { variants: Array<{ diff: { bridge: Array<{ key: string; minor: string }> } | null }>; facts: Record<string, string> };

    expect(out.variants[0]?.diff?.bridge.find((r) => r.key === 'overheads')?.minor).toBe('-267385860');
    expect(
      ['v1.d.netProfit', 'v1.d.exitProfit', 'v1.d.irr.solstice', 'v1.d.irr.cedar', 'v1.trough', 'v1.troughMonth', 'v1.cashPositive', 'v1.bridge.overheads', 'v1.bridge.financing', 'active.trough', 'active.troughMonth', 'active.cashPositive', 'v1.d.interest'].map(
        (k) => out.facts[k],
      ),
    ).toEqual([
      '-22,0 млн CZK', '-33,7 млн CZK', '-2,84 п.п.', '-3,67 п.п.', '-882,9 млн CZK', '2028-06', '2028-09',
      '-2,7 млн CZK', '-19,3 млн CZK', '-851,0 млн CZK', '2028-03', '2028-06', '+11,7 млн CZK',
    ]);
    expect(out.facts['v1.bridge.revenue']).toBeUndefined();
  });
});

describe('kairon structured output (stage 3)', () => {
  it('sends the strict proposal schema built from the baseline with a labelled request', async () => {
    // SCENARIO: proposeVariants asks the model for a json_schema answer
    // INPUT: one valid reply (the recorded delay-3 patch)
    // EXPECTED: request label "proposeVariants, attempt 1", schema name "forecast_variants",
    //           stretch lineCodes enum = the 45 Rivergate codes
    const b = await loadBaseline();
    const { name: _name, ...good } = delay3Patch;
    const llm = scriptedLlm([JSON.stringify({ variants: [{ id: 'v1', title: 't', rationale: 'r', levers: [], patch: good }], openQuestions: [] })]);
    await createKaironActivities(fakeApi(baselineEvaluate))['kairon.proposeVariants']({ scenario: 's', baseline: b }, ctxWith(llm));

    const sent = llm.complete.mock.calls[0]?.[0] as KaironLLMRequest | undefined;
    expect(sent?.label).toBe('proposeVariants, attempt 1');
    expect(sent?.responseSchema?.name).toBe('forecast_variants');
    const schema = sent?.responseSchema?.schema as {
      properties: { variants: { items: { properties: { patch: { properties: { stretch: { items: { properties: { lineCodes: { items: { enum: string[] } } } } } } } } } } };
    };
    expect(schema.properties.variants.items.properties.patch.properties.stretch.items.properties.lineCodes.items.enum).toEqual(
      b.lines.map((l) => l.code),
    );
  });

});

describe('kairon fixes after the live run of 13.11', () => {
  const { name: _name, ...good } = delay3Patch;
  const valid = JSON.stringify({ variants: [{ id: 'v1', title: 't', rationale: 'r', levers: [], patch: good }], openQuestions: [] });

  it('asks for 32 000 tokens and names the token limit when the reply is cut off', async () => {
    // SCENARIO: reasoning took 7 677 of 8 000 tokens and the JSON was cut off (finish_reason length)
    // INPUT: reply 1 is half a JSON with finishReason length; reply 2 is valid
    // EXPECTED: maxTokens 32000; attempt 1 error names the token limit; the 2nd prompt asks for the whole JSON again
    const b = await loadBaseline();
    const llm = scriptedLlm([{ content: '{"variants":[{"id":"v1","title":"', finishReason: 'length' }, valid]);
    const out = (await createKaironActivities(fakeApi(baselineEvaluate))['kairon.proposeVariants'](
      { scenario: 's', baseline: b, count: 1 },
      ctxWith(llm),
    )) as { attempts: Array<{ attempt: number; errors: string[] }> };

    expect(llm.complete.mock.calls[0]?.[0].maxTokens).toBe(32000);
    expect(out.attempts).toEqual([
      { attempt: 1, errors: ['reply: cut off at the token limit (finish_reason length) before the JSON closed'] },
      { attempt: 2, errors: [] },
    ]);
    expect(llm.complete.mock.calls[1]?.[0].messages.at(-1)?.content).toBe(
      'Your answer was cut off at the token limit before the JSON closed. Return the whole JSON again with all 1 variants; keep each rationale to 2 sentences.',
    );
  });

  it('refuses a v1 that carries levers', async () => {
    // SCENARIO: v1 must be the scenario alone so the cost of the delay is visible before any lever
    // INPUT: reply 1 v1 has levers ["цена +2 %"] and shareTarget 3500; reply 2 is valid
    // EXPECTED: attempt 1 error names v1; 2 LLM calls; v1 accepted
    const b = await loadBaseline();
    const withLevers = JSON.stringify({
      variants: [{ id: 'v1', title: 't', rationale: 'r', levers: ['цена +2 %'], patch: { ...good, shareTarget: { equityShareBp: 3500 } } }],
      openQuestions: [],
    });
    const llm = scriptedLlm([withLevers, valid]);
    const out = (await createKaironActivities(fakeApi(baselineEvaluate))['kairon.proposeVariants'](
      { scenario: 's', baseline: b, count: 1 },
      ctxWith(llm),
    )) as { variants: Array<{ id: string }>; attempts: Array<{ attempt: number; errors: string[] }> };

    expect(out.attempts).toEqual([
      { attempt: 1, errors: ['v1: the first variant is the scenario alone; leave levers [] and shareTarget null, put levers into the later variants'] },
      { attempt: 2, errors: [] },
    ]);
    expect(out.variants.map((v) => v.id)).toEqual(['v1']);
  });
});
