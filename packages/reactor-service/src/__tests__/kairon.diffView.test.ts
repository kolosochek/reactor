// Data for the copy of Kairon's forecast diff view (DEV-1375, spec 5.4.6):
// the meaning of the «Set active» review (activation-review-model.ts) on a
// draft against its parent, the approved budget and the funding walk.
// Expected values were computed independently from the fixtures in Python.

import { describe, expect, it } from 'vitest';
import { diffVariant } from '../kairon/diff.js';
import { forecastDiffView } from '../kairon/diffView.js';
import { applyPatch, type ForecastPlan } from '../kairon/patch.js';
import { fixtureDoc, readStage5 } from './_helpers/kaironFake.js';

const CZK = { decimals: 2, currencyCode: 'CZK' };
const parentPlan = applyPatch(fixtureDoc, { name: 'active' }).plan;
const draftPlan = (readStage5('s2-v1.body.json') as { plan: ForecastPlan }).plan;
const approvedPlan = readStage5('approved-plan.json') as ForecastPlan;
const parentEval = readStage5('eval-active.json');
const draftEval = readStage5('s2-v1.eval.json');
const diff = diffVariant({
  currency: CZK,
  closedThrough: '2026-08',
  derivedLineCodes: [],
  activePlan: parentPlan,
  variantPlan: draftPlan,
  activeEval: parentEval,
  variantEval: draftEval,
});

describe('kairon forecastDiffView', () => {
  const view = forecastDiffView({ parentPlan, draftPlan, approvedPlan, parentEval, draftEval, diff, revenueGroups: ['R', 'C'] });

  it('fills the four tiles for construction +8 %', () => {
    // SCENARIO: s2-v1 against the active forecast and the approved budget
    // INPUT: plans as stored (costs negative), the two evaluations
    // EXPECTED: costs −53,7 млн (the construction bridge), revenue 0, 173,1 млн over the approved cost budget on 34 lines, nothing uncovered
    expect(view.tiles).toEqual({
      costsDeltaMinor: '-5373605009',
      revenueDeltaMinor: '0',
      overApprovedMinor: '17314133540',
      overApprovedLines: 34,
      uncoveredMinor: '0',
      uncoveredParentMinor: '0',
    });
  });

  it('lists the changed lines and who contributes, bank first', () => {
    // SCENARIO: the «what changes» and «who contributes» sections
    // INPUT: same
    // EXPECTED: D5 then D8 by size of change; bank unchanged, both partners put in more
    expect(view.changedLines).toEqual([
      { code: 'D5', name: 'Construction - new build', parentMinor: '-74856250793', draftMinor: '-80137711002' },
      { code: 'D8', name: 'Owner supervision, H&S, design supervision, project monitor, cost monitor, legal services', parentMinor: '-1930585478', draftMinor: '-2022730278' },
    ]);
    expect(view.contributors).toEqual([
      { name: 'Bank Financing', group: 'bank', parentMinor: '9742775579', draftMinor: '9742775579' },
      { name: 'Solstice Sponsor', group: 'partner', parentMinor: '30798138449', draftMinor: '32135556755' },
      { name: 'Cedar Partners', group: 'partner', parentMinor: '50219038191', draftMinor: '53339680906' },
    ]);
  });

  it('reads every differing group against the approved budget in words', () => {
    // SCENARIO: the «against the approved budget» section
    // INPUT: draft plan and the recorded approved plan
    // EXPECTED: groups in plan order; costs more negative than approved are «перерасход», revenue above is «выше плана»
    expect(view.againstApproved.map((g) => [g.groupCode, g.words])).toEqual([
      ['R', 'выше плана'],
      ['C', 'ниже плана'],
      ['R10', 'экономия'],
      ['A', 'экономия'],
      ['D', 'перерасход'],
      ['U', 'перерасход'],
      ['O', 'перерасход'],
      ['F', 'перерасход'],
    ]);
    expect(view.againstApproved.find((g) => g.groupCode === 'D')).toEqual({
      groupCode: 'D',
      draftMinor: '-84959151195',
      approvedMinor: '-72183111630',
      words: 'перерасход',
    });
  });

  it('reports coverage and passes the moved events through', () => {
    // SCENARIO: the coverage block and the events row
    // INPUT: s2-v1 serves no rule notices and no funding signals
    // EXPECTED: covered, no notices; events as diffVariant computed them
    expect(view.coverage).toEqual({ covered: true, notices: [] });
    expect(view.events).toEqual(diff.events);
  });
});
