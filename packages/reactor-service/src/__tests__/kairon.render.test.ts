// The card renderer module of the page (DEV-1376, spec 5.4): pure functions in
// web/kairon-render.mjs turn the server result into HTML strings. Every status
// carries an icon and a word, every text is escaped, every figure comes from the
// server result the function receives.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffVariant } from '../kairon/diff.js';
import { forecastDiffView } from '../kairon/diffView.js';
import { applyPatch, type ForecastPlan } from '../kairon/patch.js';
import { redLines } from '../kairon/redLines.js';
import { summarizeEvaluation } from '../kairon/summary.js';
import { fixtureDoc, readStage5, RIVERGATE_PARTNERS } from './_helpers/kaironFake.js';

interface RenderModule {
  renderVerdict(explanation: unknown, scoredVariant: unknown): string;
  renderStakeholders(scoredVariant: unknown, explanation: unknown): string;
  renderRedLines(lines: unknown): string;
  renderGoalChecks(goalChecks: unknown): string;
  renderReconciliations(reconciliations: unknown): string;
  renderOverview(explanation: unknown, scored: unknown): string;
  renderRejected(rejected: unknown): string;
  renderWidget(spec: unknown, scoredVariant: unknown): string;
  renderDiffView(diffView: unknown, currency?: unknown): string;
  saveOutcome(status: number, json: unknown): { text: string; canRetry: boolean };
  renderRouteNote(route: unknown): string;
  answersOf(out: unknown): Array<{ parentId: string; text: string }>;
  sessionExport(session: unknown, meta: unknown): unknown;
  instancesOf(out: unknown, variantId: string): unknown[];
  bundleState(info: unknown, module: unknown, error?: string): { bundle: unknown; cause: string | null; problem: string | null };
  instanceProblem(state: unknown, instance: unknown): { cause: string; text: string } | null;
  figureLine(instance: unknown, problem: { text: string }): string;
  placeInstances(
    state: unknown,
    instances: unknown[],
    hostOf: (instance: unknown) => unknown,
  ): Array<{ instance?: unknown; host?: unknown; unmount?: () => void; cause?: string; count?: number; line?: string }>;
  runFigureLine(out: unknown): string | null;
  undatedMilestonesLine(scored: unknown): string | null;
}

const MODULE = pathToFileURL(fileURLToPath(new URL('../../web/kairon-render.mjs', import.meta.url))).href;
const render = (await import(MODULE)) as RenderModule;

const coverLines = redLines({
  approved: summarizeEvaluation(readStage5('eval-approved.json')),
  partners: RIVERGATE_PARTNERS,
  irrPartnerIds: null,
  parentEval: readStage5('eval-active.json'),
  draftEval: readStage5('cover-cedar.eval.json'),
  currency: { decimals: 2, currencyCode: 'CZK' },
});
const coverMetrics = summarizeEvaluation(readStage5('cover-cedar.eval.json'));
const coverGoal = {
  goal: { type: 'funding_cover', partnerId: 'cedar', fromMonth: '2026-09', months: 2 },
  part: 'funding.draws',
  label: 'Cedar Partners покрывает всю потребность 2 мес. с 2026-09',
  parent: 'breach',
  draft: 'ok',
  months: [
    { month: '2026-09', parent: false, draft: true },
    { month: '2026-10', parent: false, draft: true },
  ],
};
const coverVariant = {
  id: 'v1.1',
  title: 'Cedar Partners покрывает всю потребность 2 мес. с 2026-09',
  metrics: coverMetrics,
  redLines: coverLines,
  goalChecks: [coverGoal],
  reconciliations: [
    { key: 'drawsEqualNeed', ok: true, text: 'Транши равны потребности.', source: 'Σ draws' },
    { key: 'onlyAsked', ok: true, text: 'Изменено только заказанное.', source: 'diff' },
    { key: 'bridgeCloses', ok: true, text: 'Остаток 0.', source: 'diff.bridge.other' },
    { key: 'repaidAtExit', ok: false, text: 'Bank: при выходе выплачено 1,0 из 2,0.', source: 'exit.bySource' },
  ],
};
const coverExplanation = {
  variants: [
    {
      id: 'v1.1',
      verdict: 'Цель выполнена, нужно согласие Solstice.',
      gives: ['Solstice не вносит деньги в окне цели.'],
      costs: ['IRR Cedar -0,18 п.п.'],
      stakeholders: [
        { party: 'cedar', meaning: 'вносит больше' },
        { party: 'bank', meaning: 'без изменений' },
      ],
    },
  ],
};

describe('kairon render: red lines', () => {
  it('shows the parity warning with its word, the frame bars and the source keys', () => {
    // SCENARIO: the Cedar cover draft (Task 5 output) crosses parity
    // INPUT: redLines(eval-active -> cover-cedar.eval)
    // EXPECTED: the parity sentence; ⚠ with «нужно согласие» and «в базе: ✓ в норме»; two frame bars; the parity series as bars; the source key
    const html = render.renderRedLines(coverLines);
    expect(html).toContain('Cedar Partners обгоняет Solstice Sponsor сверх своей доли на 33,1 млн CZK с 2026-10');
    expect(html).toContain('<span class="mk c-warn">⚠</span><span class="nm">Паритет партнёров<small>нужно согласие</small></span>');
    expect(html).toContain('<span class="base">в базе: <span class="c-ok">✓</span> в норме</span>');
    expect(html.split('aria-label="Рамка партнёра').length - 1).toBe(2);
    expect(html.split('<rect class="k-par"').length - 1).toBe(18);
    expect(html).toContain('<div class="key">draws · sourceGroups[].partnerId · settings.funding.partners[].sharePct</div>');
  });
});

describe('kairon render: verdict, stakeholders, goals, reconciliations', () => {
  it('puts four chips with icons and words above the verdict and the gives / costs lists', () => {
    // SCENARIO: the cover card's verdict block
    // INPUT: the cover variant (goal met 2 of 2 months, red lines ✓ 2 ⚠ 1 ✗ 2 в базе ○ 2, reconciliations 3 of 4)
    // EXPECTED: the four chips verbatim, the verdict sentence, «Даёт» and «Стоит»
    const html = render.renderVerdict(coverExplanation, coverVariant);
    expect(html).toContain('<span class="k-vchip"><span class="i-ok">✓</span> <b>Цель</b> · 2 из 2 мес</span>');
    expect(html).toContain('<span class="k-vchip warn"><span class="i-warn">⚠</span> <b>Красные линии</b> · ✓ 2 · ⚠ 1 · ✗ 2 в базе · ○ 2</span>');
    expect(html).toContain('<span class="k-vchip bad"><span class="i-bad">✗</span> <b>Сверки</b> · 3 из 4</span>');
    expect(html).toContain('<span class="k-vchip"><span class="i-none">○</span> <b>Не проверено</b> · 2: Ковенант банка LTC, Ковенант банка LTV</span>');
    expect(html).toContain('<div class="k-say">Цель выполнена, нужно согласие Solstice.</div>');
    expect(html).toContain('<h4>Даёт</h4><ul><li>Solstice не вносит деньги в окне цели.</li></ul>');
    expect(html).toContain('<h4>Стоит</h4><ul><li>IRR Cedar -0,18 п.п.</li></ul>');
  });

  it('names each party with its IRR and the meaning the LLM wrote', () => {
    // SCENARIO: «Кто что получил» for the cover draft
    // INPUT: stakeholders cedar and bank
    // EXPECTED: Cedar Partners with IRR 26,96 %; Банк with a dash
    const html = render.renderStakeholders(coverVariant, coverExplanation);
    expect(html).toContain('<tr><td>Cedar Partners</td><td>26,96 %</td><td>вносит больше</td></tr>');
    expect(html).toContain('<tr><td>Банк</td><td>—</td><td>без изменений</td></tr>');
  });

  it('marks the goal for the parent and the draft month by month', () => {
    // SCENARIO: b1, the cover goal checked per month
    // INPUT: the cover goal check, parent breach, draft ok
    // EXPECTED: the part, the label, ✗ 0 из 2 мес for the parent, ✓ 2 из 2 мес for the draft with month chips
    const html = render.renderGoalChecks([coverGoal]);
    expect(html).toContain('<td class="p">funding.draws</td><td>Cedar Partners покрывает всю потребность 2 мес. с 2026-09</td>');
    expect(html).toContain('<span class="mk-bad">0 из 2 мес</span><div class="k-months"><span class="n">2026-09</span><span class="n">2026-10</span></div>');
    expect(html).toContain('<span class="mk-ok">2 из 2 мес</span><div class="k-months"><span class="y">2026-09</span><span class="y">2026-10</span></div>');
  });

  it('lists the four reconciliations with a word per status', () => {
    // SCENARIO: the reconciliations block, one failing
    // INPUT: three ok, repaidAtExit failing
    // EXPECTED: ✓ «сходится» rows and one ✗ «не сходится» row with its text and source
    const html = render.renderReconciliations(coverVariant.reconciliations);
    expect(html).toContain('<span class="mk c-ok">✓</span><span class="nm">Транши = потребность<small>сходится</small></span>');
    expect(html).toContain(
      '<span class="mk c-bad">✗</span><span class="nm">Долги погашены при выходе<small>не сходится</small></span><div><div class="tx">Bank: при выходе выплачено 1,0 из 2,0.</div><div class="key">exit.bySource</div></div>',
    );
  });
});

describe('kairon render: recommendation overview', () => {
  const explanation = {
    headline: 'Обещание держится.',
    whyRecommended: 'Рычаги не нужны.',
    recommendation: 'v1',
    rules: ['Красные линии отсекают варианты.', 'При равенстве выигрывает вариант с меньшим числом рычагов.'],
    switches: [
      { label: 'Важна прибыль как в плане', goal: { type: 'max_net_profit' }, winner: 'v4' },
      { label: 'Меньше денег партнёров', goal: { type: 'min_partner_cash' }, winner: 'v4' },
      { label: 'Прибыль без траты резерва', goal: { type: 'keep_reserve' }, winner: 'v3' },
    ],
    matrix: [{ step: 3, label: 'Рычаги', values: { v1: 'нет', v4: 'резерв, цены' }, best: 'v1' }],
    whyNotOthers: [{ id: 'v4', reason: 'Несёт оба риска сразу.' }],
    dropped: [{ id: 'v5', sameAs: 'v1' }],
  };
  const scored = {
    ranking: ['v1', 'v4'],
    variants: [
      { id: 'v1', title: '<script>alert(1)</script>' },
      { id: 'v4', title: 'Резерв и цены' },
    ],
  };

  it('lists the rules, the criteria, why not the others and the three switches with winners', () => {
    // SCENARIO: the overview above the scenario 2 cards
    // INPUT: recommendation v1, 2 rules, a matrix row, whyNotOthers v4, dropped v5, 3 switches
    // EXPECTED: rules numbered in order; the recommended column marked; v4's reason and v5 as dropped; each switch label → winner
    const html = render.renderOverview(explanation, scored);
    expect(html).toContain('<ol class="k-rules"><li>Красные линии отсекают варианты.</li><li>При равенстве выигрывает вариант с меньшим числом рычагов.</li></ol>');
    expect(html).toContain('<tr><td>3. Рычаги</td><td class="win best">нет</td><td>резерв, цены</td></tr>');
    expect(html).toContain('<li>v4: Несёт оба риска сразу.</li><li>v5 отброшен: совпал с v1.</li>');
    for (const [label, winner] of [
      ['Важна прибыль как в плане', 'v4'],
      ['Меньше денег партнёров', 'v4'],
      ['Прибыль без траты резерва', 'v3'],
    ]) {
      expect(html).toContain(`${label} → <b>${winner}</b>`);
    }
  });

  it('says no draft can be recommended and why when every scored draft misses the goal', () => {
    // SCENARIO: Review Focus 1, the only child v1.1 misses the +100 млн goal; the server blanked the recommendation
    // INPUT: recommendation '', notRecommendable v1.1 «не выполняет цель», ranking [v1.1]
    // EXPECTED: the head says nothing is recommended because of the goal; «Почему не другие» names v1.1 and the reason
    const html = render.renderOverview(
      { ...explanation, recommendation: '', whyNotOthers: [], dropped: [], notRecommendable: [{ id: 'v1.1', reason: 'не выполняет цель' }] },
      { ranking: ['v1.1'], variants: [{ id: 'v1.1', title: 'Цены квартир вверх' }] },
    );
    expect(html).toContain('<div class="k-rec">Рекомендации нет: ни один вариант не выполняет цель запроса без нового нарушения красной линии</div>');
    expect(html).toContain('<ul class="k-not"><li>v1.1 не рекомендуется: не выполняет цель.</li></ul>');
  });

  it('lists the drafts the server refused with their errors, escaped', () => {
    // SCENARIO: Review Focus 2 and 4, a stale parent and a cover window in a closed month never reach scoring
    // INPUT: rejected v2 (title = id) with the stale text; v3 «<b>x</b>» with a closed-month error; then []
    // EXPECTED: one list, the title only when it differs from the id, markup escaped; '' for no refusals
    const html = render.renderRejected([
      { id: 'v2', title: 'v2', errors: ['Активный прогноз изменился, начните новый сценарий'] },
      { id: 'v3', title: '<b>x</b>', errors: ['2026-07: closed through 2026-08', 'второй'] },
    ]);
    expect(html).toBe(
      '<div class="k-rejected"><div class="k-part">Сервер отклонил</div><ul>' +
        '<li><b>v2</b>: Активный прогноз изменился, начните новый сценарий</li>' +
        '<li><b>v3</b> «&lt;b&gt;x&lt;/b&gt;»: 2026-07: closed through 2026-08; второй</li>' +
        '</ul></div>',
    );
    expect(render.renderRejected([])).toBe('');
  });

  it('escapes a title that carries markup', () => {
    // SCENARIO: a draft title written by the LLM contains a script tag
    // INPUT: v1 titled <script>alert(1)</script>
    // EXPECTED: the title appears escaped; no raw <script> in the output
    const html = render.renderOverview(explanation, scored);
    expect(html).toContain('Рекомендую v1: &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.includes('<script>')).toBe(false);
  });
});

describe('kairon render: widgets', () => {
  const windowMonths = ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
  const coverDraft = {
    id: 'v1.1',
    goalChecks: [
      {
        goal: { type: 'funding_cover', partnerId: 'cedar', fromMonth: '2026-09', months: 6 },
        part: 'funding.draws',
        label: 'Cedar Partners покрывает всю потребность 6 мес. с 2026-09',
        parent: 'breach',
        draft: 'ok',
        months: windowMonths.map((month) => ({ month, parent: false, draft: true })),
      },
    ],
  };

  it('draws the goal check, the one widget the page draws itself (DEV-1381)', () => {
    // SCENARIO: the widgets step named condition-check for the cover draft
    // INPUT: the spec { condition-check, «Цель» }, the draft with one goal check
    // EXPECTED: a widget box with the title, the tag «b1 · цели» and the goal's label
    const html = render.renderWidget({ widget: 'condition-check', title: 'Цель', goals: 'active' }, coverDraft);
    expect([
      html.includes('<div class="k-wh"><b>Цель</b><span class="k-tag">b1 · цели</span></div>'),
      html.includes('Cedar Partners покрывает всю потребность 6 мес. с 2026-09'),
    ]).toEqual([true, true]);
  });

  it('draws nothing for a declarative widget the catalog replaced', () => {
    // SCENARIO: a session recorded before DEV-1381 carries matrix-diff, bars-before-after and stakeholder-table specs
    // INPUT: one spec of each
    // EXPECTED: an empty string for each: the figures are catalog widgets now
    const specs = [
      { widget: 'matrix-diff', title: 'Транши' },
      { widget: 'bars-before-after', title: 'Было и стало' },
      { widget: 'stakeholder-table', title: 'Стороны', rows: ['Cedar Partners'] },
    ];
    expect(specs.map((spec) => render.renderWidget(spec, coverDraft))).toEqual(['', '', '']);
  });
});

describe('kairon render: diff view copy', () => {
  it('fills the tiles for construction +8 % with words for costs', () => {
    // SCENARIO: s2-v1 against the active forecast (Task 8 data)
    // INPUT: forecastDiffView of s2-v1
    // EXPECTED: «Затраты к базе» 53,7 млн CZK перерасход; «Не покрыто финансированием» 0,0 млн CZK; D5 among the changed lines
    const CZK = { decimals: 2, currencyCode: 'CZK' };
    const parentPlan = applyPatch(fixtureDoc, { name: 'active' }).plan;
    const draftPlan = (readStage5('s2-v1.body.json') as { plan: ForecastPlan }).plan;
    const pe = readStage5('eval-active.json');
    const de = readStage5('s2-v1.eval.json');
    const diff = diffVariant({ currency: CZK, closedThrough: '2026-08', derivedLineCodes: [], activePlan: parentPlan, variantPlan: draftPlan, activeEval: pe, variantEval: de });
    const view = forecastDiffView({ parentPlan, draftPlan, approvedPlan: readStage5('approved-plan.json') as ForecastPlan, parentEval: pe, draftEval: de, diff, revenueGroups: ['R', 'C'] });
    const html = render.renderDiffView(view, CZK);
    expect(html).toContain('<div class="c">Затраты к базе</div><div class="n">53,7 млн CZK</div><div class="d">перерасход</div>');
    expect(html).toContain('<div class="c">Не покрыто финансированием</div><div class="n">0,0 млн CZK</div><div class="d">в родителе 0,0 млн CZK</div>');
    expect(html).toContain('<td>D5</td><td>Construction - new build</td>');
  });
});

describe('kairon render: save outcome', () => {
  it('names the created draft and says it is not active', () => {
    // SCENARIO: «Сохранить как черновик» answered 200 (DEV-1377)
    // INPUT: status 200, {versionId: 'ver-1', name: 'S2 · v1'}
    // EXPECTED: the created text with the name and the id; no retry
    expect(render.saveOutcome(200, { versionId: 'ver-1', name: 'S2 · v1' })).toEqual({
      text: 'Создан черновик «S2 · v1» (ver-1). Версия не активна: активировать её можно только в Kairon.',
      canRetry: false,
    });
  });

  it('forbids a retry when the version was created without its draws', () => {
    // SCENARIO: Kairon created the version and then refused the funding PUT; a second click would create a second version
    // INPUT: status 409 with the error and the versionId of the half-saved draft
    // EXPECTED: the server text plus the warning about a second version; no retry
    expect(render.saveOutcome(409, { error: 'Черновик ver-1 создан без траншей: Kairon ответил 409: revision', versionId: 'ver-1' })).toEqual({
      text: 'Черновик ver-1 создан без траншей: Kairon ответил 409: revision. Повторное сохранение создаст вторую версию.',
      canRetry: false,
    });
  });

  it('allows a retry when nothing was created', () => {
    // SCENARIO: Kairon refused the create itself, so no version exists and a second click may succeed
    // INPUT: status 409, {error: 'Kairon ответил 409: A version with this name exists'}, no versionId, not stale
    // EXPECTED: «Не сохранено: …»; the button may be pressed again
    expect(render.saveOutcome(409, { error: 'Kairon ответил 409: A version with this name exists' })).toEqual({
      text: 'Не сохранено: Kairon ответил 409: A version with this name exists',
      canRetry: true,
    });
  });

  it('forbids a retry of a stale draft, which can never be saved', () => {
    // SCENARIO: DEV-1377 review, the active forecast changed after the draft was built; every further click answers the same 409
    // INPUT: status 409, {error: 'Активный прогноз изменился, начните новый сценарий', stale: true}
    // EXPECTED: «Не сохранено: …» with the server's text, which already tells the user to start a new scenario; no retry
    expect(render.saveOutcome(409, { error: 'Активный прогноз изменился, начните новый сценарий', stale: true })).toEqual({
      text: 'Не сохранено: Активный прогноз изменился, начните новый сценарий',
      canRetry: false,
    });
  });
});

describe('kairon render: route note', () => {
  it('says above the answer that the route was not parsed, escaped', () => {
    // SCENARIO: DEV-1377, the router failed twice and fell back to a question; the user must see why the answer is a question's
    // INPUT: a route with the error «scope: unknown draft <v5>; known: v1, all»; then a route without an error
    // EXPECTED: one note with the error escaped and the fallback named; '' when the route has no error
    expect(render.renderRouteNote({ kind: 'question', scope: [], error: 'scope: unknown draft <v5>; known: v1, all' })).toBe(
      '<div class="k-route-note">Маршрут не разобран: scope: unknown draft &lt;v5&gt;; known: v1, all. Ответ дан как на вопрос.</div>',
    );
    expect(render.renderRouteNote({ kind: 'goal_change', scope: ['v2'], error: null })).toBe('');
  });
});

describe('kairon render: answers of a run', () => {
  it('reads the answers from the scoring, which adds its own to the goal drafts\' answers', () => {
    // SCENARIO: DEV-1377 review, scoreVariants copies the goal drafts' answers and adds «ближе всего vN»; the page showed only the drafts' answers
    // INPUT: a goal change output: drafts.answers = 1 «Цель уже выполнена», scored.answers = that line + «ближе всего v1.1»
    // EXPECTED: both lines, in the scoring's order
    const met = { parentId: 'v2', text: 'Цель уже выполнена в v2' };
    const closest = { parentId: 'v1', text: 'Цель недостижима рычагами в пределах ±3 %: ближе всего v1.1' };
    expect(render.answersOf({ drafts: { answers: [met] }, scored: { answers: [met, closest] } })).toEqual([met, closest]);
  });

  it('reads a generate run the same way and a recording without answers as none', () => {
    // SCENARIO: a generate run has no goal drafts; a stage 4 recording was saved before the scoring carried answers
    // INPUT: {proposals, scored: {answers: []}}; then {scored: {}}
    // EXPECTED: [] for both
    expect(render.answersOf({ proposals: { variants: [] }, scored: { answers: [] } })).toEqual([]);
    expect(render.answersOf({ scored: {} })).toEqual([]);
  });
});

describe('kairon render: session export', () => {
  const ev = (t: number, type: string, payload: unknown) => ({ t, type, payload });

  it('puts every run of every message into one JSON document with a step index', () => {
    // SCENARIO: the owner exports a whole session for analysis: one generate message (route run + execute run) and one question
    // INPUT: session.record with 3 runs, their events as /kairon/run streamed them; one section with a goal, a selected draft and 2 drafts
    // EXPECTED: format and version, the meta, 2 messages (2 runs and 1 run), per run the tools, LLM calls and Kairon calls in order
    //           with timings, tokens and cost, the events untouched, and the section state without page nodes
    const routeEvents = [
      ev(0, 'run.start', { request: { idea: {}, providerConfig: { provider: 'openrouter', model: 'm/x', apiKey: 'sk-or-…abcd' } } }),
      ev(1, 'tool.start', { tool: 'kairon.route', kind: 'latent', inputSchema: {}, args: { message: 'Сдвиг на 6 месяцев' } }),
      ev(2, 'llm.request', { callId: 'llm-1', label: 'route, attempt 1', url: 'u', body: {} }),
      ev(900, 'llm.done', { callId: 'llm-1', ms: 898, model: 'm/x', finishReason: 'stop', content: '{}', usage: { prompt_tokens: 1057, completion_tokens: 242, cost: 0.00168 } }),
      ev(901, 'tool.end', { tool: 'kairon.route', ms: 900, output: { kind: 'generate', scope: [], error: null } }),
      ev(902, 'run.done', { ms: 902, solution: { output: { route: { kind: 'generate' } } } }),
    ];
    const executeEvents = [
      ev(0, 'run.start', { request: { idea: {}, providerConfig: { provider: 'openrouter', model: 'm/x', apiKey: 'sk-or-…abcd' } } }),
      ev(1, 'tool.start', { tool: 'kairon.baseline', kind: 'deterministic', inputSchema: {}, args: {} }),
      ev(330, 'kairon.call', { op: 'listVersions', method: 'GET', path: '/p', status: 200, ms: 328, response: [] }),
      ev(886, 'tool.end', { tool: 'kairon.baseline', ms: 886, output: {} }),
      ev(887, 'tool.start', { tool: 'kairon.scoreVariants', kind: 'deterministic', inputSchema: {}, args: {} }),
      ev(900, 'run.error', { class: 'ZodError', message: 'bad input' }),
    ];
    const questionEvents = [ev(0, 'run.start', { request: { idea: {}, providerConfig: {} } }), ev(5, 'run.done', { ms: 5, solution: { output: {} } })];
    const run = (events: unknown[], failure: string | null) => ({ events, runRequest: null, solution: null, failure });
    const session = {
      record: [
        { message: 'Сдвиг на 6 месяцев', step: 'route', run: run(routeEvents, null) },
        { message: 'Сдвиг на 6 месяцев', step: 'execute', run: run(executeEvents, 'ZodError: bad input') },
        { message: 'А где банк?', step: 'route', run: run(questionEvents, null) },
      ],
      selected: { section: 'S1', id: 'v2' },
      sections: [
        {
          id: 'S1',
          scenario: 'Сдвиг на 6 месяцев',
          spec: { type: 'free' },
          goals: [{ type: 'irr_floor', partnerIds: ['cedar'] }],
          facts: { 'v1.irr.cedar': '21,28 %' },
          chips: { nodeType: 1 },
          drafts: new Map([
            ['v1', { id: 'v1', parentId: null, title: 'База', status: 'ok', levers: [], lineage: { steps: [] }, diff: { big: true } }],
            ['v2', { id: 'v2', parentId: null, title: 'Цены', status: 'ok', levers: ['цены'], lineage: { steps: [] }, diff: { big: true } }],
          ]),
        },
      ],
    };

    const out = render.sessionExport(session, { exportedAt: '2026-11-14T10:00:00.000Z', model: 'm/x', variantCount: 3 });

    expect(out).toEqual({
      format: 'kairon-reactor-session',
      version: 1,
      exportedAt: '2026-11-14T10:00:00.000Z',
      model: 'm/x',
      variantCount: 3,
      messages: [
        {
          index: 1,
          text: 'Сдвиг на 6 месяцев',
          runs: [
            {
              step: 'route',
              failure: null,
              ms: 902,
              tools: [{ tool: 'kairon.route', ms: 900, ended: true }],
              llm: [{ callId: 'llm-1', label: 'route, attempt 1', model: 'm/x', ms: 898, finishReason: 'stop', tokensIn: 1057, tokensOut: 242, costUsd: 0.00168 }],
              kairon: [],
              events: routeEvents,
            },
            {
              step: 'execute',
              failure: 'ZodError: bad input',
              ms: null,
              tools: [
                { tool: 'kairon.baseline', ms: 886, ended: true },
                { tool: 'kairon.scoreVariants', ms: null, ended: false },
              ],
              llm: [],
              kairon: [{ op: 'listVersions', method: 'GET', status: 200, ms: 328 }],
              events: executeEvents,
            },
          ],
        },
        {
          index: 2,
          text: 'А где банк?',
          runs: [{ step: 'route', failure: null, ms: 5, tools: [], llm: [], kairon: [], events: questionEvents }],
        },
      ],
      sections: [
        {
          id: 'S1',
          scenario: 'Сдвиг на 6 месяцев',
          spec: { type: 'free' },
          goals: [{ type: 'irr_floor', partnerIds: ['cedar'] }],
          selected: 'v2',
          drafts: [
            { id: 'v1', parentId: null, title: 'База', status: 'ok', levers: [], lineage: { steps: [] } },
            { id: 'v2', parentId: null, title: 'Цены', status: 'ok', levers: ['цены'], lineage: { steps: [] } },
          ],
        },
      ],
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe('catalog widgets on the page (DEV-1380)', () => {
  // cash-line is at version 2 since DEV-1388: series { subject, slot, read, points } in place of two point lists.
  const cashSeries = (id: string, role: string, slot: number) => ({ subject: { id, label: id, role }, slot, read: 'loaded', points: [] });
  const cash = {
    widget: 'cash-line',
    version: 2,
    buildId: 'b1',
    spec: { widget: 'cash-line', title: 'Деньги' },
    data: { current: cashSeries('v1', 'draft', 1), baseline: [cashSeries('active', 'active', 0)], others: [] },
    provenance: 'kairon',
  };
  const kpi = { widget: 'kpi-tiles', version: 1, buildId: 'b1', spec: { widget: 'kpi-tiles', title: 'Показатели' }, data: { tiles: 5 }, provenance: 'kairon' };
  const need = { widget: 'need-rows', version: 1, buildId: 'b1', spec: { widget: 'need-rows', title: 'Потребность' }, data: { rows: 3 }, provenance: 'kairon' };
  const host = { id: 'host' };

  /**
   * A stand-in for the bundle of build b1: records what mount() was called with and counts unmounts.
   * Its catalog carries kpi-tiles and need-rows at version 1, cash-line at version 2, and refuses data that holds `broken`.
   */
  function fakeBundle() {
    const calls: unknown[][] = [];
    let unmounted = 0;
    return {
      calls,
      unmounted: () => unmounted,
      buildId: 'b1',
      catalog: {
        manifest: () => [
          { id: 'kpi-tiles', version: 1 },
          { id: 'cash-line', version: 2 },
          { id: 'need-rows', version: 1 },
        ],
        parseData: (id: string, data: { broken?: boolean }) => {
          if (data.broken === true) throw new Error(`widget "${id}" got data that breaks its schema`);
          return data;
        },
      },
      mount: (...args: unknown[]) => {
        calls.push(args);
        return () => {
          unmounted += 1;
        };
      },
    };
  }

  it('reads the instances of a draft from the widgets step, in the server\'s order', () => {
    // SCENARIO: a run made with the widgets catalog carries instances per draft; the page names no widget id (DEV-1381)
    // INPUT: out.widgets.instances = { v1: [kpi-tiles, need-rows, cash-line] }; asked for v1 and for v2
    // EXPECTED: v1 gives the three instances in that order; v2 gives none
    const out = { widgets: { widgets: {}, instances: { v1: [kpi, need, cash] } } };
    expect([render.instancesOf(out, 'v1'), render.instancesOf(out, 'v2')]).toEqual([[kpi, need, cash], []]);
  });

  it('reads no instances from a run recorded before DEV-1380', () => {
    // SCENARIO: a saved session of the old code replays on the new page
    // INPUT: a run whose widgets step returned specs alone; a run with no widgets step
    // EXPECTED: no instances for either, so the page draws with its own renderers
    expect([render.instancesOf({ widgets: { widgets: { v1: [] } } }, 'v1'), render.instancesOf({}, 'v1')]).toEqual([[], []]);
  });

  const loaded = () => {
    const bundle = fakeBundle();
    return { bundle, state: render.bundleState({ bundle: '/x', buildId: 'b1' }, bundle) };
  };

  it('states why the page has no bundle', () => {
    // SCENARIO: a figure the bundle cannot draw gets one line naming the cause; the first cause is the bundle itself
    // INPUT: (a) the service names no bundle; (b) the import failed; (c) the bundle is of another build than the
    //        service states; (d) the bundle of the stated build
    // EXPECTED: (a), (b) no-bundle with the reason; (c) stale-build naming both builds; (d) the bundle and no problem
    const bundle = fakeBundle();
    expect([
      render.bundleState({ bundle: null, buildId: null }, null),
      render.bundleState({ bundle: '/x', buildId: 'b1' }, null, 'SyntaxError: Unexpected token'),
      render.bundleState({ bundle: '/x', buildId: 'b2' }, bundle),
      render.bundleState({ bundle: '/x', buildId: 'b1' }, bundle).bundle === bundle,
      render.bundleState({ bundle: '/x', buildId: 'b1' }, bundle).problem,
    ]).toEqual([
      { bundle: null, cause: 'no-bundle', problem: 'сервис запущен без сборки виджетов (KAIRON_WIDGETS_DIST не задан или сборка не загрузилась)' },
      { bundle: null, cause: 'no-bundle', problem: 'бандл виджетов не загрузился: SyntaxError: Unexpected token' },
      { bundle: null, cause: 'stale-build', problem: 'сервис называет сборку b2, загруженный бандл собран как b1' },
      true,
      null,
    ]);
  });

  it('names the cause an instance cannot be drawn for', () => {
    // SCENARIO: no bundle, a stale build, a version the bundle lacks, data that breaks the schema (DEV-1381)
    // INPUT: the cash instance against: no bundle; the bundle b1 with the instance stamped b0, and unstamped; the
    //        instance at version 2; an instance of a widget the bundle lacks; data the bundle refuses; the instance as is
    // EXPECTED: the four causes with their texts; null for the instance the bundle draws
    const { state } = loaded();
    const { buildId: _stamp, ...unstamped } = cash;
    expect([
      render.instanceProblem(render.bundleState({ bundle: null, buildId: null }, null), cash),
      render.instanceProblem(state, { ...cash, buildId: 'b0' }),
      render.instanceProblem(state, unstamped),
      render.instanceProblem(state, { ...cash, version: 1 }),
      render.instanceProblem(state, { ...cash, widget: 'nope' }),
      render.instanceProblem(state, { ...cash, data: { broken: true } }),
      render.instanceProblem(state, cash),
    ]).toEqual([
      { cause: 'no-bundle', text: 'сервис запущен без сборки виджетов (KAIRON_WIDGETS_DIST не задан или сборка не загрузилась)' },
      { cause: 'stale-build', text: 'данные собраны сборкой b0, страница загрузила сборку b1' },
      { cause: 'stale-build', text: 'данные собраны без отметки сборки, страница загрузила сборку b1' },
      { cause: 'version', text: 'в данных версия виджета 1, в загруженной сборке 2' },
      { cause: 'version', text: 'в загруженной сборке нет виджета nope' },
      { cause: 'data', text: 'данные не проходят схему виджета' },
      null,
    ]);
  });

  it('writes the line shown in place of a figure', () => {
    // SCENARIO: the page shows one line where the figure would be
    // INPUT: the cash instance titled «Деньги» and a version problem; an instance with no title
    // EXPECTED: the title in quotes, then the cause; the widget id stands in for a missing title
    const problem = { cause: 'version', text: 'в данных версия виджета 1, в загруженной сборке 2' };
    expect([render.figureLine(cash, problem), render.figureLine({ widget: 'cash-line', spec: {} }, problem)]).toEqual([
      '«Деньги»: фигура не нарисована, в данных версия виджета 1, в загруженной сборке 2.',
      '«cash-line»: фигура не нарисована, в данных версия виджета 1, в загруженной сборке 2.',
    ]);
  });

  it('mounts every instance the bundle draws, each in its own host, in the server\'s order', () => {
    // SCENARIO: the server assembled three instances; the bundle's manifest carries all three widgets (DEV-1381)
    // INPUT: instances kpi-tiles, need-rows, cash-line; a host made per instance
    // EXPECTED: three mounts in that order, each with its own host and in Russian; the hosts come back with their unmounts
    const { bundle, state } = loaded();
    const placed = render.placeInstances(state, [kpi, need, cash], (instance) => ({ hostOf: (instance as { widget: string }).widget }));
    placed.forEach((p) => p.unmount?.());
    expect([bundle.calls, placed.map((p) => [p.host, p.line]), bundle.unmounted()]).toEqual([
      [
        [{ hostOf: 'kpi-tiles' }, kpi, { locale: 'ru' }],
        [{ hostOf: 'need-rows' }, need, { locale: 'ru' }],
        [{ hostOf: 'cash-line' }, cash, { locale: 'ru' }],
      ],
      [
        [{ hostOf: 'kpi-tiles' }, undefined],
        [{ hostOf: 'need-rows' }, undefined],
        [{ hostOf: 'cash-line' }, undefined],
      ],
      3,
    ]);
  });

  it('puts a line in place of each instance it cannot draw and mounts the rest', () => {
    // SCENARIO: one instance is of a version the bundle lacks, one has broken data; the figures are the bundle's alone
    // INPUT: kpi-tiles, cash-line at version 1 (recorded before DEV-1388), need-rows with broken data; the bundle b1
    // EXPECTED: kpi-tiles mounted; a line with the cause for the other two, in the server's order; no host made for them
    const { state } = loaded();
    const hosts: string[] = [];
    const hostOf = (instance: unknown) => {
      hosts.push((instance as { widget: string }).widget);
      return { hostOf: (instance as { widget: string }).widget };
    };
    const placed = render.placeInstances(state, [kpi, { ...cash, version: 1 }, { ...need, data: { broken: true } }], hostOf);
    expect([placed.map((p) => [p.host, p.cause, p.line]), hosts]).toEqual([
      [
        [{ hostOf: 'kpi-tiles' }, undefined, undefined],
        [undefined, 'version', '«Деньги»: фигура не нарисована, в данных версия виджета 1, в загруженной сборке 2.'],
        [undefined, 'data', '«Потребность»: фигура не нарисована, данные не проходят схему виджета.'],
      ],
      ['kpi-tiles'],
    ]);
  });

  it('puts one line for the card when every instance fails for the same bundle or build cause', () => {
    // SCENARIO: with no bundle, or a stale build, a card printed 14 identical lines (review M7b)
    // INPUT: (a) two instances, no bundle; (b) three instances stamped b0 against the bundle b1
    // EXPECTED: one line each, naming the count and the cause; no mount
    const none = render.bundleState({ bundle: null, buildId: null }, null);
    const { bundle, state } = loaded();
    const stale = [kpi, need, cash].map((instance) => ({ ...instance, buildId: 'b0' }));
    expect([
      render.placeInstances(none, [kpi, cash], () => ({})).map((p) => [p.cause, p.count, p.line]),
      render.placeInstances(state, stale, () => ({})).map((p) => [p.cause, p.count, p.line]),
      bundle.calls,
    ]).toEqual([
      [['no-bundle', 2, 'Фигуры не нарисованы (2): сервис запущен без сборки виджетов (KAIRON_WIDGETS_DIST не задан или сборка не загрузилась).']],
      [['stale-build', 3, 'Фигуры не нарисованы (3): данные собраны сборкой b0, страница загрузила сборку b1.']],
      [],
    ]);
  });

  it('keeps a line per instance when the causes differ or there is one instance', () => {
    // SCENARIO: one stale instance beside one the bundle draws; and a card with a single instance and no bundle
    // INPUT: (a) kpi-tiles as is and cash-line stamped b0, the bundle b1; (b) cash-line alone, no bundle
    // EXPECTED: (a) kpi-tiles mounted and one titled line for cash-line; (b) one titled line
    const { state } = loaded();
    const none = render.bundleState({ bundle: null, buildId: null }, null);
    expect([
      render.placeInstances(state, [kpi, { ...cash, buildId: 'b0' }], () => ({ host: true })).map((p) => [p.host, p.line]),
      render.placeInstances(none, [cash], () => ({})).map((p) => p.line),
    ]).toEqual([
      [
        [{ host: true }, undefined],
        [undefined, '«Деньги»: фигура не нарисована, данные собраны сборкой b0, страница загрузила сборку b1.'],
      ],
      ['«Деньги»: фигура не нарисована, сервис запущен без сборки виджетов (KAIRON_WIDGETS_DIST не задан или сборка не загрузилась).'],
    ]);
  });

  it('puts a line when the bundle fails while mounting', () => {
    // SCENARIO: a bundle that throws must not take the draft card down
    // INPUT: a bundle whose mount throws «boom»
    // EXPECTED: one line naming the failure
    const bundle = {
      ...fakeBundle(),
      mount: () => {
        throw new Error('boom');
      },
    };
    const state = render.bundleState({ bundle: '/x', buildId: 'b1' }, bundle);
    expect(render.placeInstances(state, [cash], () => ({})).map((p) => [p.cause, p.line])).toEqual([['mount', '«Деньги»: фигура не нарисована, виджет не нарисовался: boom.']]);
  });

  it('says why a run has no figure at all', () => {
    // SCENARIO: a run made with no widgets catalog has no instances; a stage 4 recording has no widgets step (review M7a)
    // INPUT: (a) a run whose widgets step returned specs alone; (b) a run with no widgets step; (c) a run with instances
    // EXPECTED: (a) made with no catalog; (b) the recording predates the catalog; (c) null
    expect([render.runFigureLine({ widgets: { widgets: { v1: [] } } }), render.runFigureLine({}), render.runFigureLine({ widgets: { widgets: {}, instances: { v1: [] } } })]).toEqual([
      'Фигуры не нарисованы: прогон сделан без каталога виджетов (сервис работал без KAIRON_WIDGETS_DIST).',
      'Фигуры не нарисованы: запись сделана до каталога виджетов.',
      null,
    ]);
  });

  it('names the milestones the widgets leave out for having no due date', () => {
    // SCENARIO: Kairon serves a milestone with no due date; the widgets take dated ones only (review M1)
    // INPUT: a scored run naming HANDOVER and SALES_END; one naming none; one made with no catalog
    // EXPECTED: one line with both codes; null; null
    expect([
      render.undatedMilestonesLine({ undatedMilestones: ['HANDOVER', 'SALES_END'] }),
      render.undatedMilestonesLine({ undatedMilestones: [] }),
      render.undatedMilestonesLine({}),
    ]).toEqual(['Вехи без срока не показаны в виджетах: HANDOVER, SALES_END.', null, null]);
  });
});
