// The conversation steps (DEV-1375, spec 5.1): the router picks the message
// kind and its scope, and two structuring steps turn a phrase into a scenario
// spec or a goal the server can apply. Scripted LLM, fake Kairon API.

import { describe, expect, it, vi } from 'vitest';
import type { ActivityContext, LLMCompletionRequest, LLMCompletionResponse, LLMProvider } from '@kolosochek/reactor-core';
import { createKaironActivities } from '../kairon/activities.js';
import type { Baseline } from '../kairon/baseline.js';
import type { KaironLLMRequest } from '../kairon/openrouter.js';
import { baselineEvaluate, fakeKaironApi } from './_helpers/kaironFake.js';

function scriptedLlm(replies: string[]) {
  const queue = [...replies];
  const complete = vi.fn<[LLMCompletionRequest], Promise<LLMCompletionResponse>>(async () => ({
    content: queue.shift() ?? '{}',
    model: 'scripted',
  }));
  const llm: LLMProvider = { name: 'scripted', complete };
  return Object.assign(llm, { complete });
}

const ctxWith = (llm: LLMProvider): ActivityContext => ({ state: {}, llm });
const activities = createKaironActivities(fakeKaironApi(baselineEvaluate, { partners: true }));
const DRAFTS = [
  { id: 'v1', title: 'Только задержка' },
  { id: 'v2', title: 'Цены +3 %' },
  { id: 'v3', title: 'Поэтапная сдача' },
];

async function baseline(): Promise<Baseline> {
  return (await activities['kairon.baseline']({}, ctxWith(scriptedLlm([])))) as Baseline;
}

function requestOf(llm: ReturnType<typeof scriptedLlm>, call: number): KaironLLMRequest {
  const request = llm.complete.mock.calls[call]?.[0];
  if (request === undefined) throw new Error(`no LLM call ${call}`);
  return request as KaironLLMRequest;
}

describe('kairon.route', () => {
  it('routes a goal phrase to the selected card', async () => {
    // SCENARIO: «Хочу, чтобы ближайшие 6 месяцев все затраты покрывал Cedar» with v2 selected
    // INPUT: reply {"kind":"goal_change","scope":[]}, drafts v1..v3, selected v2
    // EXPECTED: goal_change on [v2], no error; the strict schema's scope enum lists the drafts and 'all'
    const llm = scriptedLlm(['{"kind":"goal_change","scope":[]}']);
    const out = await activities['kairon.route'](
      { message: 'Хочу, чтобы ближайшие 6 месяцев все затраты покрывал Cedar', drafts: DRAFTS, selected: 'v2' },
      ctxWith(llm),
    );
    expect(out).toEqual({ kind: 'goal_change', scope: ['v2'], error: null });
    const schema = requestOf(llm, 0).responseSchema?.schema as { properties: { scope: { items: { enum: string[] } } } };
    expect(schema.properties.scope.items.enum).toEqual(['v1', 'v2', 'v3', 'all']);
    expect(requestOf(llm, 0).label).toBe('route, attempt 1');
  });

  it('falls back to a question when the router twice names a draft that does not exist', async () => {
    // SCENARIO: Review Focus 3, the relaxed schema let v5 through
    // INPUT: two replies with scope ['v5']
    // EXPECTED: question, empty scope, an error naming v5; 2 LLM calls
    const llm = scriptedLlm(['{"kind":"goal_change","scope":["v5"]}', '{"kind":"goal_change","scope":["v5"]}']);
    const out = await activities['kairon.route']({ message: 'Пусть v5 покроет Cedar', drafts: DRAFTS, selected: null }, ctxWith(llm));
    expect(out).toEqual({ kind: 'question', scope: [], error: 'scope: unknown draft v5; known: v1, v2, v3, all' });
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });
});

describe('kairon.structureScenario', () => {
  it('structures construction +8 % into a cost change', async () => {
    // SCENARIO: «Стройка дорожает на 8 % с 2026-09»
    // INPUT: reply cost_change D5, D8, 2026-09, 1 080 000 in the strict shape
    // EXPECTED: that spec, no errors, one LLM call
    const b = await baseline();
    const llm = scriptedLlm([
      '{"type":"cost_change","lineCodes":["D5","D8"],"fromMonth":"2026-09","factorPpm":1080000}',
    ]);
    const out = await activities['kairon.structureScenario']({ message: 'Стройка дорожает на 8 % с 2026-09', baseline: b }, ctxWith(llm));
    expect(out).toEqual({
      spec: { type: 'cost_change', lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 },
      errors: [],
    });
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('retries once with the server error for a closed month', async () => {
    // SCENARIO: the first answer starts the change in the closed month
    // INPUT: replies with fromMonth 2026-08, then 2026-09
    // EXPECTED: the second request carries the applyScenario error; the corrected spec comes back
    const b = await baseline();
    const llm = scriptedLlm([
      '{"type":"cost_change","lineCodes":["D5","D8"],"fromMonth":"2026-08","factorPpm":1080000}',
      '{"type":"cost_change","lineCodes":["D5","D8"],"fromMonth":"2026-09","factorPpm":1080000}',
    ]);
    const out = await activities['kairon.structureScenario']({ message: 'Стройка +8 %', baseline: b }, ctxWith(llm));
    expect(out).toEqual({
      spec: { type: 'cost_change', lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 },
      errors: [],
    });
    const retry = requestOf(llm, 1).messages.at(-1)?.content ?? '';
    expect(retry).toContain('2026-08: closed through 2026-08; the scenario starts at 2026-09 or later');
  });

  it('keeps a phrase that is not a cost change free', async () => {
    // SCENARIO: the stage 4 kolaudace delay phrase
    // INPUT: strict reply {"type":"free","lineCodes":[],"fromMonth":null,"factorPpm":null}
    // EXPECTED: {type: 'free'}, no errors
    const b = await baseline();
    const llm = scriptedLlm(['{"type":"free","lineCodes":[],"fromMonth":null,"factorPpm":null}']);
    const out = await activities['kairon.structureScenario']({ message: 'Kolaudace сдвигается на 3 месяца', baseline: b }, ctxWith(llm));
    expect(out).toEqual({ spec: { type: 'free' }, errors: [] });
  });
});

describe('kairon.structureGoal', () => {
  it('structures the Cedar cover goal', async () => {
    // SCENARIO: «Хочу, чтобы ближайшие 6 месяцев все затраты покрывал Cedar»
    // INPUT: strict reply for funding_cover cedar 2026-09 × 6
    // EXPECTED: that goal, no errors; the partner enum lists the project's partners
    const b = await baseline();
    const llm = scriptedLlm([
      '{"type":"funding_cover","partnerId":"cedar","fromMonth":"2026-09","months":6,"partnerIds":[],"amountMinor":null,"basis":null}',
    ]);
    const out = await activities['kairon.structureGoal'](
      { message: 'Хочу, чтобы ближайшие 6 месяцев все затраты покрывал Cedar', baseline: b, scope: ['v2'] },
      ctxWith(llm),
    );
    expect(out).toEqual({ goal: { type: 'funding_cover', partnerId: 'cedar', fromMonth: '2026-09', months: 6 }, errors: [] });
    const schema = requestOf(llm, 0).responseSchema?.schema as { properties: { partnerId: { anyOf: Array<{ enum?: string[] }> } } };
    expect(schema.properties.partnerId.anyOf[0]?.enum).toEqual(['solstice', 'cedar']);
  });

  it('reads a bare «+10 000 000» as a delta in minor units', async () => {
    // SCENARIO: «Хочу добиться чистой прибыли в +10 000 000»
    // INPUT: strict reply net_profit_target 1 000 000 000 minor, basis delta
    // EXPECTED: that goal
    const b = await baseline();
    const llm = scriptedLlm([
      '{"type":"net_profit_target","partnerId":null,"fromMonth":null,"months":null,"partnerIds":[],"amountMinor":"1000000000","basis":"delta"}',
    ]);
    const out = await activities['kairon.structureGoal'](
      { message: 'Хочу добиться чистой прибыли в +10 000 000', baseline: b, scope: ['v1'] },
      ctxWith(llm),
    );
    expect(out).toEqual({ goal: { type: 'net_profit_target', amountMinor: '1000000000', basis: 'delta' }, errors: [] });
  });

  it('returns the errors after one failed retry', async () => {
    // SCENARIO: the model twice answers a cover goal without a partner
    // INPUT: two replies with partnerId null
    // EXPECTED: goal null; the error names partnerId; 2 LLM calls
    const b = await baseline();
    const bad = '{"type":"funding_cover","partnerId":null,"fromMonth":"2026-09","months":6,"partnerIds":[],"amountMinor":null,"basis":null}';
    const llm = scriptedLlm([bad, bad]);
    const out = await activities['kairon.structureGoal']({ message: 'Покрыть всё', baseline: b, scope: ['v1'] }, ctxWith(llm));
    expect(out).toEqual({ goal: null, errors: ['partnerId: Required'] });
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });
});
