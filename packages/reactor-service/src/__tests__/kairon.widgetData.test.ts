// Widget data per scored draft (DEV-1380): with a widgets catalog loaded, kairon.scoreVariants cuts
// every catalog widget's data from the draft's evaluation against its parent's. Without a catalog
// the scoring output is what it was. The catalog here is a stub; the last block runs against the
// real build when KAIRON_WIDGETS_DIST names one.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ActivityContext, LLMProvider } from '@kolosochek/reactor-core';
import { createKaironActivities } from '../kairon/activities.js';
import type { Baseline } from '../kairon/baseline.js';
import { planHash, type DraftLineage } from '../kairon/lineage.js';
import { loadWidgetCatalog, type WidgetCatalog } from '../kairon/widgetCatalog.js';
import type { HttpResult, KaironMilestone } from '../kairon/client.js';
import { fakeKaironApi, fixtureDoc, RIVERGATE_FUNDING_SETTINGS, stage5Evaluate } from './_helpers/kaironFake.js';
import { writeStubWidgetsDist } from './_helpers/widgetsStub.js';

const dist = writeStubWidgetsDist();
afterAll(() => dist.remove());

const noLlm: LLMProvider = {
  name: 'none',
  complete: async () => {
    throw new Error('scoring asks no LLM');
  },
};
const ctx: ActivityContext = { state: {}, llm: noLlm };

const HASH = planHash({ ...fixtureDoc, fundingSettings: RIVERGATE_FUNDING_SETTINGS });
const CONSTRUCTION = { type: 'cost_change' as const, lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 };
const V1_LINEAGE: DraftLineage = { activePlanHash: HASH, scenario: CONSTRUCTION, leverPatch: null, steps: [] };
const PROFIT_GOAL = { type: 'net_profit_target' as const, amountMinor: '1000000000', basis: 'delta' as const };
const V1_1_LINEAGE: DraftLineage = {
  ...V1_LINEAGE,
  steps: [{ type: 'levers', goal: PROFIT_GOAL, patch: { name: 'v1.1', scale: [{ lineCodes: ['R1'], fromMonth: '2026-09', factorPpm: 1_030_000 }] } }],
};
const draft = (id: string, lineage: DraftLineage, parentId: string | null = null) => ({ id, parentId, title: `Draft ${id}`, rationale: '', levers: [], lineage });

interface ScoredOut {
  variants: Array<{
    id: string;
    status: string;
    changed: Array<{ path: string; cells: number }>;
    widgetData?: Record<string, unknown> | null;
    widgetErrors?: string[];
  }>;
  undatedMilestones?: string[];
}

type Evaluate = (versionId: string, body: unknown) => HttpResult;

/** Scores drafts on the fake Kairon; `milestones` replaces the one milestone the fake serves. */
async function score(
  input: Record<string, unknown>,
  widgets: (() => Promise<WidgetCatalog | null>) | undefined,
  evaluate: Evaluate = stage5Evaluate,
  milestones?: KaironMilestone[],
): Promise<ScoredOut> {
  const fake = fakeKaironApi(evaluate, { partners: true });
  const api = milestones === undefined ? fake : { ...fake, projectId: fake.projectId, pinnedVersionId: fake.pinnedVersionId, getMilestones: async () => milestones };
  const activities = createKaironActivities(api, widgets);
  const b = (await activities['kairon.baseline']({}, ctx)) as Baseline;
  return (await activities['kairon.scoreVariants']({ baseline: b, goals: [], parents: [], ...input }, ctx)) as ScoredOut;
}

const stub = () => loadWidgetCatalog({ KAIRON_WIDGETS_DIST: dist.dir });
const STUB_DATA = (widget: string, current: string, baseline: { id: string; label: string; role: string }) => ({
  widget,
  current: { id: current, label: current, role: 'draft' },
  baseline: [baseline],
  currency: { code: 'CZK', decimals: 2 },
  closedThrough: '2026-08',
  months: 44,
  planLines: 45,
  // No patch moves a milestone, so a draft states none of its own; the active forecast states its version's (DEV-1381).
  milestones: [],
  baselineMilestones: baseline.role === 'active' ? ['OCCUPANCY_PERMIT 2027-12-30'] : [],
});
const ACTIVE = { id: 'active', label: 'Forecast v3', role: 'active' };

describe('kairon.scoreVariants without a widgets catalog', () => {
  it('adds no widget fields and counts the paths of before', async () => {
    // SCENARIO: the service runs with no KAIRON_WIDGETS_DIST
    // INPUT: S2 v1 (construction +8 %) against the active forecast, no catalog
    // EXPECTED: no widgetData and no widgetErrors key, no undatedMilestones on the run; the four changed paths, no netProfit
    const out = await score({ proposals: { variants: [draft('v1', V1_LINEAGE)] } }, undefined);
    const v1 = out.variants[0];
    expect([v1?.status, 'widgetData' in (v1 ?? {}), 'widgetErrors' in (v1 ?? {}), 'undatedMilestones' in out, v1?.changed.map((c) => c.path)]).toEqual([
      'ok',
      false,
      false,
      false,
      ['plan.lines', 'funding.draws', 'walk.cumulativeNetCashMinor', 'exit.partners'],
    ]);
  });
});

describe('kairon.scoreVariants with a widgets catalog', () => {
  it('cuts every catalog widget for a draft, with the active forecast as the baseline', async () => {
    // SCENARIO: a top-level draft; the catalog's widgets read the cash line, the net profit and the exit month
    // INPUT: S2 v1 against the active forecast «Forecast v3», the stub catalog
    // EXPECTED: data for both stub widgets naming v1 (draft) and Forecast v3 (active), CZK with 2 decimals,
    //           closed through 2026-08, 44 months, 45 plan lines, the active version's milestone on the baseline
    //           and none on the draft; no errors; no undated milestone; netProfit joins the changed paths
    const out = await score({ proposals: { variants: [draft('v1', V1_LINEAGE)] } }, stub);
    const v1 = out.variants[0];
    expect([v1?.widgetData, v1?.widgetErrors, out.undatedMilestones, v1?.changed]).toEqual([
      { 'stub-cash': STUB_DATA('stub-cash', 'v1', ACTIVE), 'stub-profit': STUB_DATA('stub-profit', 'v1', ACTIVE) },
      [],
      [],
      [
        { path: 'plan.lines', cells: 46 },
        { path: 'funding.draws', cells: 36 },
        { path: 'walk.cumulativeNetCashMinor', cells: 23 },
        { path: 'exit.partners', cells: 2 },
        { path: 'netProfit', cells: 1 },
      ],
    ]);
  });

  it('takes the parent draft as the baseline of a child draft', async () => {
    // SCENARIO: «чистая прибыль +10 млн» on S2 v1 gives the child v1.1 (prices +3 %)
    // INPUT: v1.1 with parent v1, the stub catalog
    // EXPECTED: the baseline is v1, a draft labelled by its id
    const out = await score({ proposals: { variants: [draft('v1.1', V1_1_LINEAGE, 'v1')] }, parents: [{ id: 'v1', lineage: V1_LINEAGE }] }, stub);
    const data = out.variants[0]?.widgetData as Record<string, { baseline: unknown }> | undefined;
    expect([out.variants[0]?.status, data?.['stub-cash']?.baseline]).toEqual(['ok', [{ id: 'v1', label: 'v1', role: 'draft' }]]);
  });

  it('gives a draft no milestones of its own, as a draft and as a parent', async () => {
    // SCENARIO: no patch op moves a milestone, so a draft that carried the active version's dates read
    //           «Сдвинуто вех: 0» even for a delay; with none the package says the shift is unknown (review I1)
    // INPUT: v1.1 with parent v1, the stub catalog
    // EXPECTED: no milestone on the draft and none on its parent draft
    const out = await score({ proposals: { variants: [draft('v1.1', V1_1_LINEAGE, 'v1')] }, parents: [{ id: 'v1', lineage: V1_LINEAGE }] }, stub);
    const data = out.variants[0]?.widgetData as Record<string, { milestones: unknown; baselineMilestones: unknown }> | undefined;
    expect([data?.['stub-cash']?.milestones, data?.['stub-cash']?.baselineMilestones]).toEqual([[], []]);
  });

  it('leaves a milestone with no due date out of the active forecast and names it once per run', async () => {
    // SCENARIO: Kairon serves a milestone whose due date is not set; the package's document takes dated milestones only
    // INPUT: milestones LAND (2026-01-15) and HANDOVER (no due date); two drafts of the active forecast, the stub catalog
    // EXPECTED: LAND alone on the active side of both drafts; no widget error; the run names HANDOVER once
    const out = await score({ proposals: { variants: [draft('v1', V1_LINEAGE), draft('v2', V1_LINEAGE)] } }, stub, stage5Evaluate, [
      { code: 'LAND', name: 'Land', dueDate: '2026-01-15', completedAt: null },
      { code: 'HANDOVER', name: 'Handover', dueDate: null, completedAt: null },
    ]);
    const sides = out.variants.map((v) => (v.widgetData as Record<string, { baselineMilestones: unknown }> | undefined)?.['stub-cash']?.baselineMilestones);
    expect([sides, out.variants.map((v) => v.widgetErrors), out.undatedMilestones]).toEqual([[['LAND 2026-01-15'], ['LAND 2026-01-15']], [[], []], ['HANDOVER']]);
  });

  it('keeps scoring when one widget cannot cut its data, and names it', async () => {
    // SCENARIO: the build and the evaluate disagree for one widget; the draft must still be scored
    // INPUT: S2 v1 whose evaluation makes the stub's stub-cash select throw
    // EXPECTED: status ok; data for stub-profit only; one error naming stub-cash
    const failing: Evaluate = (versionId, body) => {
      const res = stage5Evaluate(versionId, body);
      return JSON.stringify(body) === '{}' ? res : { ...res, json: { ...(res.json as object), failSelect: 'stub-cash' } };
    };
    const out = await score({ proposals: { variants: [draft('v1', V1_LINEAGE)] } }, stub, failing);
    const v1 = out.variants[0];
    expect([v1?.status, Object.keys(v1?.widgetData ?? {}), v1?.widgetErrors]).toEqual([
      'ok',
      ['stub-profit'],
      ['stub-cash: widget "stub-cash" selected data that breaks its schema: boom'],
    ]);
  });

  it('gives a draft Kairon did not score no widget data', async () => {
    // SCENARIO: a draft whose parent is unknown is invalid, so there is no evaluation to cut from
    // INPUT: v9 with parent v8, which is not among the parents
    // EXPECTED: status invalid, widgetData null, no errors
    const out = await score({ proposals: { variants: [draft('v9', V1_LINEAGE, 'v8')] } }, stub);
    const v9 = out.variants[0];
    expect([v9?.status, v9?.widgetData, v9?.widgetErrors]).toEqual(['invalid', null, []]);
  });
});

const REAL_DIST = (process.env.KAIRON_WIDGETS_DIST ?? '').trim();

describe.skipIf(REAL_DIST === '')('kairon.scoreVariants with the real widgets build', () => {
  it('cuts every widget of the wave 1 build for S2 v1 against the active forecast', async () => {
    // SCENARIO: the page will draw v1 against Forecast v3 from this data (DEV-1381: 14 widgets)
    // INPUT: S2 v1, the build KAIRON_WIDGETS_DIST names
    // EXPECTED: data for all 14 widgets and no error; cash-line version 2 (DEV-1388): CZK, closed 2026-08, v1
    //           as the current series in slot 1, Forecast v3 as the one baseline series in slot 0, both loaded,
    //           no other series; 44 months on both sides, 2026-08 equal on both sides and 2026-09 lower for the
    //           draft by 3 013 205,75 CZK; milestone-band: the active version's one milestone on the baseline, none
    //           on the draft, and a view whose shift is unknown; document.milestones is not among the changed paths
    const out = await score({ proposals: { variants: [draft('v1', V1_LINEAGE)] } }, () => loadWidgetCatalog({ KAIRON_WIDGETS_DIST: REAL_DIST }));
    const v1 = out.variants[0];
    type Point = { month: string; amountMinor: string };
    type Series = { subject: unknown; slot: number; read: string; points: Point[] };
    const cash = (v1?.widgetData ?? {})['cash-line'] as { currency: unknown; closedThrough: unknown; current: Series; baseline: Series[]; others: Series[] };
    const header = (series: Series) => ({ subject: series.subject, slot: series.slot, read: series.read });
    const currentPoints = cash.current.points;
    const baselinePoints = cash.baseline.flatMap((series) => series.points);
    const at = (points: Point[], month: string) => points.find((p) => p.month === month)?.amountMinor;
    const band = (v1?.widgetData ?? {})['milestone-band'] as { milestones: Array<{ code: string }>; baselineMilestones: Array<{ code: string }> };
    const core = (await import(/* @vite-ignore */ pathToFileURL(join(REAL_DIST, 'core.mjs')).href)) as {
      catalog: { definition(id: string): { view(data: unknown, spec: unknown): { shiftKnown: boolean } }; parseData(id: string, data: unknown): unknown };
    };
    const bandSpec = { widget: 'milestone-band', title: 'Вехи проекта', focus: { sourceIds: [], partnerIds: [], lineCodes: [] } };
    const bandView = core.catalog.definition('milestone-band').view(core.catalog.parseData('milestone-band', band), bandSpec);
    expect({
      errors: v1?.widgetErrors,
      widgets: Object.keys(v1?.widgetData ?? {}).sort(),
      header: [cash.currency, cash.closedThrough, header(cash.current), cash.baseline.map(header), cash.others],
      months: [currentPoints.length, baselinePoints.length],
      august: [at(currentPoints, '2026-08'), at(baselinePoints, '2026-08')],
      september: [at(currentPoints, '2026-09'), at(baselinePoints, '2026-09')],
      milestones: [band.milestones.map((m) => m.code), band.baselineMilestones.map((m) => m.code)],
      shiftKnown: bandView.shiftKnown,
      milestonesChanged: v1?.changed.some((c) => c.path === 'document.milestones'),
    }).toEqual({
      errors: [],
      widgets: [
        'bank-card',
        'cash-line',
        'draws-bars',
        'draws-matrix',
        'kpi-tiles',
        'milestone-band',
        'need-rows',
        'partner-frames',
        'partner-returns',
        'plan-bridge',
        'profit-ladder',
        'scenario-metrics',
        'share-mix',
        'signals',
      ],
      header: [
        { code: 'CZK', decimals: 2 },
        ['2026-08'],
        { subject: { id: 'v1', label: 'v1', role: 'draft' }, slot: 1, read: 'loaded' },
        [{ subject: { id: 'active', label: 'Forecast v3', role: 'active' }, slot: 0, read: 'loaded' }],
        [],
      ],
      months: [44, 44],
      august: ['-34738050274', '-34738050274'],
      september: ['-37715335486', '-37414014911'],
      milestones: [[], ['OCCUPANCY_PERMIT']],
      shiftKnown: false,
      milestonesChanged: false,
    });
  });

  it('puts a draft and its parent draft in the same cash-line slot', async () => {
    // SCENARIO: the package dashes a baseline only on an equal slot; the reactor sets no slot, so a draft
    //           against its parent draft relies on the package's default (DEV-1388)
    // INPUT: v1.1 with parent v1, the build KAIRON_WIDGETS_DIST names
    // EXPECTED: v1.1 as the current series and v1 as the one baseline series, both in slot 1 and loaded
    const out = await score({ proposals: { variants: [draft('v1.1', V1_1_LINEAGE, 'v1')] }, parents: [{ id: 'v1', lineage: V1_LINEAGE }] }, () =>
      loadWidgetCatalog({ KAIRON_WIDGETS_DIST: REAL_DIST }),
    );
    type Series = { subject: { id: string; role: string }; slot: number; read: string };
    const cash = (out.variants[0]?.widgetData ?? {})['cash-line'] as { current: Series; baseline: Series[]; others: Series[] };
    const header = (series: Series) => [series.subject.id, series.subject.role, series.slot, series.read];
    expect([header(cash.current), cash.baseline.map(header), cash.others]).toEqual([['v1.1', 'draft', 1, 'loaded'], [['v1', 'draft', 1, 'loaded']], []]);
  });
});
