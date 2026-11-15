// What a variant changes against the active forecast (DEV-1364 stage 4): the
// profit bridge, the moved events, cash and funding series, and the notes on
// what the evaluation cannot see. Expected values were computed independently
// from the fixtures in Python.

import { describe, expect, it } from 'vitest';
import { diffVariant, type VariantDiffInput } from '../kairon/diff.js';
import { applyPatch, type ForecastPlan } from '../kairon/patch.js';
import { fixtureDoc, readFixture } from './_helpers/kaironFake.js';

const delay3Plan = (readFixture('bodies/body-delay-3.json') as { plan: ForecastPlan }).plan;
const activeEval = readFixture('responses/eval-active.json');
const delay3Eval = readFixture('responses/eval-delay-3.json');

const base: VariantDiffInput = {
  currency: { decimals: 2, currencyCode: 'CZK' },
  closedThrough: '2026-08',
  derivedLineCodes: [],
  activePlan: fixtureDoc.plan,
  variantPlan: delay3Plan,
  activeEval,
  variantEval: delay3Eval,
};

describe('kairon diffVariant, delay-3 against Forecast v3', () => {
  const diff = diffVariant(base);

  it('splits the net profit change by line group and closes on the change Kairon reports', () => {
    // SCENARIO: the delay alone; overheads and financing run 3 months longer
    // INPUT: active plan + eval-active, body-delay-3 + eval-delay-3
    // EXPECTED: overheads -267 385 860, financing -1 932 840 177, every other group 0; sum = -2 200 226 037
    expect(diff.bridge.map((b) => [b.key, b.minor])).toEqual([
      ['revenue', '0'],
      ['land', '0'],
      ['construction', '0'],
      ['reserve', '0'],
      ['overheads', '-267385860'],
      ['financing', '-1932840177'],
      ['tax', '0'],
      ['other', '0'],
    ]);
    expect(diff.profit).toEqual({
      activeNetMinor: '38716351362',
      variantNetMinor: '36516125325',
      activeExitMinor: '33330874224',
      variantExitMinor: '29963311100',
    });
  });

  it('reads the moved events from the plans', () => {
    // SCENARIO: the events the changed paths and the explanation read
    // INPUT: the same delay-3 pair
    // EXPECTED: construction end, main handover and exit each 3 months later
    expect(diff.events.map((e) => [e.key, e.active, e.variant])).toEqual([
      ['constructionEnd', '2028-07', '2028-10'],
      ['mainHandover', '2028-06', '2028-09'],
      ['exit', '2028-07', '2028-10'],
    ]);
  });

  it('states the cash trough, the month back in plus and the interest', () => {
    // SCENARIO: active ends 2028-07, the variant 2028-10
    // INPUT: the same delay-3 pair
    // EXPECTED: trough -850 965 376,98 in 2028-03 vs -882 892 701,38 in 2028-06; back to plus 2028-06 vs 2028-09
    expect(diff.cash).toEqual({
      activeTrough: { month: '2028-03', minor: '-85096537698' },
      variantTrough: { month: '2028-06', minor: '-88289270138' },
      activePositive: '2028-06',
      variantPositive: '2028-09',
    });
    expect(diff.interest).toEqual({ activeMinor: '11789401998', variantMinor: '12956739085' });
  });

  it('carries no series for charts the page no longer draws (DEV-1381)', () => {
    // SCENARIO: the month axis, the group spans, the cash series and the funding series fed the page's own
    //           timeline and charts; the catalog widgets draw those figures from widget data
    // INPUT: the same delay-3 pair
    // EXPECTED: the diff has the keys profit, bridge, events, cash, interest, notes and no other
    expect(Object.keys(diff).sort()).toEqual(['bridge', 'cash', 'events', 'interest', 'notes', 'profit']);
  });

  it('notes typed interest, rule-proposed draws and a bank that never starts', () => {
    // SCENARIO: Rivergate types F2/F3 by hand, Kairon proposes every draw, and the bank has no start (DEV-1377)
    // INPUT: no derived lines; eval-delay-3 reconciliation interest_basis -12 956 739 085; its bank draws 0 after 2026-08
    // EXPECTED: the interest note with 154,3 and 129,6 млн CZK, the draws note, the bank note; no tax note (revenue unchanged)
    expect(diff.notes).toEqual([
      'Проценты F2, F3 вписаны в план: 154,3 млн CZK; чистая прибыль вычитает их. Прибыль на выходе для партнёров вычитает ещё проценты модели источников: 129,6 млн CZK.',
      'Транши партнёров предлагает правило финансирования Kairon; вариант их не задаёт.',
      'Банк «Bank Financing» в открытых месяцах не выбирается: в Kairon у него нет даты «Доступен с» и нет закреплённого транша, а без старта правило финансирования отдаёт всю потребность партнёрам. Лимит 1\u00a0003,0 млн CZK, выбрано 97,4 млн CZK, свободно 905,6 млн CZK.',
    ]);
  });
});

describe('kairon diffVariant, a price lever', () => {
  it('notes that a typed tax line does not follow a revenue change', () => {
    // SCENARIO: +1 % on R1 from 2028-03 with F7 typed
    // INPUT: active plan scaled on R1 (2028-04 and 2028-06 cells), evaluated as eval-active
    // EXPECTED: revenue +1 541 659 614 minor; the residual moves to "other"; the first note is the tax note with +15,4 млн CZK
    const priced = applyPatch(fixtureDoc, {
      name: 'p',
      scale: [{ lineCodes: ['R1'], fromMonth: '2028-03', factorPpm: 1_010_000 }],
    }).plan;
    const diff = diffVariant({ ...base, variantPlan: priced, variantEval: activeEval });
    expect(diff.bridge.find((b) => b.key === 'revenue')?.minor).toBe('1541659614');
    expect(diff.bridge.find((b) => b.key === 'other')?.minor).toBe('-1541659614');
    expect(diff.notes[0]).toBe(
      'Налог на прибыль (F7) вписан в план и не пересчитан: выручка +15,4 млн CZK, налог без изменений. Чистая прибыль варианта завышена на налог с этой разницы.',
    );
  });
});
