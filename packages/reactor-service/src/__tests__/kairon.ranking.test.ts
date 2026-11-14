// Goal-aware ranking (DEV-1375, spec 5.6): red lines first, then the goal,
// then fewer levers. Variants identical to the parent or an earlier one are
// dropped; switches re-rank the same drafts under another goal.

import { describe, expect, it } from 'vitest';
import {
  criteriaMatrix,
  rankDrafts,
  sameAsEarlier,
  switchesFor,
  type DraftScore,
} from '../kairon/ranking.js';
import { redLines } from '../kairon/redLines.js';
import { rankVariants, summarizeEvaluation } from '../kairon/summary.js';
import { readFixture, readStage5, RIVERGATE_PARTNERS } from './_helpers/kaironFake.js';

const CZK = { decimals: 2, currencyCode: 'CZK' };
const approved = summarizeEvaluation(readStage5('eval-approved.json'));
const active = summarizeEvaluation(readStage5('eval-active.json'));
const metricsOf = (id: string) => summarizeEvaluation(readStage5(`s2-${id}.eval.json`));
const U2_OPEN = '1443662270';

function score(id: string, leverCount: number, touchesReserve: boolean): DraftScore {
  return {
    id,
    metrics: metricsOf(id),
    parentMetrics: active,
    leverCount,
    touchesReserve,
    reserveLeftMinor: touchesReserve ? '0' : U2_OPEN,
    addedBreaches: 0,
    goalsMet: true,
    profitTargetMinor: null,
  };
}

const s2 = [score('v1', 0, false), score('v2', 1, true), score('v3', 1, false), score('v4', 2, true)];

describe('kairon rankDrafts', () => {
  it('recommends v1 for construction +8 % under the promise and shows the switches', () => {
    // SCENARIO: spec 5.7, all four variants above the promise
    // INPUT: DraftScores built from s2-v1..v4 evals; leverCount 0, 1, 1, 2; touchesReserve false, true, false, true
    // EXPECTED: ranking v1, v2, v3, v4; switches: profit → v4, partner cash → v4, keep reserve → v3
    expect(rankDrafts(s2, approved, { type: 'promise', partnerIds: null })).toEqual({
      ranking: ['v1', 'v2', 'v3', 'v4'],
      notRecommendable: [],
    });
    expect(switchesFor(s2, approved)).toEqual([
      { label: 'Важна прибыль как в плане', winner: 'v4' },
      { label: 'Меньше денег партнёров', winner: 'v4' },
      { label: 'Прибыль без траты резерва', winner: 'v3' },
    ]);
  });

  it('ranks by distance to a profit target, drafts below it last', () => {
    // SCENARIO: «чистая прибыль не ниже 385 млн»
    // INPUT: target 38 500 000 000 minor; v1 333,4, v2 347,9, v3 384,5, v4 387,0
    // EXPECTED: v4 (the only one at or above), then v3, v2, v1 by distance
    expect(rankDrafts(s2, approved, { type: 'net_profit_target', targetMinor: '38500000000' }).ranking).toEqual([
      'v4',
      'v3',
      'v2',
      'v1',
    ]);
  });

  it('ranks each draft against its own profit target', () => {
    // SCENARIO: DEV-1377, «+N к прибыли» over children of two parents: each child's target is its own parent's profit plus N
    // INPUT: v1 (333,4 млн) with its own target 330,0; v3 (384,5 млн) with its own target 387,65; the goal's fallback target 385,0
    // EXPECTED: v1 first: it is at its target, v3 is below its own. Against the one fallback target v3 would lead
    const drafts = [
      { ...score('v1', 1, false), profitTargetMinor: '33000000000' },
      { ...score('v3', 1, false), profitTargetMinor: '38765000000' },
    ];
    expect(rankDrafts(drafts, approved, { type: 'net_profit_target', targetMinor: '38500000000' }).ranking).toEqual(['v1', 'v3']);
  });

  it('ranks a stage 4 batch exactly as rankVariants does', () => {
    // SCENARIO: regression; no levers, no breaches, promise goal
    // INPUT: delay-3, active and s2-v1 metrics as DraftScores with leverCount 0
    // EXPECTED: the same order as rankVariants
    const rows = [
      { id: 'v1', metrics: summarizeEvaluation(readFixture('responses/eval-delay-3.json')) },
      { id: 'v2', metrics: active },
      { id: 'v3', metrics: metricsOf('v1') },
    ];
    const drafts = rows.map((r) => ({ ...score('v1', 0, false), id: r.id, metrics: r.metrics }));
    expect(rankDrafts(drafts, approved, { type: 'promise', partnerIds: null }).ranking).toEqual(
      rankVariants(approved.partners, rows),
    );
  });

  it('never recommends a draft that adds a breach', () => {
    // SCENARIO: one variant creates a cash gap
    // INPUT: v1 with addedBreaches 1
    // EXPECTED: v1 last, notRecommendable [{id: 'v1', reason: 'добавляет нарушение красной линии'}]
    const drafts = [{ ...score('v1', 0, false), addedBreaches: 1 }, ...s2.slice(1)];
    expect(rankDrafts(drafts, approved, { type: 'promise', partnerIds: null })).toEqual({
      ranking: ['v2', 'v3', 'v4', 'v1'],
      notRecommendable: [{ id: 'v1', reason: 'добавляет нарушение красной линии' }],
    });
  });

  it('puts a draft that misses its goal after the ones that meet it', () => {
    // SCENARIO: a goal draft whose goal check is not ok
    // INPUT: v2 with goalsMet false
    // EXPECTED: v2 last with the reason «не выполняет цель»
    const drafts = s2.map((d) => (d.id === 'v2' ? { ...d, goalsMet: false } : d));
    expect(rankDrafts(drafts, approved, { type: 'promise', partnerIds: null })).toEqual({
      ranking: ['v1', 'v3', 'v4', 'v2'],
      notRecommendable: [{ id: 'v2', reason: 'не выполняет цель' }],
    });
  });
});

describe('kairon sameAsEarlier', () => {
  it('drops the bank variant that changes nothing', () => {
    // SCENARIO: «перерасход берёт банк», equity share 60 %
    // INPUT: v1 and bank60 metrics
    // EXPECTED: bank60 same as v1
    const bank60 = summarizeEvaluation(readStage5('s2-bank60.eval.json'));
    expect(sameAsEarlier([{ id: 'v1', metrics: metricsOf('v1') }, { id: 'v5', metrics: bank60 }], active)).toEqual([
      { id: 'v5', sameAs: 'v1' },
    ]);
  });

  it('drops a draft equal to its parent', () => {
    // SCENARIO: a lever that Kairon absorbs completely
    // INPUT: a draft with the active forecast's metrics
    // EXPECTED: same as 'parent'
    expect(sameAsEarlier([{ id: 'v1', metrics: active }], active)).toEqual([{ id: 'v1', sameAs: 'parent' }]);
  });
});

describe('kairon criteriaMatrix', () => {
  it('lays out the round 5 matrix for construction +8 % under the promise', () => {
    // SCENARIO: the overview's criteria table, spec 5.6
    // INPUT: the four S2 drafts, their red lines against the active forecast
    // EXPECTED: steps 1, 2, 2, 3 then the cost rows; best per row as marked
    const redLinesById = Object.fromEntries(
      ['v1', 'v2', 'v3', 'v4'].map((id) => [
        id,
        redLines({
          approved,
          partners: RIVERGATE_PARTNERS,
          irrPartnerIds: null,
          parentEval: readStage5('eval-active.json'),
          draftEval: readStage5(`s2-${id}.eval.json`),
          currency: CZK,
        }),
      ]),
    );
    const rows = criteriaMatrix(s2, approved, redLinesById, CZK, { type: 'promise', partnerIds: null });
    expect(rows.map((r) => [r.step, r.label, Object.values(r.values), r.best])).toEqual([
      [1, 'Красные линии (7)', Array(4).fill('✓ 3 · ✗ 2 в базе · ○ 2'), null],
      [2, 'Запас IRR над обещанием, Solstice Sponsor', ['+1,80 п.п.', '+2,54 п.п.', '+4,05 п.п.', '+4,27 п.п.'], 'v1'],
      [2, 'Запас IRR над обещанием, Cedar Partners', ['+3,42 п.п.', '+4,34 п.п.', '+6,17 п.п.', '+6,45 п.п.'], 'v1'],
      [3, 'Рычаги', ['нет', '1', '1', '2'], 'v1'],
      [null, 'Чистая прибыль к базе', ['-53,7 млн CZK', '-39,3 млн CZK', '-2,6 млн CZK', '-0,1 млн CZK'], 'v4'],
      [null, 'Партнёры вносят дополнительно', ['+44,6 млн CZK', '+34,4 млн CZK', '+39,7 млн CZK', '+30,7 млн CZK'], 'v4'],
      [null, 'Резерв после решения', ['14,4 млн CZK', '0,0 млн CZK', '14,4 млн CZK', '0,0 млн CZK'], 'v1'],
    ]);
  });

  it('shows each draft against its own profit target', () => {
    // SCENARIO: DEV-1377, the «Чистая прибыль к цели» row when drafts carry different targets
    // INPUT: v1 with target 330,0 млн, v3 with target 387,65 млн; fallback target 385,0 млн
    // EXPECTED: v1 +3,4 млн, v3 -3,1 млн; v1 is the best: the only one at or above its target
    const drafts = [
      { ...score('v1', 1, false), profitTargetMinor: '33000000000' },
      { ...score('v3', 1, false), profitTargetMinor: '38765000000' },
    ];
    const rows = criteriaMatrix(drafts, approved, {}, CZK, { type: 'net_profit_target', targetMinor: '38500000000' });
    const row = rows.find((r) => r.label === 'Чистая прибыль к цели');
    expect([row?.step, row?.values, row?.best]).toEqual([2, { v1: '+3,4 млн CZK', v3: '-3,1 млн CZK' }, 'v1']);
  });
});
