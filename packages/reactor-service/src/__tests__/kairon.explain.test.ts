// The LLM steps after scoring (DEV-1364 stage 4, DEV-1375 stage 5): widget
// specs per changed path, the explanation with its overview, and answers to
// questions. The LLM writes words and {{key}} placeholders; the server fills
// every figure and lists the numbers the LLM typed itself.

import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ActivityContext, LLMCompletionRequest, LLMCompletionResponse, LLMProvider } from '@kolosochek/reactor-core';
import { createKaironActivities } from '../kairon/activities.js';
import { loadWidgetCatalog } from '../kairon/widgetCatalog.js';
import { baselineEvaluate, fakeKaironApi } from './_helpers/kaironFake.js';
import { STUB_BUILD_ID, writeStubWidgetsDist } from './_helpers/widgetsStub.js';

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
const EMPTY_OVERVIEW = { whyNotOthers: [], rules: [], switches: [], matrix: [], dropped: [], notRecommendable: [] };
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

describe('kairon.planWidgets without a widgets catalog', () => {
  it('returns the declarative specs alone, as before DEV-1380', async () => {
    // SCENARIO: the service runs with no KAIRON_WIDGETS_DIST; a recorded session must replay unchanged
    // INPUT: a draft that changed the draws; the sample model's empty reply
    // EXPECTED: the output has the one key widgets; the prompt names no catalog widget
    const llm = scriptedLlm([JSON.stringify({ widgets: [] })]);
    const scored = { variants: [{ id: 'v1', status: 'ok', changed: [{ path: 'funding.draws', cells: 36 }] }] };
    const out = (await activities['kairon.planWidgets']({ scored }, ctxWith(llm))) as Record<string, unknown>;
    expect([Object.keys(out), llm.complete.mock.calls[0]?.[0].messages[0]?.content.includes('CATALOG WIDGETS')]).toEqual([['widgets'], false]);
  });
});

describe('kairon.planWidgets with a widgets catalog (DEV-1380)', () => {
  const dist = writeStubWidgetsDist();
  afterAll(() => dist.remove());
  const withCatalog = createKaironActivities(fakeKaironApi(baselineEvaluate), () => loadWidgetCatalog({ KAIRON_WIDGETS_DIST: dist.dir }));
  const NO_FOCUS = { sourceIds: [], partnerIds: [], lineCodes: [] };
  const cashData = { rows: 44 };
  const profitData = { netProfitMinor: '33342746353' };
  const s2 = (changed: Array<{ path: string; cells: number }>, widgetData: Record<string, unknown> | null) => ({
    variants: [{ id: 'v1', status: 'ok', changed, widgetData }],
  });
  const ALL_CHANGED = [
    { path: 'funding.draws', cells: 36 },
    { path: 'walk.cumulativeNetCashMinor', cells: 23 },
    { path: 'netProfit', cells: 1 },
  ];
  type Out = {
    widgets: Record<string, Array<{ widget: string }>>;
    instances: Record<string, Array<{ widget: string; version: number; buildId: string; spec: unknown; data: unknown; provenance: string }>>;
  };
  const scoredAll = { scored: s2(ALL_CHANGED, { 'stub-cash': cashData, 'stub-profit': profitData }) };

  it('assembles an instance for every catalog widget whose paths changed, when the LLM names none', async () => {
    // SCENARIO: the sample model answers { widgets: [] }; the server decides which catalog widgets a draft gets
    // INPUT: v1 changed the draws, the cash line and the net profit; data for stub-cash and stub-profit
    // EXPECTED: instances stub-cash (v2) and stub-profit (v1) in manifest order, titled by the manifest, empty focus,
    //           provenance kairon, each stamped with the build id of the catalog that cut its data (review I1);
    //           the draws rule still gives matrix-diff and bars
    const out = (await withCatalog['kairon.planWidgets'](
      { scored: s2(ALL_CHANGED, { 'stub-cash': cashData, 'stub-profit': profitData }) },
      ctxWith(scriptedLlm([JSON.stringify({ widgets: [] })])),
    )) as Out;
    expect([out.widgets['v1']?.map((w) => w.widget), out.instances['v1']]).toEqual([
      ['matrix-diff', 'bars-before-after'],
      [
        { widget: 'stub-cash', version: 2, spec: { widget: 'stub-cash', title: 'Cumulative cash', focus: NO_FOCUS }, data: cashData, provenance: 'kairon', buildId: STUB_BUILD_ID },
        { widget: 'stub-profit', version: 1, spec: { widget: 'stub-profit', title: 'Net profit', focus: NO_FOCUS }, data: profitData, provenance: 'kairon', buildId: STUB_BUILD_ID },
      ],
    ]);
  });

  it('takes the title the LLM gave, strips its focus, drops an unknown id and keeps the draws rule', async () => {
    // SCENARIO: the LLM names a catalog widget with its own title and a focus on ids it invented, one id nobody
    //           knows, and no matrix-diff. The prompt carries no source, partner or line ids, so a focus from the
    //           LLM can only name unknown ones and hide rows (review I3)
    // INPUT: specs: stub-cash «Деньги проекта» focused on source s1 and partner nobody; nope; bars-before-after
    // EXPECTED: the stub-cash instance carries the LLM's title and an empty focus; stub-profit keeps its default
    //           spec; nope is dropped; widgets are matrix-diff then bars
    const reply = {
      widgets: [
        {
          id: 'v1',
          specs: [
            { widget: 'stub-cash', title: 'Деньги проекта', focus: { sourceIds: ['s1'], partnerIds: ['nobody'], lineCodes: [] } },
            { widget: 'nope', title: 'Неизвестный' },
            { widget: 'bars-before-after', title: 'Было и стало', x: 'period', stack: 'sourceId', y: 'amountMinor', compare: ['parent', 'draft'], label: 'Δ' },
          ],
        },
      ],
    };
    const llm = scriptedLlm([JSON.stringify(reply)]);
    const out = (await withCatalog['kairon.planWidgets'](scoredAll, ctxWith(llm))) as Out;
    expect([out.widgets['v1']?.map((w) => w.widget), out.instances['v1']?.map((i) => i.spec), llm.complete.mock.calls.length]).toEqual([
      ['matrix-diff', 'bars-before-after'],
      [
        { widget: 'stub-cash', title: 'Деньги проекта', focus: NO_FOCUS },
        { widget: 'stub-profit', title: 'Net profit', focus: NO_FOCUS },
      ],
      1,
    ]);
  });

  it('falls back to the default title when the LLM gives an empty or blank one', async () => {
    // SCENARIO: a catalog spec with no usable title must not draw an untitled widget (review minor 6)
    // INPUT: specs: stub-cash titled '' and stub-profit titled three spaces
    // EXPECTED: both instances carry the manifest titles
    const reply = { widgets: [{ id: 'v1', specs: [{ widget: 'stub-cash', title: '' }, { widget: 'stub-profit', title: '   ' }] }] };
    const out = (await withCatalog['kairon.planWidgets'](scoredAll, ctxWith(scriptedLlm([JSON.stringify(reply)])))) as Out;
    expect(out.instances['v1']?.map((i) => i.spec)).toEqual([
      { widget: 'stub-cash', title: 'Cumulative cash', focus: NO_FOCUS },
      { widget: 'stub-profit', title: 'Net profit', focus: NO_FOCUS },
    ]);
  });

  it('keeps the default own specs when the reply holds catalog specs alone', async () => {
    // SCENARIO: the LLM titled a catalog widget and named none of the service's own widgets (review minor 8)
    // INPUT: v1 changed the draws; specs: stub-cash «Деньги проекта» alone
    // EXPECTED: widgets are the defaults of changed draws, matrix-diff then bars-before-after; the title is taken
    const reply = { widgets: [{ id: 'v1', specs: [{ widget: 'stub-cash', title: 'Деньги проекта' }] }] };
    const out = (await withCatalog['kairon.planWidgets'](scoredAll, ctxWith(scriptedLlm([JSON.stringify(reply)])))) as Out;
    expect([out.widgets['v1']?.map((w) => w.widget), out.instances['v1']?.map((i) => (i.spec as { title: string }).title)]).toEqual([
      ['matrix-diff', 'bars-before-after'],
      ['Деньги проекта', 'Net profit'],
    ]);
  });

  it('keeps an own list the LLM left empty, as without a catalog', async () => {
    // SCENARIO: the reply names the draft and gives it no spec at all; the draws rule alone applies, as before DEV-1380
    // INPUT: v1 changed the draws; specs: []
    // EXPECTED: matrix-diff alone
    const reply = { widgets: [{ id: 'v1', specs: [] }] };
    const out = (await withCatalog['kairon.planWidgets'](scoredAll, ctxWith(scriptedLlm([JSON.stringify(reply)])))) as Out;
    expect(out.widgets['v1']?.map((w) => w.widget)).toEqual(['matrix-diff']);
  });

  it('gives no instance to a widget whose paths did not change or whose data is missing', async () => {
    // SCENARIO: the cover draft moves draws only; and a widget whose select failed has no data
    // INPUT: (a) changed funding.draws only, data for both widgets; (b) all paths changed, data for stub-profit only
    // EXPECTED: (a) no instances; (b) stub-profit alone
    const run = async (changed: Array<{ path: string; cells: number }>, data: Record<string, unknown>) =>
      ((await withCatalog['kairon.planWidgets']({ scored: s2(changed, data) }, ctxWith(scriptedLlm([JSON.stringify({ widgets: [] })])))) as Out).instances['v1']?.map((i) => i.widget);
    expect([
      await run([{ path: 'funding.draws', cells: 14 }], { 'stub-cash': cashData, 'stub-profit': profitData }),
      await run(ALL_CHANGED, { 'stub-profit': profitData }),
    ]).toEqual([[], ['stub-profit']]);
  });

  it('offers the catalog widgets to the LLM in the prompt and in the schema', async () => {
    // SCENARIO: the prompt and the response schema are built from the manifest
    // INPUT: one ok draft, the stub catalog
    // EXPECTED: the system prompt lists both stub widgets with what they read and never says «focus»; the spec
    //           alternatives end with a catalog spec whose widget enum is the two ids and whose only properties
    //           are widget and title, both required (the package's schema also carries focus; review I3)
    const llm = scriptedLlm([JSON.stringify({ widgets: [] })]);
    await withCatalog['kairon.planWidgets']({ scored: s2(ALL_CHANGED, {}) }, ctxWith(llm));
    const request = llm.complete.mock.calls[0]?.[0] as unknown as {
      messages: Array<{ content: string }>;
      responseSchema: {
        schema: { properties: { widgets: { items: { properties: { specs: { items: { anyOf: Array<{ properties: { widget: { enum: string[] } }; required: string[] }> } } } } } } };
      };
    };
    const system = request.messages[0]?.content ?? '';
    const alternatives = request.responseSchema.schema.properties.widgets.items.properties.specs.items.anyOf;
    expect([
      system.includes('- stub-cash: The cash line moved Reads: walk.cumulativeNetCashMinor.'),
      system.includes('- stub-profit: The profit moved Reads: netProfit, exit.month.'),
      system.includes('focus'),
      alternatives.length,
      alternatives.at(-1)?.properties.widget.enum,
      Object.keys(alternatives.at(-1)?.properties ?? {}),
      alternatives.at(-1)?.required,
    ]).toEqual([true, true, false, 5, ['stub-cash', 'stub-profit'], ['widget', 'title'], ['widget', 'title']]);
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
      headline: 'Ни один вариант не посчитан сервером, объяснять нечего. Причины отказов перечислены выше и в трассировке.',
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

  it('recommends nothing when every scored draft misses the active goal', async () => {
    // SCENARIO: Review Focus 1, +100 млн is out of reach; the only child v1.1 misses the goal (spec 5.6: never recommended)
    // INPUT: v1.1 ok and ranked, notRecommendable v1.1; the reply recommends v1.1
    // EXPECTED: 1 LLM call; recommendation '' and topRanked ''; the reason is passed on for the overview
    const reply = JSON.stringify({ headline: 'цель вне досягаемости', variants: [], whyRecommended: '', recommendation: 'v1.1', departureReason: null, caveats: [] });
    const llm = scriptedLlm([reply]);
    const notRecommendable = [{ id: 'v1.1', reason: 'не выполняет цель' }];
    const out = await activities['kairon.explainVariants'](
      { scenario: 's', scored: { variants: [ok('v1.1')], ranking: ['v1.1'], facts: {}, notRecommendable } },
      ctxWith(llm),
    );
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      headline: 'цель вне досягаемости',
      variants: [],
      whyRecommended: '',
      caveats: [],
      recommendation: '',
      topRanked: '',
      departureReason: null,
      ...EMPTY_OVERVIEW,
      notRecommendable,
      unknownPlaceholders: [],
      literalNumbers: [],
    });
  });

  it('asks again when the recommendation is a draft that misses the goal, even with a reason', async () => {
    // SCENARIO: v2 meets the goal, v3 misses it; the LLM recommends v3 and writes a departure reason
    // INPUT: ranking v2 > v3, notRecommendable v3; reply 1 recommends v3 with a reason; reply 2 recommends v2
    // EXPECTED: 2 LLM calls; the 2nd prompt says v3 cannot be recommended; recommendation v2
    const reply = (recommendation: string, departureReason: string | null) =>
      JSON.stringify({ headline: 'текст', variants: [], whyRecommended: '', recommendation, departureReason, caveats: [] });
    const llm = scriptedLlm([reply('v3', 'дешевле'), reply('v2', null)]);
    const out = await activities['kairon.explainVariants'](
      { scenario: 's', scored: { variants: [ok('v2'), ok('v3')], ranking: ['v2', 'v3'], facts: {}, notRecommendable: [{ id: 'v3', reason: 'не выполняет цель' }] } },
      ctxWith(llm),
    );
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(llm.complete.mock.calls[1]?.[0].messages.at(-1)?.content).toBe(
      'The variant v3 cannot be recommended: не выполняет цель. Recommend v2. Return the whole JSON again.',
    );
    expect(out).toMatchObject({ recommendation: 'v2', topRanked: 'v2', departureReason: null });
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
