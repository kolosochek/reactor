// Widgets chosen by changed paths (DEV-1375, spec 5.5): the server lists the
// JSON paths a draft changes against its parent; stage 4 blocks cover most of
// them, and funding.draws always gets the matrix-diff (w1).

import { describe, expect, it } from 'vitest';
import { diffVariant } from '../kairon/diff.js';
import { applyPatch, type EvaluateBody } from '../kairon/patch.js';
import {
  changedPaths,
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

function changedFor(file: string) {
  const draftBody = readStage5(`${file}.body.json`) as EvaluateBody;
  const draftEval = readStage5(`${file}.eval.json`);
  const diff = diffVariant({
    currency: CZK,
    closedThrough: '2026-08',
    derivedLineCodes: [],
    activePlan: parentBody.plan,
    variantPlan: draftBody.plan,
    activeEval: parentEval,
    variantEval: draftEval,
  });
  return changedPaths({ parentBody, draftBody, parentEval, draftEval, diff });
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
