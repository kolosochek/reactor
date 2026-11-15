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

/**
 * The changed paths of a stage 5 draft; `extra` asks for the paths a widgets manifest reads, `edit` alters a copy
 * of the draft's evaluation and `documents` gives the widget subjects' documents in place of the bodies.
 */
function changedFor(
  file: string,
  extra: string[] = [],
  edit: (evaluation: RawEval) => void = () => {},
  documents: { parentDocument?: unknown; draftDocument?: unknown } = {},
) {
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
  return changedPaths({ parentBody, draftBody, parentEval, draftEval, diff, ...documents }, extra);
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

  it('leaves out a read path whose value is the same on both sides', () => {
    // SCENARIO: widgets read context such as the source groups and the fact boundary, which a draft rarely moves
    // INPUT: cover-cedar, extra paths sourceGroups, factBoundary, walk.months and a path nothing serves
    // EXPECTED: the cover paths alone
    expect(changedFor('cover-cedar', ['sourceGroups', 'factBoundary', 'walk.months', 'nothing.here'])).toEqual(COVER);
  });

  it('counts any path a manifest reads, so no widget is dropped for a path the service does not know (DEV-1381)', () => {
    // SCENARIO: the wave 1 manifest reads draws, the plan lines of the document and per-source maps under walk.sources
    // INPUT: s2-v1 (construction +8 %) against the active forecast, extra paths draws, document.plan.lines,
    //        walk.sources.drawTowardNeedMinor
    // EXPECTED: after the four paths of before: draws 36 (every draw record differs), document.plan.lines 2 (two
    //           plan lines changed; a line whose keys come in another order is the same line),
    //           walk.sources.drawTowardNeedMinor 2 (two of three sources)
    expect(changedFor('s2-v1', ['draws', 'document.plan.lines', 'walk.sources.drawTowardNeedMinor']).slice(4)).toEqual([
      { path: 'draws', cells: 36 },
      { path: 'document.plan.lines', cells: 2 },
      { path: 'walk.sources.drawTowardNeedMinor', cells: 2 },
    ]);
  });

  it('counts a list by the records one side has and the other lacks', () => {
    // SCENARIO: the cover draft replaces 14 of the parent's 36 draw records with 9 of its own
    // INPUT: cover-cedar, extra path draws
    // EXPECTED: draws with 14 cells, the larger of the two sides; the plan lines of the document are unchanged
    expect(changedFor('cover-cedar', ['draws', 'document.plan.lines'])).toEqual([...COVER, { path: 'draws', cells: 14 }]);
  });

  it('counts a path counted always once, under its own counter', () => {
    // SCENARIO: a manifest reads exit.partners and walk.cumulativeNetCashMinor, which the service counts without a catalog
    // INPUT: cover-cedar, extra paths exit.partners and walk.cumulativeNetCashMinor
    // EXPECTED: the cover paths alone, exit.partners once with its 2 partners
    expect(changedFor('cover-cedar', ['exit.partners', 'walk.cumulativeNetCashMinor'])).toEqual(COVER);
  });

  it('reads document paths from the subjects\' documents when they are given', () => {
    // SCENARIO: the widget subjects carry milestones the evaluate bodies lack
    // INPUT: cover-cedar, extra path document.milestones; the parent's document with one milestone, the draft's with
    //        the same one moved; then both with the same one
    // EXPECTED: document.milestones with 1 cell when it moved; not listed when both sides state the same
    const stated = (dueDate: string) => ({ milestones: { entries: [{ code: 'M1', dueDate }] } });
    expect([
      changedFor('cover-cedar', ['document.milestones'], () => {}, { parentDocument: stated('2027-12-01'), draftDocument: stated('2028-03-01') }),
      changedFor('cover-cedar', ['document.milestones'], () => {}, { parentDocument: stated('2027-12-01'), draftDocument: stated('2027-12-01') }),
    ]).toEqual([[...COVER, { path: 'document.milestones', cells: 1 }], COVER]);
  });
});

describe('kairon catalogPaths', () => {
  it('lists every path the manifest reads, once each, in manifest order (DEV-1381)', () => {
    // SCENARIO: two widgets read overlapping paths; none is dropped for being unknown to the service
    // INPUT: reads [walk.uncoveredNeedMinor, exit.partners, netProfit] and [netProfit, sourceGroups]
    // EXPECTED: the four distinct paths in the order they first appear
    const manifest = [{ reads: ['walk.uncoveredNeedMinor', 'exit.partners', 'netProfit'] }, { reads: ['netProfit', 'sourceGroups'] }];
    expect(catalogPaths(manifest)).toEqual(['walk.uncoveredNeedMinor', 'exit.partners', 'netProfit', 'sourceGroups']);
  });
});

describe('kairon defaultCatalogSpec (DEV-1380)', () => {
  const entry = (id: string, title: string) => ({ id, version: 1, title, whenToUse: '', reads: [], arity: 'pair' });

  it('titles a widget by its manifest title, with an empty focus (DEV-1381)', () => {
    // SCENARIO: the LLM named no spec for a widget, so the server writes one; the wave 1 manifest titles are Russian
    // INPUT: manifest entries cash-line («Накопленный денежный поток») and need-rows («Кто покрывает потребность в деньгах»)
    // EXPECTED: the manifest title and an empty focus on each
    const focus = { sourceIds: [], partnerIds: [], lineCodes: [] };
    expect([entry('cash-line', 'Накопленный денежный поток'), entry('need-rows', 'Кто покрывает потребность в деньгах')].map(defaultCatalogSpec)).toEqual([
      { widget: 'cash-line', title: 'Накопленный денежный поток', focus },
      { widget: 'need-rows', title: 'Кто покрывает потребность в деньгах', focus },
    ]);
  });
});
