// Evaluate-response summaries, variant ranking and the placeholder renderer
// that puts server figures into the LLM's explanation (DEV-1364).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildFacts,
  literalNumbers,
  rankVariants,
  renderPlaceholders,
  summarizeEvaluation,
  type EvaluationMetrics,
} from '../kairon/summary.js';
import { readStage5 } from './_helpers/kaironFake.js';

const RESPONSES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kairon', 'responses');

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(RESPONSES, name), 'utf8'));
}

const promised = summarizeEvaluation(readJson('eval-approved.json'));
const delay3 = summarizeEvaluation(readJson('eval-delay-3.json'));

function withIrr(base: EvaluationMetrics, solstice: number, cedar: number): EvaluationMetrics {
  return {
    ...base,
    partners: [
      { partnerId: 'solstice', name: 'Solstice Sponsor', irr: solstice },
      { partnerId: 'cedar', name: 'Cedar Partners', irr: cedar },
    ],
  };
}

describe('kairon summarizeEvaluation', () => {
  it('reads exit, partner IRR, profit and covenants from a recorded response', () => {
    // SCENARIO: the delay-3 variant the server scored in the discovery run
    // INPUT: responses/eval-delay-3.json
    // EXPECTED: the exact figures the response carries
    expect(delay3).toEqual({
      versionId: 'solstice-forecast-3',
      exitMonth: '2028-10',
      partners: [
        { partnerId: 'solstice', name: 'Solstice Sponsor', irr: 0.20713516356223352 },
        { partnerId: 'cedar', name: 'Cedar Partners', irr: 0.23464547979699193 },
      ],
      netProfitMinor: '36516125325',
      ltvBp: 5425,
      ltcBp: 7320,
      uncoveredNeedMinor: '0',
      minCashBalanceMinor: '0',
      partnerAllocatedMinor: { solstice: '31755958181', cedar: '52453950899' },
    });
  });

  it('reads each partner\'s allocated money from partnerFrames', () => {
    // SCENARIO: stage 5 compares partner cash between drafts (DEV-1375)
    // INPUT: stage5/eval-active.json
    // EXPECTED: allocatedMinor per partner id as served
    expect(summarizeEvaluation(readStage5('eval-active.json')).partnerAllocatedMinor).toEqual({
      solstice: '30798138449',
      cedar: '50219038191',
    });
  });
});

describe('kairon rankVariants', () => {
  it('puts the variant with the smallest IRR shortfall first and refused variants last', () => {
    // SCENARIO: three variants against the approved promise (18.91 % / 20.15 %)
    // INPUT: a: 18.00 / 21.00 (short 0.91 pp), b: 19.00 / 20.20 (no shortfall), c: refused
    // EXPECTED: ["b", "a", "c"]
    const ranked = rankVariants(promised.partners, [
      { id: 'a', metrics: withIrr(delay3, 0.18, 0.21) },
      { id: 'b', metrics: withIrr(delay3, 0.19, 0.202) },
      { id: 'c', metrics: null },
    ]);
    expect(ranked).toEqual(['b', 'a', 'c']);
  });

  it('breaks a tie on shortfall by the total distance to the promise', () => {
    // SCENARIO: two variants that both meet the promise
    // INPUT: a: 21.00 / 23.00, b: 19.00 / 20.20
    // EXPECTED: ["b", "a"] because b sits closer to 18.91 / 20.15
    const ranked = rankVariants(promised.partners, [
      { id: 'a', metrics: withIrr(delay3, 0.21, 0.23) },
      { id: 'b', metrics: withIrr(delay3, 0.19, 0.202) },
    ]);
    expect(ranked).toEqual(['b', 'a']);
  });
});

describe('kairon facts and placeholders', () => {
  const facts = buildFacts({ decimals: 2, currencyCode: 'CZK' }, promised, [
    { key: 'approved', metrics: promised },
    { key: 'v1', metrics: delay3 },
  ]);

  it('formats IRR, the gap to the promise, profit, LTV and exit per row', () => {
    // SCENARIO: facts the explanation may cite
    // INPUT: approved and delay-3 metrics, CZK with 2 decimals
    // EXPECTED: Russian number formatting, gap in percentage points
    expect(facts['v1.irr.solstice']).toBe('20,71 %');
    expect(facts['v1.gap.solstice']).toBe('+1,80 п.п.');
    expect(facts['v1.netProfit']).toBe('365,2 млн CZK');
    expect(facts['v1.ltv']).toBe('54,25 %');
    expect(facts['v1.exitMonth']).toBe('2028-10');
    expect(facts['approved.irr.cedar']).toBe('20,15 %');
  });

  it('substitutes known placeholders and reports unknown ones', () => {
    // SCENARIO: the LLM cites one real fact and one invented key
    // INPUT: "IRR {{v1.irr.solstice}}, прибыль {{v9.netProfit}}"
    // EXPECTED: the known key replaced, the unknown kept visibly marked and listed
    const rendered = renderPlaceholders('IRR {{v1.irr.solstice}}, прибыль {{v9.netProfit}}', facts);
    expect(rendered).toEqual({ text: 'IRR 20,71 %, прибыль [?v9.netProfit]', unknown: ['v9.netProfit'] });
  });

  it('lists digits the LLM wrote outside placeholders', () => {
    // SCENARIO: the explanation states a number itself; variant names like v2 are not numbers
    // INPUT: "Сдвиг на 6 мес. даёт {{v1.irr.solstice}} против 19,5 в v2"
    // EXPECTED: ["6", "19,5"]
    expect(literalNumbers('Сдвиг на 6 мес. даёт {{v1.irr.solstice}} против 19,5 в v2', [])).toEqual(['6', '19,5']);
  });

  it('does not report numbers repeated from the scenario or the facts', () => {
    // SCENARIO: the LLM restates the scenario's delay and dates and an exit month from the facts
    // INPUT: template "на 3 месяца, с 2027-12 на 2028-03, выход 2028-10, запас 7"; sources: the scenario, "2028-10"
    // EXPECTED: ["7"], the only number from neither source
    const scenario = 'Kolaudace сдвигается на 3 месяца: с 2027-12 на 2028-03.';
    expect(literalNumbers('на 3 месяца, с 2027-12 на 2028-03, выход 2028-10, запас 7', [scenario, '2028-10'])).toEqual([
      '7',
    ]);
  });
});
