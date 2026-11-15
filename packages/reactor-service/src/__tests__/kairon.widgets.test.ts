// Widgets chosen by changed paths (DEV-1375, spec 5.5): the server lists the
// JSON paths a draft changes against its parent; stage 4 blocks cover most of
// them, and funding.draws always gets the matrix-diff (w1).

import { describe, expect, it } from 'vitest';
import { diffVariant } from '../kairon/diff.js';
import { applyPatch, type EvaluateBody } from '../kairon/patch.js';
import {
  catalogPaths,
  changedPaths,
  defaultCatalogSpec,
  defaultWidgets,
  EXISTING_WIDGETS,
  widgetInputs,
  WidgetSpecSchema,
  withMandatory,
  type WidgetSpec,
} from '../kairon/widgets.js';
import { fixtureDoc, readStage5 } from './_helpers/kaironFake.js';

const CZK = { decimals: 2, currencyCode: 'CZK' };
const parentBody = applyPatch(fixtureDoc, { name: 'active' });
const parentEval = readStage5('eval-active.json');

type RawEval = { netProfit: string | null; exit: { month: string }; walk: { uncoveredNeedMinor: Record<string, string> } };

/** The changed paths of a stage 5 draft; `extra` asks for catalog paths and `edit` alters a copy of the draft's evaluation. */
function changedFor(file: string, extra: string[] = [], edit: (evaluation: RawEval) => void = () => {}) {
  const draftBody = readStage5(`${file}.body.json`) as EvaluateBody;
  const draftEval = structuredClone(readStage5(`${file}.eval.json`)) as RawEval;
  edit(draftEval);
  const diff = diffVariant({
    currency: CZK,
    closedThrough: '2026-08',
    derivedLineCodes: [],
    activePlan: parentBody.plan,
    variantPlan: draftBody.plan,
    activeEval: parentEval,
    variantEval: draftEval,
  });
  return changedPaths({ parentBody, draftBody, parentEval, draftEval, diff }, extra);
}

const bars: WidgetSpec = {
  widget: 'bars-before-after',
  title: 'Транши: было и стало',
  x: 'period',
  stack: 'sourceId',
  y: 'amountMinor',
  compare: ['parent', 'draft'],
  label: 'Δ за месяц',
};

describe('kairon changedPaths', () => {
  it('lists the cover draft as draws and partner IRR only', () => {
    // SCENARIO: Cedar covers the need for six months
    // INPUT: cover-cedar body and eval against the active forecast
    // EXPECTED: funding.draws (14 source-month cells) and exit.partners (2 partners); the plan and the cumulative cash are unchanged
    expect(changedFor('cover-cedar')).toEqual([
      { path: 'funding.draws', cells: 14 },
      { path: 'exit.partners', cells: 2 },
    ]);
  });

  it('lists construction +8 % as plan lines, draws, cash and IRR', () => {
    // SCENARIO: the partners' draws follow the overrun
    // INPUT: s2-v1 body and eval against the active forecast
    // EXPECTED: 46 plan cells, 36 draw cells, 23 cash months, 2 partners; no event moves
    expect(changedFor('s2-v1')).toEqual([
      { path: 'plan.lines', cells: 46 },
      { path: 'funding.draws', cells: 36 },
      { path: 'walk.cumulativeNetCashMinor', cells: 23 },
      { path: 'exit.partners', cells: 2 },
    ]);
  });
});

describe('kairon widget specs', () => {
  it('puts the matrix-diff first when the LLM leaves it out', () => {
    // SCENARIO: the LLM proposed only bars for a cover draft
    // INPUT: [bars-before-after], the cover draft's changed paths
    // EXPECTED: matrix-diff then bars
    const out = withMandatory([bars], changedFor('cover-cedar'));
    expect(out.map((s) => s.widget)).toEqual(['matrix-diff', 'bars-before-after']);
  });

  it('drops a draws widget when the draws did not change', () => {
    // SCENARIO: a plan-only change with no draw moved
    // INPUT: [bars, condition-check], changed = plan.lines only
    // EXPECTED: the condition check stays; the bars go
    const check: WidgetSpec = { widget: 'condition-check', title: 'Цель', goals: 'active' };
    expect(withMandatory([bars, check], [{ path: 'plan.lines', cells: 46 }])).toEqual([check]);
  });

  it('defaults to matrix-diff and bars for changed draws, nothing else', () => {
    // SCENARIO: the widgets step fell back to defaults
    // INPUT: the s2-v1 changed paths
    // EXPECTED: matrix-diff then bars-before-after; the other paths have stage 4 blocks
    expect(defaultWidgets(changedFor('s2-v1')).map((s) => s.widget)).toEqual(['matrix-diff', 'bars-before-after']);
    expect(defaultWidgets([{ path: 'plan.lines', cells: 46 }])).toEqual([]);
    expect(EXISTING_WIDGETS).toEqual({
      'plan.lines': 'bridge',
      'walk.cumulativeNetCashMinor': 'cash',
      'exit.partners': 'irr',
      events: 'timeline',
    });
  });

  it('accepts the spec example and refuses an unknown key', () => {
    // SCENARIO: the LLM's declarative spec is checked by the schema
    // INPUT: the spec 5.5 example with a title; the same with an extra key
    // EXPECTED: parse ok; strict schema refuses the extra key
    const example = {
      widget: 'matrix-diff',
      title: 'Транши по инвесторам',
      rows: 'draws[].sourceId',
      cols: 'draws[].period',
      value: 'amountMinor',
      highlight: 'changed',
      delta: 'cell, row',
    };
    expect(WidgetSpecSchema.parse(example)).toEqual(example);
    expect(WidgetSpecSchema.safeParse({ ...example, html: '<b>' }).success).toBe(false);
  });
});

describe('kairon widgetInputs', () => {
  it('keeps only what the draws widgets read from an evaluation', () => {
    // SCENARIO: the page draws w1 and w2 from the scored variant, not from the full evaluation
    // INPUT: cover-cedar.eval
    // EXPECTED: draws without provenance, walk with sources {id, name} and cashNeedMinor only, sourceGroups {sourceId, partnerId}
    const out = widgetInputs(readStage5('cover-cedar.eval.json'));
    expect(Object.keys(out)).toEqual(['draws', 'walk', 'sourceGroups']);
    expect(Object.keys(out.walk)).toEqual(['sources', 'cashNeedMinor']);
    expect(out.draws[0]).toEqual({ sourceId: '7c1962e8-a12d-42ca-82cc-4bea10338044', period: '2026-09-01', amountMinor: '0' });
    expect(out.walk.sources.map((s) => s.name)).toEqual(['Bank Financing', 'Solstice Sponsor loan', 'Cedar Partners loan']);
    expect(out.sourceGroups.map((g) => g.partnerId ?? null)).toEqual([null, 'solstice', 'cedar']);
  });
});

describe('kairon changedPaths with a widgets catalog (DEV-1380)', () => {
  const COVER = [
    { path: 'funding.draws', cells: 14 },
    { path: 'exit.partners', cells: 2 },
  ];

  it('keeps the list as it was when no catalog path is asked for', () => {
    // SCENARIO: the service runs with no widgets build; s2-v1 moves the net profit
    // INPUT: s2-v1 against the active forecast, no extra paths
    // EXPECTED: the four paths of before DEV-1380, no netProfit entry
    expect(changedFor('s2-v1').map((c) => c.path)).toEqual(['plan.lines', 'funding.draws', 'walk.cumulativeNetCashMinor', 'exit.partners']);
  });

  it('counts netProfit as one cell when the profit moved', () => {
    // SCENARIO: a widget reads netProfit; construction +8 % lowers the profit
    // INPUT: s2-v1 against the active forecast, extra path netProfit
    // EXPECTED: the four paths, then netProfit with 1 cell
    expect(changedFor('s2-v1', ['netProfit'])).toEqual([
      { path: 'plan.lines', cells: 46 },
      { path: 'funding.draws', cells: 36 },
      { path: 'walk.cumulativeNetCashMinor', cells: 23 },
      { path: 'exit.partners', cells: 2 },
      { path: 'netProfit', cells: 1 },
    ]);
  });

  it('leaves netProfit out when the profit is the same', () => {
    // SCENARIO: the cover draft moves draws between partners and keeps the profit
    // INPUT: cover-cedar against the active forecast, all three catalog paths asked for
    // EXPECTED: the two paths of the cover draft alone
    expect(changedFor('cover-cedar', ['netProfit', 'exit.month', 'walk.uncoveredNeedMinor'])).toEqual(COVER);
  });

  it('counts exit.month as one cell when the exit moved', () => {
    // SCENARIO: a widget reads exit.month; the draft exits three months later
    // INPUT: cover-cedar with exit.month set to 2028-10 (the parent exits 2028-07), extra path exit.month
    // EXPECTED: the cover paths, the exit as 1 moved event (the diff reads it as one), then exit.month with 1 cell
    const changed = changedFor('cover-cedar', ['exit.month'], (evaluation) => {
      evaluation.exit.month = '2028-10';
    });
    expect(changed).toEqual([...COVER, { path: 'events', cells: 1 }, { path: 'exit.month', cells: 1 }]);
  });

  it('counts walk.uncoveredNeedMinor by the months that differ', () => {
    // SCENARIO: a widget reads the uncovered need; the draft leaves two months uncovered
    // INPUT: cover-cedar with the uncovered need of 2026-10 and 2026-11 set to 500, extra path walk.uncoveredNeedMinor
    // EXPECTED: the cover paths, then walk.uncoveredNeedMinor with 2 cells
    const changed = changedFor('cover-cedar', ['walk.uncoveredNeedMinor'], (evaluation) => {
      evaluation.walk.uncoveredNeedMinor['2026-10'] = '500';
      evaluation.walk.uncoveredNeedMinor['2026-11'] = '500';
    });
    expect(changed).toEqual([...COVER, { path: 'walk.uncoveredNeedMinor', cells: 2 }]);
  });

  it('ignores an extra path it has no counter for', () => {
    // SCENARIO: a newer widget reads a path this service does not count yet
    // INPUT: cover-cedar, extra path sourceGroups
    // EXPECTED: the cover paths alone
    expect(changedFor('cover-cedar', ['sourceGroups'])).toEqual(COVER);
  });
});

describe('kairon catalogPaths (DEV-1380)', () => {
  it('lists the catalog paths the manifest reads, once each, in the service order', () => {
    // SCENARIO: two widgets read overlapping paths, some counted always and one unknown
    // INPUT: reads [walk.uncoveredNeedMinor, exit.partners, netProfit] and [netProfit, sourceGroups]
    // EXPECTED: netProfit then walk.uncoveredNeedMinor; exit.partners is counted always and sourceGroups has no counter
    const manifest = [{ reads: ['walk.uncoveredNeedMinor', 'exit.partners', 'netProfit'] }, { reads: ['netProfit', 'sourceGroups'] }];
    expect(catalogPaths(manifest)).toEqual(['netProfit', 'walk.uncoveredNeedMinor']);
  });
});

describe('kairon defaultCatalogSpec (DEV-1380)', () => {
  const entry = (id: string, title: string) => ({ id, version: 1, title, whenToUse: '', reads: [], arity: 'pair' });

  it('titles the two shipped widgets in Russian and any other by its manifest title', () => {
    // SCENARIO: the LLM named no spec for a widget, so the server writes one; the page is Russian
    // INPUT: manifest entries cash-line, kpi-tiles and need-rows (title «Need rows»)
    // EXPECTED: the Russian titles for the first two, the manifest title for the third; an empty focus on each
    const focus = { sourceIds: [], partnerIds: [], lineCodes: [] };
    expect([entry('cash-line', 'Cumulative net cash'), entry('kpi-tiles', 'Key figures'), entry('need-rows', 'Need rows')].map(defaultCatalogSpec)).toEqual([
      { widget: 'cash-line', title: 'Накопленный денежный поток', focus },
      { widget: 'kpi-tiles', title: 'Ключевые показатели', focus },
      { widget: 'need-rows', title: 'Need rows', focus },
    ]);
  });
});
