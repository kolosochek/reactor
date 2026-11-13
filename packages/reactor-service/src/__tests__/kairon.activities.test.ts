// The forecast prototype's reactor activities with a fake Kairon API and a
// scripted LLM (DEV-1364): baseline, propose with retry, score, explain.

import { describe, expect, it, vi } from 'vitest';
import type { ActivityContext, LLMCompletionRequest, LLMCompletionResponse, LLMProvider } from '@kolosochek/reactor-core';
import { createKaironActivities } from '../kairon/activities.js';
import type { Baseline } from '../kairon/baseline.js';
import type { KaironLLMRequest } from '../kairon/openrouter.js';
import { baselineEvaluate, fakeKaironApi as fakeApi, readFixture as readJson } from './_helpers/kaironFake.js';

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
    // EXPECTED: Solstice 0.3 and Cedar 0.7 in settings order; the approved plan's 45 lines; no partners without settings
    const activities = createKaironActivities(fakeApi(baselineEvaluate, { partners: true }));
    const b = (await activities['kairon.baseline']({}, ctxWith(scriptedLlm([])))) as Baseline;
    expect(b.partners).toEqual([
      { partnerId: 'solstice', name: 'Solstice Sponsor', sharePct: 0.3 },
      { partnerId: 'cedar', name: 'Cedar Partners', sharePct: 0.7 },
    ]);
    expect(b.approvedPlan.lines).toHaveLength(45);
    expect(b.approvedPlan.monthRange).toEqual({ from: '2024-12', to: '2028-07' });
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
    //           trough -882,9 in 2028-06 against -851,0 in 2028-03, cash back to plus 2028-09, bridge overheads -2,7
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
      ['v1.d.netProfit', 'v1.d.exitProfit', 'v1.d.irr.solstice', 'v1.d.irr.cedar', 'v1.trough', 'v1.troughMonth', 'v1.cashPositive', 'v1.bridge.overheads', 'v1.bridge.financing', 'active.trough', 'active.troughMonth', 'active.cashPositive'].map(
        (k) => out.facts[k],
      ),
    ).toEqual([
      '-22,0 млн CZK', '-33,7 млн CZK', '-2,84 п.п.', '-3,67 п.п.', '-882,9 млн CZK', '2028-06', '2028-09',
      '-2,7 млн CZK', '-19,3 млн CZK', '-851,0 млн CZK', '2028-03', '2028-06',
    ]);
    expect(out.facts['v1.bridge.revenue']).toBeUndefined();
  });
});

describe('kairon.explainVariants', () => {
  it('renders every part of the structured explanation with server facts and lists literal numbers', async () => {
    // SCENARIO: the LLM explains from the business case down to the figures, with placeholders, and slips one literal number
    // INPUT: headline with {{v1.d.netProfit}}, v1 result "IRR {{v1.irr.solstice}} при обещании {{approved.irr.solstice}}, запас 7 %",
    //        shifts "выход на 3 месяца позже"; scenario "kolaudace +3"
    // EXPECTED: placeholders filled in every field; literalNumbers ["7"] (3 comes from the scenario); recommendation v1
    const llm = scriptedLlm([
      JSON.stringify({
        headline: 'Задержка стоит {{v1.d.netProfit}}, обещание держится',
        variants: [
          {
            id: 'v1',
            whatWeDo: 'Ничего не меняем',
            whatShifts: 'Выход на 3 месяца позже',
            result: 'IRR {{v1.irr.solstice}} при обещании {{approved.irr.solstice}}, запас 7 %',
          },
        ],
        whyRecommended: 'Рычаги не нужны',
        recommendation: 'v1',
        departureReason: null,
        caveats: ['Банк: {{v1.ltv}}'],
      }),
    ]);
    const activities = createKaironActivities(fakeApi(baselineEvaluate));
    const out = await activities['kairon.explainVariants'](
      {
        scenario: 'kolaudace +3',
        scored: {
          variants: [{ id: 'v1', title: 'a', status: 'ok', levers: [], errors: [] }],
          ranking: ['v1'],
          facts: {
            'v1.irr.solstice': '20,71 %',
            'approved.irr.solstice': '18,91 %',
            'v1.ltv': '54,25 %',
            'v1.d.netProfit': '-22,0 млн CZK',
          },
        },
      },
      ctxWith(llm),
    );
    expect(out).toEqual({
      headline: 'Задержка стоит -22,0 млн CZK, обещание держится',
      variants: [
        {
          id: 'v1',
          whatWeDo: 'Ничего не меняем',
          whatShifts: 'Выход на 3 месяца позже',
          result: 'IRR 20,71 % при обещании 18,91 %, запас 7 %',
        },
      ],
      whyRecommended: 'Рычаги не нужны',
      caveats: ['Банк: 54,25 %'],
      recommendation: 'v1',
      topRanked: 'v1',
      departureReason: null,
      unknownPlaceholders: [],
      literalNumbers: ['7'],
    });
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

  it('skips the LLM when no variant was scored', async () => {
    // SCENARIO: every variant was refused, so there is nothing to explain
    // INPUT: scored with one refused variant
    // EXPECTED: no LLM call, a fixed Russian text, empty recommendation
    const llm = scriptedLlm([]);
    const out = await createKaironActivities(fakeApi(baselineEvaluate))['kairon.explainVariants'](
      { scenario: 's', scored: { variants: [{ id: 'v1', title: 'a', status: 'refused', levers: [], errors: ['x'] }], ranking: ['v1'], facts: {} } },
      ctxWith(llm),
    );
    expect(llm.complete).toHaveBeenCalledTimes(0);
    expect(out).toEqual({
      headline: 'Ни один вариант не посчитан сервером, объяснять нечего. Причины отказов в таблице и в трассировке.',
      variants: [],
      whyRecommended: '',
      caveats: [],
      recommendation: '',
      topRanked: '',
      departureReason: null,
      unknownPlaceholders: [],
      literalNumbers: [],
    });
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

  it('asks again when the recommendation departs from the ranking without a reason', async () => {
    // SCENARIO: the live run ranked v3 first and the LLM recommended v1 without saying why
    // INPUT: ranking v3 > v2 > v1, all ok; reply 1 recommends v1 with departureReason null; reply 2 recommends v3
    // EXPECTED: 2 LLM calls; the 2nd prompt names the conflict; recommendation v3, topRanked v3
    const reply = (recommendation: string) =>
      JSON.stringify({ headline: 'текст', variants: [], whyRecommended: 'почему', recommendation, departureReason: null, caveats: [] });
    const llm = scriptedLlm([reply('v1'), reply('v3')]);
    const ok = (id: string) => ({ id, title: id, status: 'ok', levers: [], errors: [] });
    const out = await createKaironActivities(fakeApi(baselineEvaluate))['kairon.explainVariants'](
      { scenario: 's', scored: { variants: [ok('v1'), ok('v2'), ok('v3')], ranking: ['v3', 'v2', 'v1'], facts: {} } },
      ctxWith(llm),
    );

    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(llm.complete.mock.calls[1]?.[0].messages.at(-1)?.content).toBe(
      'The recommendation v1 departs from the top-ranked variant v3 without a reason. Recommend v3, or keep v1 and write the reason in departureReason. Return the whole JSON again.',
    );
    expect(out).toEqual({
      headline: 'текст',
      variants: [],
      whyRecommended: 'почему',
      caveats: [],
      recommendation: 'v3',
      topRanked: 'v3',
      departureReason: null,
      unknownPlaceholders: [],
      literalNumbers: [],
    });
  });
});
