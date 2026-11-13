// The LLM steps after scoring (DEV-1364 stage 4, DEV-1375 stage 5): widget
// specs per changed path, the explanation with its overview, and answers to
// questions. The LLM writes words and {{key}} placeholders; the server fills
// every figure and lists the numbers the LLM typed itself.

import { describe, expect, it, vi } from 'vitest';
import type { ActivityContext, LLMCompletionRequest, LLMCompletionResponse, LLMProvider } from '@kolosochek/reactor-core';
import { createKaironActivities } from '../kairon/activities.js';
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
const activities = createKaironActivities(fakeKaironApi(baselineEvaluate));
const ok = (id: string) => ({ id, title: id, status: 'ok', levers: [], errors: [] });
const EMPTY_OVERVIEW = { whyNotOthers: [], rules: [], switches: [], matrix: [], dropped: [] };
const STAGE5_VARIANT = { verdict: '', gives: [], costs: [], stakeholders: [] };

describe('kairon.planWidgets', () => {
  const coverScored = {
    variants: [
      { id: 'v2.1', status: 'ok', changed: [{ path: 'funding.draws', cells: 14 }, { path: 'exit.partners', cells: 2 }] },
      { id: 'v3', status: 'refused', changed: [] },
    ],
  };

  it('puts the mandatory matrix-diff before the bars the LLM chose', async () => {
    // SCENARIO: the cover draft changed the draws; the LLM proposed only bars
    // INPUT: one reply with bars-before-after for v2.1
    // EXPECTED: v2.1 gets matrix-diff then bars; the refused v3 gets nothing; one LLM call
    const reply = {
      widgets: [
        {
          id: 'v2.1',
          specs: [
            { widget: 'bars-before-after', title: 'Было и стало', x: 'period', stack: 'sourceId', y: 'amountMinor', compare: ['parent', 'draft'], label: 'Δ' },
          ],
        },
      ],
    };
    const llm = scriptedLlm([JSON.stringify(reply)]);
    const out = (await activities['kairon.planWidgets']({ scored: coverScored }, ctxWith(llm))) as {
      widgets: Record<string, Array<{ widget: string }>>;
    };
    expect(Object.keys(out.widgets)).toEqual(['v2.1']);
    expect(out.widgets['v2.1']?.map((s) => s.widget)).toEqual(['matrix-diff', 'bars-before-after']);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default widgets on a broken reply', async () => {
    // SCENARIO: the LLM returns prose
    // INPUT: reply 'no json'
    // EXPECTED: v2.1 gets the defaults: matrix-diff then bars-before-after
    const out = (await activities['kairon.planWidgets']({ scored: coverScored }, ctxWith(scriptedLlm(['no json'])))) as {
      widgets: Record<string, Array<{ widget: string }>>;
    };
    expect(out.widgets['v2.1']?.map((s) => s.widget)).toEqual(['matrix-diff', 'bars-before-after']);
  });
});

describe('kairon.explainVariants', () => {
  it('renders every part of the structured explanation with server facts and lists literal numbers', async () => {
    // SCENARIO: the LLM explains from the business case down to the figures, with placeholders, and slips one literal number
    // INPUT: headline with {{v1.d.netProfit}}, v1 result "IRR {{v1.irr.solstice}} при обещании {{approved.irr.solstice}}, запас 7 %",
    //        shifts "выход на 3 месяца позже"; scenario "kolaudace +3"
    // EXPECTED: placeholders filled in every field; literalNumbers ["7"] (3 comes from the scenario); recommendation v1; empty stage 5 parts
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
    const out = await activities['kairon.explainVariants'](
      {
        scenario: 'kolaudace +3',
        scored: {
          variants: [ok('v1')],
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
          ...STAGE5_VARIANT,
        },
      ],
      whyRecommended: 'Рычаги не нужны',
      caveats: ['Банк: 54,25 %'],
      recommendation: 'v1',
      topRanked: 'v1',
      departureReason: null,
      ...EMPTY_OVERVIEW,
      unknownPlaceholders: [],
      literalNumbers: ['7'],
    });
  });

  it('skips the LLM when no variant was scored', async () => {
    // SCENARIO: every variant was refused, so there is nothing to explain
    // INPUT: scored with one refused variant
    // EXPECTED: no LLM call, a fixed Russian text, empty recommendation
    const llm = scriptedLlm([]);
    const out = await activities['kairon.explainVariants'](
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
      ...EMPTY_OVERVIEW,
      unknownPlaceholders: [],
      literalNumbers: [],
    });
  });

  it('asks again when the recommendation departs from the ranking without a reason', async () => {
    // SCENARIO: the live run ranked v3 first and the LLM recommended v1 without saying why
    // INPUT: ranking v3 > v2 > v1, all ok; reply 1 recommends v1 with departureReason null; reply 2 recommends v3
    // EXPECTED: 2 LLM calls; the 2nd prompt names the conflict; recommendation v3, topRanked v3
    const reply = (recommendation: string) =>
      JSON.stringify({ headline: 'текст', variants: [], whyRecommended: 'почему', recommendation, departureReason: null, caveats: [] });
    const llm = scriptedLlm([reply('v1'), reply('v3')]);
    const out = await activities['kairon.explainVariants'](
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
      ...EMPTY_OVERVIEW,
      unknownPlaceholders: [],
      literalNumbers: [],
    });
  });

  it('renders the verdict and the overview parts, and copies the server rules and switches', async () => {
    // SCENARIO: the cover draft v2.1 card and the overview
    // INPUT: verdict «Цель выполнена без кассовых разрывов: {{v2.1.uncoveredNeed}}»; a cost item with the literal «0,9 млн»;
    //        scored rules and switches from the server
    // EXPECTED: the fact rendered; '0,9' in literalNumbers; rules, switches (with their goals), matrix and dropped as given
    const scored = {
      variants: [ok('v2.1')],
      ranking: ['v2.1'],
      facts: { 'v2.1.uncoveredNeed': '0,0 млн CZK', 'v2.1.d.irr.cedar': '-0,18 п.п.' },
      rules: ['Красные линии отсекают варианты: отсекает только нарушение, которое добавил сам вариант.'],
      switches: [{ label: 'Важна прибыль как в плане', winner: 'v2.1' }],
      matrix: [{ step: 3, label: 'Рычаги', values: { 'v2.1': 'нет' }, best: 'v2.1' }],
      dropped: [{ id: 'v5', sameAs: 'v1' }],
    };
    const llm = scriptedLlm([
      JSON.stringify({
        headline: 'h',
        variants: [
          {
            id: 'v2.1',
            whatWeDo: 'w',
            whatShifts: 's',
            result: 'r',
            verdict: 'Цель выполнена без кассовых разрывов: {{v2.1.uncoveredNeed}}',
            gives: ['Solstice не вносит деньги полгода'],
            costs: ['Cedar: IRR {{v2.1.d.irr.cedar}}', 'проценты 0,9 млн'],
            stakeholders: [{ party: 'cedar', meaning: 'вносит больше' }],
          },
        ],
        whyRecommended: 'y',
        recommendation: 'v2.1',
        departureReason: null,
        caveats: [],
        whyNotOthers: [],
      }),
    ]);
    const out = (await activities['kairon.explainVariants']({ scenario: 's', scored }, ctxWith(llm))) as {
      variants: Array<{ verdict: string; costs: string[]; stakeholders: unknown[] }>;
      rules: string[];
      switches: unknown[];
      matrix: unknown[];
      dropped: unknown[];
      literalNumbers: string[];
    };
    expect(out.variants[0]?.verdict).toBe('Цель выполнена без кассовых разрывов: 0,0 млн CZK');
    expect(out.variants[0]?.costs).toEqual(['Cedar: IRR -0,18 п.п.', 'проценты 0,9 млн']);
    expect(out.variants[0]?.stakeholders).toEqual([{ party: 'cedar', meaning: 'вносит больше' }]);
    expect(out.literalNumbers).toEqual(['0,9']);
    expect(out.rules).toEqual(scored.rules);
    expect(out.switches).toEqual([{ label: 'Важна прибыль как в плане', goal: { type: 'max_net_profit' }, winner: 'v2.1' }]);
    expect([out.matrix, out.dropped]).toEqual([scored.matrix, scored.dropped]);
  });
});

describe('kairon.answerQuestion', () => {
  it('answers without the LLM when there are no drafts yet', async () => {
    // SCENARIO: Review Focus 5, a question before any generation
    // INPUT: «Почему v2 выше v3?», no drafts
    // EXPECTED: the fixed answer, no LLM call
    const llm = scriptedLlm([]);
    const out = await activities['kairon.answerQuestion']({ question: 'Почему v2 выше v3?', facts: {}, drafts: [] }, ctxWith(llm));
    expect(out).toEqual({ answer: 'Сначала опишите сценарий: вариантов ещё нет', unknownPlaceholders: [], literalNumbers: [] });
    expect(llm.complete).toHaveBeenCalledTimes(0);
  });

  it('renders the facts the answer cites', async () => {
    // SCENARIO: «Почему v2 выше v3?» with S1 drafts
    // INPUT: reply «v2 выше: {{v2.irr.solstice}}», fact v2.irr.solstice = 21,45 %
    // EXPECTED: the rendered answer, label answerQuestion
    const llm = scriptedLlm(['{"answer":"v2 выше: {{v2.irr.solstice}}"}']);
    const out = await activities['kairon.answerQuestion'](
      { question: 'Почему v2 выше v3?', facts: { 'v2.irr.solstice': '21,45 %' }, drafts: [{ id: 'v2', title: 'b' }, { id: 'v3', title: 'c' }] },
      ctxWith(llm),
    );
    expect(out).toEqual({ answer: 'v2 выше: 21,45 %', unknownPlaceholders: [], literalNumbers: [] });
    expect((llm.complete.mock.calls[0]?.[0] as { label?: string }).label).toBe('answerQuestion, attempt 1');
  });
});
