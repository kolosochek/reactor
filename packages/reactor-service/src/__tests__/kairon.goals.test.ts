// Goals (DEV-1375): the cover goal's draws built by the server, the goal checks
// per part of the forecast (b1), and the goal the ranking uses.

import { describe, expect, it } from 'vitest';
import { checkGoals, fundingCoverDraws, rankGoalOf, type Goal } from '../kairon/goals.js';
import { summarizeEvaluation } from '../kairon/summary.js';
import { readStage5 } from './_helpers/kaironFake.js';

const CZK = { decimals: 2, currencyCode: 'CZK' };
const active = readStage5('eval-active.json');
const approved = summarizeEvaluation(readStage5('eval-approved.json'));
const rules = { closedThrough: '2026-08', planEnd: '2028-07' };

function cover(fromMonth: string, months: number): Extract<Goal, { type: 'funding_cover' }> {
  return { type: 'funding_cover', partnerId: 'cedar', fromMonth, months };
}

function npt(amountMinor: string, basis: 'delta' | 'absolute'): Goal {
  return { type: 'net_profit_target', amountMinor, basis };
}

describe('kairon fundingCoverDraws', () => {
  it('pins Cedar to the need for six months from 2026-09', () => {
    // SCENARIO: «Хочу, чтобы ближайшие 6 месяцев все затраты покрывал Cedar» on the active forecast
    // INPUT: funding_cover cedar 2026-09 × 6, eval-active
    // EXPECTED: the draws equal cover-cedar.body.json's draws
    const out = fundingCoverDraws(cover('2026-09', 6), active, rules);
    expect(out).toEqual({ draws: (readStage5('cover-cedar.body.json') as { draws: unknown }).draws, errors: [] });
  });

  it('refuses a window in a closed month or past the plan end', () => {
    // SCENARIO: Review Focus 4
    // INPUT: fromMonth 2026-08; fromMonth 2028-05 × 6
    // EXPECTED: no draws; the month is named
    expect(fundingCoverDraws(cover('2026-08', 6), active, rules)).toEqual({
      draws: [],
      errors: ['2026-08: closed through 2026-08'],
    });
    expect(fundingCoverDraws(cover('2028-05', 6), active, rules)).toEqual({
      draws: [],
      errors: ['2028-10: after the plan end 2028-07'],
    });
  });

  it('refuses a partner with no funding source', () => {
    // SCENARIO: the structuring step names a partner the project does not have
    // INPUT: partnerId 'acme'
    // EXPECTED: no draws; the partner is named
    expect(fundingCoverDraws({ ...cover('2026-09', 6), partnerId: 'acme' }, active, rules)).toEqual({
      draws: [],
      errors: ['acme: no funding source for this partner'],
    });
  });
});

describe('kairon checkGoals', () => {
  it('marks the cover goal per month for the parent and the draft', () => {
    // SCENARIO: goal check row b1
    // INPUT: the cover goal, parent eval-active, draft cover-cedar.eval
    // EXPECTED: parent breach, ok only in 2026-09 (need 0, both partners draw 0); draft ok in 6 of 6
    const [row] = checkGoals([cover('2026-09', 6)], {
      approved,
      parentEval: active,
      draftEval: readStage5('cover-cedar.eval.json'),
      parentNetProfitMinor: '38716351362',
      currency: CZK,
    });
    expect([row?.part, row?.label, row?.parent, row?.draft]).toEqual([
      'funding.draws',
      'Cedar Partners покрывает всю потребность 6 мес. с 2026-09',
      'breach',
      'ok',
    ]);
    expect(row?.months.filter((m) => m.parent).map((m) => m.month)).toEqual(['2026-09']);
    expect(row?.months.filter((m) => m.draft).length).toBe(6);
  });

  it('fails a cover month in which the bank draws', () => {
    // SCENARIO: DEV-1377, «все затраты покрывает Cedar»: a bank draw in the window means Cedar does not cover everything
    // INPUT: the cover goal; draft = cover-cedar.eval plus a bank draw of 1 000,00 CZK in 2026-11
    // EXPECTED: draft breach; ok in 5 of 6 months, 2026-11 is the one that fails
    const draft = structuredClone(readStage5('cover-cedar.eval.json')) as { draws: Array<Record<string, string>> };
    draft.draws.push({ sourceId: 'da6b7d98-53b3-41e9-b554-06ba4064df94', period: '2026-11-01', amountMinor: '100000', provenance: 'pinned' });
    const [row] = checkGoals([cover('2026-09', 6)], {
      approved,
      parentEval: active,
      draftEval: draft,
      parentNetProfitMinor: '38716351362',
      currency: CZK,
    });
    expect(row?.draft).toBe('breach');
    expect(row?.months.filter((m) => !m.draft).map((m) => m.month)).toEqual(['2026-11']);
  });

  it('checks the IRR floor and the net profit target against the parent and the draft', () => {
    // SCENARIO: construction +8 % (s2-v1) against the active forecast
    // INPUT: irr_floor ['solstice']; net_profit_target absolute 380 млн
    // EXPECTED: IRR ok in both (20,71 % and 23,55 % over the promised 18,91 %); profit ok in the parent (387,2), breach in the draft (333,4)
    const rows = checkGoals([{ type: 'irr_floor', partnerIds: ['solstice'] }, npt('38000000000', 'absolute')], {
      approved,
      parentEval: active,
      draftEval: readStage5('s2-v1.eval.json'),
      parentNetProfitMinor: '38716351362',
      currency: CZK,
    });
    expect(rows.map((r) => [r.part, r.label, r.parent, r.draft, r.months.length])).toEqual([
      ['exit.partners', 'IRR не ниже обещания: Solstice Sponsor', 'ok', 'ok', 0],
      ['netProfit', 'Чистая прибыль не ниже 380,0 млн CZK', 'ok', 'breach', 0],
    ]);
  });
});

describe('kairon rankGoalOf', () => {
  it('turns goals into the ranking goal', () => {
    // SCENARIO: net_profit_target +10 млн against a parent at 333,4 млн
    // INPUT: [{net_profit_target, '1000000000', 'delta'}], parent net '33340000000'
    // EXPECTED: target = parent + 10 млн in minor units; irr_floor gives the promise for the listed partners; nothing gives the plain promise
    expect(rankGoalOf([npt('1000000000', 'delta')], '33340000000')).toEqual({
      type: 'net_profit_target',
      targetMinor: '34340000000',
    });
    expect(rankGoalOf([{ type: 'irr_floor', partnerIds: ['solstice'] }], '0')).toEqual({
      type: 'promise',
      partnerIds: ['solstice'],
    });
    expect(rankGoalOf([], '0')).toEqual({ type: 'promise', partnerIds: null });
  });

  it('lets a later IRR floor win over an earlier profit target', () => {
    // SCENARIO: demo step 6 after step 5: «+10 млн» on v1, then «IRR только для Solstice» on all (DEV-1376)
    // INPUT: [net_profit_target delta 10 млн, irr_floor solstice]
    // EXPECTED: the promise for Solstice only; the newest goal of the conversation decides the ranking
    expect(rankGoalOf([npt('1000000000', 'delta'), { type: 'irr_floor', partnerIds: ['solstice'] }], '33340000000')).toEqual({
      type: 'promise',
      partnerIds: ['solstice'],
    });
  });

  it('lets the last profit target win over an IRR floor', () => {
    // SCENARIO: the user set an IRR floor, then an absolute profit target
    // INPUT: [irr_floor solstice, net_profit_target absolute 390 млн]
    // EXPECTED: the profit target as stated
    expect(
      rankGoalOf([{ type: 'irr_floor', partnerIds: ['solstice'] }, npt('39000000000', 'absolute')], '33340000000'),
    ).toEqual({ type: 'net_profit_target', targetMinor: '39000000000' });
  });
});
