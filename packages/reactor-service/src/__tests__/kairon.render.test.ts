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
import { defaultWidgets, widgetInputs } from '../kairon/widgets.js';
import { fixtureDoc, readStage5, RIVERGATE_PARTNERS } from './_helpers/kaironFake.js';

interface RenderModule {
  renderVerdict(explanation: unknown, scoredVariant: unknown): string;
  renderStakeholders(scoredVariant: unknown, explanation: unknown): string;
  renderRedLines(lines: unknown): string;
  renderGoalChecks(goalChecks: unknown): string;
  renderReconciliations(reconciliations: unknown): string;
  renderOverview(explanation: unknown, scored: unknown): string;
  renderRejected(rejected: unknown): string;
  renderWidget(spec: unknown, scoredVariant: unknown, parentEval: unknown, draftEval: unknown): string;
  renderDiffView(diffView: unknown, currency?: unknown): string;
  saveOutcome(status: number, json: unknown): { text: string; canRetry: boolean };
  renderRouteNote(route: unknown): string;
  answersOf(out: unknown): Array<{ parentId: string; text: string }>;
  sessionExport(session: unknown, meta: unknown): unknown;
  instancesOf(out: unknown, variantId: string): unknown[];
  mountInstances(bundle: unknown, instances: unknown[], hostOf: (instance: unknown) => unknown): Array<{ host: unknown; unmount: () => void }>;
  mountInstance(host: unknown, bundle: unknown, instance: unknown): (() => void) | null;
  acceptBundle(module: unknown, info: unknown): unknown;
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
  const [matrixSpec, barsSpec] = defaultWidgets([{ path: 'funding.draws', cells: 14 }]);
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
  // The page passes the scored variant's widgetInputs, the trimmed evaluations (Task 19).
  const parentEval = widgetInputs(readStage5('eval-active.json'));
  const draftEval = widgetInputs(readStage5('cover-cedar.eval.json'));
  const rowOf = (html: string, name: string) => {
    const start = html.indexOf(`<tr><td>${name}</td>`);
    return start === -1 ? '' : html.slice(start, html.indexOf('</tr>', start) + 5);
  };

  it('shows the w1 matrix with the window delta and the row total, draft minus parent', () => {
    // SCENARIO: the Cedar cover draft; the funding rule pays Solstice's share back in 2027-03 and 2027-04
    // INPUT: matrix-diff spec; eval-active as the parent, cover-cedar.eval as the draft; the goal window 2026-09..2027-02
    // EXPECTED: columns 2026-09..2027-04; Cedar Δ in the window +33,1 and Σ Δ ±0,0; Solstice −33,1 and ±0,0; changed cells carry the delta
    const html = render.renderWidget(matrixSpec, coverDraft, parentEval, draftEval);
    expect(html.split('<th class="m">').length - 1).toBe(8);
    expect(rowOf(html, 'Cedar Partners loan')).toContain('<td class="sum"><b>+33,1</b></td><td class="sum">±0,0</td></tr>');
    expect(rowOf(html, 'Solstice Sponsor loan')).toContain('<td class="sum"><b>−33,1</b></td><td class="sum">±0,0</td></tr>');
    expect(rowOf(html, 'Cedar Partners loan')).toContain('<td class="chg"><b>8,2</b><small>+2,7</small></td>');
  });

  it('draws one before/after pair per month and labels the delta of the goal partner', () => {
    // SCENARIO: the w2 bars for the same draft
    // INPUT: bars-before-after spec
    // EXPECTED: 8 month pairs; the legend names the Cedar source as the labelled delta
    const html = render.renderWidget(barsSpec, coverDraft, parentEval, draftEval);
    expect(html.split('<g class="k-pair"').length - 1).toBe(8);
    expect(html).toContain('подпись: Δ Cedar Partners loan, млн');
  });

  it('keeps 52 units per month when 22 months changed, so labels never overlap', () => {
    // SCENARIO: a price lever moves the funding rule's tranches in 22 months (stage 5 demo phrase 5)
    // INPUT: one source, parent 10,0 млн and draft 10,2 млн in every month 2026-09..2028-06
    // EXPECTED: 22 pairs; viewBox width 30 + 22 × 52 + 4 = 1178; the SVG is drawn 1767 px wide and scrolls in its card
    const months = Array.from({ length: 22 }, (_, i) => `${2026 + Math.floor((8 + i) / 12)}-${String(((8 + i) % 12) + 1).padStart(2, '0')}`);
    const inputs = (amountMinor: string) => ({
      draws: months.map((m) => ({ sourceId: 'cedar', period: `${m}-01`, amountMinor })),
      walk: { sources: [{ id: 'cedar', name: 'Cedar Partners loan' }], cashNeedMinor: '0' },
      sourceGroups: [],
    });
    const html = render.renderWidget(barsSpec, { id: 'v1.1', goalChecks: [] }, inputs('1000000000'), inputs('1020000000'));
    expect(html.split('<g class="k-pair"').length - 1).toBe(22);
    expect(html).toContain('<svg viewBox="0 0 1178 190" width="1767" height="285" role="img"');
  });

  it('draws the 8 cover months at 52 units each, 675 px wide', () => {
    // SCENARIO: the Cedar cover draft from the test above, 8 changed months
    // INPUT: bars-before-after spec, eval-active and cover-cedar.eval
    // EXPECTED: viewBox width 30 + 8 × 52 + 4 = 450, drawn 675 × 285 px
    const html = render.renderWidget(barsSpec, coverDraft, parentEval, draftEval);
    expect(html).toContain('<svg viewBox="0 0 450 190" width="675" height="285" role="img"');
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
  const cash = { widget: 'cash-line', version: 1, buildId: 'b1', spec: { widget: 'cash-line', title: 'Деньги' }, data: { rows: 44 }, provenance: 'kairon' };
  const kpi = { widget: 'kpi-tiles', version: 1, buildId: 'b1', spec: { widget: 'kpi-tiles', title: 'Показатели' }, data: { tiles: 5 }, provenance: 'kairon' };
  const need = { widget: 'need-rows', version: 1, buildId: 'b1', spec: { widget: 'need-rows', title: 'Потребность' }, data: { rows: 3 }, provenance: 'kairon' };
  const host = { id: 'host' };

  /**
   * A stand-in for the bundle of build b1: records what mount() was called with and counts unmounts.
   * Its catalog carries three widgets at version 1 and refuses data that holds `broken`.
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
          { id: 'cash-line', version: 1 },
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

  it('mounts every instance the bundle draws, each in its own host, in the server\'s order', () => {
    // SCENARIO: the server assembled three instances; the bundle's manifest carries all three widgets (DEV-1381)
    // INPUT: instances kpi-tiles, need-rows, cash-line; a host made per instance
    // EXPECTED: three mounts in that order, each with its own host; the hosts come back with their unmounts
    const bundle = fakeBundle();
    const mounted = render.mountInstances(bundle, [kpi, need, cash], (instance) => ({ hostOf: (instance as { widget: string }).widget }));
    mounted.forEach((m) => m.unmount());
    expect([bundle.calls.map((call) => [call[0], call[1]]), mounted.map((m) => m.host), bundle.unmounted()]).toEqual([
      [
        [{ hostOf: 'kpi-tiles' }, kpi],
        [{ hostOf: 'need-rows' }, need],
        [{ hostOf: 'cash-line' }, cash],
      ],
      [{ hostOf: 'kpi-tiles' }, { hostOf: 'need-rows' }, { hostOf: 'cash-line' }],
      3,
    ]);
  });

  it('skips an instance the bundle does not draw and mounts the rest', () => {
    // SCENARIO: one instance is of a version the bundle lacks, one of a widget its manifest does not carry
    // INPUT: kpi-tiles, cash-line at version 2, an instance of widget nope; the bundle b1
    // EXPECTED: kpi-tiles alone is mounted; no host is made for the other two; with no bundle nothing is mounted
    const bundle = fakeBundle();
    const hosts: string[] = [];
    const hostOf = (instance: unknown) => {
      hosts.push((instance as { widget: string }).widget);
      return { hostOf: (instance as { widget: string }).widget };
    };
    const list = [kpi, { ...cash, version: 2 }, { ...cash, widget: 'nope' }];
    expect([render.mountInstances(bundle, list, hostOf).map((m) => m.host), hosts, render.mountInstances(null, list, hostOf)]).toEqual([
      [{ hostOf: 'kpi-tiles' }],
      ['kpi-tiles'],
      [],
    ]);
  });

  it('mounts an instance with the bundle, in Russian, and hands back the unmount', () => {
    // SCENARIO: the bundle is loaded and the draft has a cash-line instance
    // INPUT: a host, the bundle, the instance
    // EXPECTED: one mount(host, instance, { locale: 'ru' }) call; the returned function unmounts once
    const bundle = fakeBundle();
    const unmount = render.mountInstance(host, bundle, cash);
    unmount?.();
    expect([bundle.calls, bundle.unmounted()]).toEqual([[[host, cash, { locale: 'ru' }]], 1]);
  });

  it('mounts nothing without the bundle or without an instance', () => {
    // SCENARIO: no KAIRON_WIDGETS_DIST (the bundle is null), or a draft the widget was not cut for
    // INPUT: (a) no bundle, an instance; (b) the bundle, no instance
    // EXPECTED: null for both, and no mount call: the page falls back to its own renderer
    const bundle = fakeBundle();
    expect([render.mountInstance(host, null, cash), render.mountInstance(host, bundle, undefined), bundle.calls]).toEqual([null, null, []]);
  });

  it('falls back when the bundle fails to mount', () => {
    // SCENARIO: a bundle that throws must not take the draft card down
    // INPUT: a bundle whose mount throws
    // EXPECTED: null
    const broken = {
      ...fakeBundle(),
      mount: () => {
        throw new Error('boom');
      },
    };
    expect(render.mountInstance(host, broken, cash)).toBeNull();
  });

  it('refuses an instance assembled by another build, or by none', () => {
    // SCENARIO: a session recorded on one widgets build replays on a page that loaded a rebuilt bundle (review I1)
    // INPUT: the bundle of build b1; the cash instance stamped b0; the cash instance with no stamp
    // EXPECTED: null for both and no mount call, so the page's own renderer draws
    const bundle = fakeBundle();
    const { buildId: _stamp, ...unstamped } = cash;
    expect([render.mountInstance(host, bundle, { ...cash, buildId: 'b0' }), render.mountInstance(host, bundle, unstamped), bundle.calls]).toEqual([null, null, []]);
  });

  it('refuses an instance whose version the bundle does not carry', () => {
    // SCENARIO: the instance states a widget version the loaded bundle does not draw (review I2, scenario E)
    // INPUT: the bundle with cash-line at version 1; the cash instance at version 2; an instance of a widget the bundle lacks
    // EXPECTED: null for both and no mount call: the figure stays on the page through its own renderer
    const bundle = fakeBundle();
    expect([
      render.mountInstance(host, bundle, { ...cash, version: 2 }),
      render.mountInstance(host, bundle, { ...cash, widget: 'nope' }),
      bundle.calls,
    ]).toEqual([null, null, []]);
  });

  it('refuses an instance whose data breaks the widget schema', () => {
    // SCENARIO: the instance data does not parse in the loaded bundle (review I2, scenario F)
    // INPUT: the cash instance with data the bundle's parseData throws on
    // EXPECTED: null and no mount call
    const bundle = fakeBundle();
    expect([render.mountInstance(host, bundle, { ...cash, data: { broken: true } }), bundle.calls]).toEqual([null, []]);
  });

  it('refuses every instance when the bundle has no catalog to check against', () => {
    // SCENARIO: a bundle that exports mount alone cannot state its build, versions or data schema
    // INPUT: a bundle with mount and no buildId or catalog
    // EXPECTED: null
    expect(render.mountInstance(host, { mount: () => () => {} }, cash)).toBeNull();
  });

  it('accepts the bundle of the build the service states and no other', () => {
    // SCENARIO: the page imported browser.mjs; the service's GET /kairon/widgets stated a build id (review I1)
    // INPUT: (a) the bundle b1 with info b1; (b) the bundle b1 with info b2; (c) a module with no mount; (d) no module
    // EXPECTED: (a) the bundle itself; (b), (c), (d) null, so WIDGETS stays null and the page's renderers draw
    const bundle = fakeBundle();
    expect([
      render.acceptBundle(bundle, { bundle: '/x', buildId: 'b1' }) === bundle,
      render.acceptBundle(bundle, { bundle: '/x', buildId: 'b2' }),
      render.acceptBundle({ buildId: 'b1' }, { bundle: '/x', buildId: 'b1' }),
      render.acceptBundle(null, { bundle: null, buildId: null }),
    ]).toEqual([true, null, null, null]);
  });
});
