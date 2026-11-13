// The card renderer module of the page (DEV-1376, spec 5.4): pure functions in
// web/kairon-render.mjs turn the server result into HTML strings. Every status
// carries an icon and a word, every text is escaped, every figure comes from the
// server result the function receives.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { redLines } from '../kairon/redLines.js';
import { summarizeEvaluation } from '../kairon/summary.js';
import { readStage5, RIVERGATE_PARTNERS } from './_helpers/kaironFake.js';

interface RenderModule {
  renderVerdict(explanation: unknown, scoredVariant: unknown): string;
  renderStakeholders(scoredVariant: unknown, explanation: unknown): string;
  renderRedLines(lines: unknown): string;
  renderGoalChecks(goalChecks: unknown): string;
  renderReconciliations(reconciliations: unknown): string;
  renderOverview(explanation: unknown, scored: unknown): string;
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

  it('escapes a title that carries markup', () => {
    // SCENARIO: a draft title written by the LLM contains a script tag
    // INPUT: v1 titled <script>alert(1)</script>
    // EXPECTED: the title appears escaped; no raw <script> in the output
    const html = render.renderOverview(explanation, scored);
    expect(html).toContain('Рекомендую v1: &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.includes('<script>')).toBe(false);
  });
});
