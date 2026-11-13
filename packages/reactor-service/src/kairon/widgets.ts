// packages/reactor-service/src/kairon/widgets.ts
//
// Widgets chosen by changed paths (DEV-1375, spec 5.5). The server lists the
// JSON paths a draft changes against its parent and how many cells each
// changed. Stage 4 blocks are the existing widgets for plan lines, cumulative
// cash, partner IRR and events; a changed path without one gets a declarative
// spec from the LLM's widgets step (a tool name and the paths it reads, no
// HTML, no numbers). funding.draws always gets the matrix-diff (w1): the
// owner made it mandatory.

import { z } from 'zod';
import type { VariantDiff } from './diff.js';
import type { EvaluateBody } from './patch.js';
import { changedPlanCells } from './reconcile.js';

export type ChangedPath = 'plan.lines' | 'funding.draws' | 'walk.cumulativeNetCashMinor' | 'exit.partners' | 'events';

/** A changed path and how many cells (lines' months, source-months, months, partners, events) it changed. */
export interface PathChange {
  path: ChangedPath;
  cells: number;
}

export const EXISTING_WIDGETS: Record<Exclude<ChangedPath, 'funding.draws'>, 'bridge' | 'cash' | 'irr' | 'timeline'> = {
  'plan.lines': 'bridge',
  'walk.cumulativeNetCashMinor': 'cash',
  'exit.partners': 'irr',
  events: 'timeline',
};

const Title = z.string().min(1);

export const WidgetSpecSchema = z.discriminatedUnion('widget', [
  z
    .object({
      widget: z.literal('matrix-diff'),
      title: Title,
      rows: z.literal('draws[].sourceId'),
      cols: z.literal('draws[].period'),
      value: z.literal('amountMinor'),
      highlight: z.literal('changed'),
      delta: z.literal('cell, row'),
    })
    .strict(),
  z
    .object({
      widget: z.literal('bars-before-after'),
      title: Title,
      x: z.literal('period'),
      stack: z.literal('sourceId'),
      y: z.literal('amountMinor'),
      compare: z.tuple([z.string().min(1), z.string().min(1)]),
      label: z.string().min(1),
    })
    .strict(),
  z.object({ widget: z.literal('condition-check'), title: Title, goals: z.literal('active') }).strict(),
  z.object({ widget: z.literal('stakeholder-table'), title: Title, rows: z.array(z.string().min(1)) }).strict(),
]);

export type WidgetSpec = z.infer<typeof WidgetSpecSchema>;

/** The paths a widget reads; an empty list means it is always kept (the goal checks). */
const WIDGET_PATHS: Record<WidgetSpec['widget'], ChangedPath[]> = {
  'matrix-diff': ['funding.draws'],
  'bars-before-after': ['funding.draws'],
  'condition-check': [],
  'stakeholder-table': ['funding.draws', 'exit.partners'],
};

const WidgetInputsShape = z.object({
  draws: z.array(z.object({ sourceId: z.string(), period: z.string(), amountMinor: z.string() })),
  walk: z.object({ sources: z.array(z.object({ id: z.string(), name: z.string() })), cashNeedMinor: z.record(z.string()) }),
  sourceGroups: z.array(z.object({ sourceId: z.string(), partnerId: z.string().optional() })),
});

/** The slice of an evaluation the draws widgets (w1, w2) read; it rides on each scored variant. */
export type WidgetInputs = z.infer<typeof WidgetInputsShape>;

export function widgetInputs(evaluation: unknown): WidgetInputs {
  return WidgetInputsShape.parse(evaluation);
}

const PathShape = z.object({
  draws: z.array(z.object({ sourceId: z.string(), period: z.string(), amountMinor: z.string() })),
  walk: z.object({ cumulativeNetCashMinor: z.record(z.string()) }),
  exit: z.object({ partners: z.array(z.object({ partnerId: z.string(), irr: z.number().nullable() })) }).nullable(),
});

type Evaluation = z.infer<typeof PathShape>;

function drawCells(e: Evaluation): Map<string, bigint> {
  const cells = new Map<string, bigint>();
  for (const d of e.draws) {
    const key = `${d.sourceId}|${d.period.slice(0, 7)}`;
    cells.set(key, (cells.get(key) ?? 0n) + BigInt(d.amountMinor));
  }
  return cells;
}

function differing<V>(a: Map<string, V> | Record<string, V>, b: Map<string, V> | Record<string, V>, zero: V): number {
  const am = a instanceof Map ? a : new Map(Object.entries(a));
  const bm = b instanceof Map ? b : new Map(Object.entries(b));
  return [...new Set([...am.keys(), ...bm.keys()])].filter((k) => (am.get(k) ?? zero) !== (bm.get(k) ?? zero)).length;
}

export function changedPaths(input: {
  parentBody: EvaluateBody;
  draftBody: EvaluateBody;
  parentEval: unknown;
  draftEval: unknown;
  diff: VariantDiff;
}): PathChange[] {
  const parent = PathShape.parse(input.parentEval);
  const draft = PathShape.parse(input.draftEval);
  const irrOf = (e: Evaluation) => new Map((e.exit?.partners ?? []).map((p) => [p.partnerId, p.irr]));
  const counts: PathChange[] = [
    { path: 'plan.lines', cells: [...changedPlanCells(input.parentBody, input.draftBody).values()].reduce((s, n) => s + n, 0) },
    { path: 'funding.draws', cells: differing(drawCells(parent), drawCells(draft), 0n) },
    { path: 'walk.cumulativeNetCashMinor', cells: differing(parent.walk.cumulativeNetCashMinor, draft.walk.cumulativeNetCashMinor, '0') },
    { path: 'exit.partners', cells: differing(irrOf(parent), irrOf(draft), null) },
    { path: 'events', cells: input.diff.events.filter((e) => e.active !== e.variant).length },
  ];
  return counts.filter((c) => c.cells > 0);
}

const MATRIX: WidgetSpec = {
  widget: 'matrix-diff',
  title: 'Транши по инвесторам',
  rows: 'draws[].sourceId',
  cols: 'draws[].period',
  value: 'amountMinor',
  highlight: 'changed',
  delta: 'cell, row',
};

const BARS: WidgetSpec = {
  widget: 'bars-before-after',
  title: 'Транши по инвесторам: было и стало',
  x: 'period',
  stack: 'sourceId',
  y: 'amountMinor',
  compare: ['parent', 'draft'],
  label: 'Δ за месяц',
};

export function defaultWidgets(changed: PathChange[]): WidgetSpec[] {
  return changed.some((c) => c.path === 'funding.draws') ? [MATRIX, BARS] : [];
}

export function withMandatory(specs: WidgetSpec[], changed: PathChange[]): WidgetSpec[] {
  const paths = new Set(changed.map((c) => c.path));
  const kept = specs.filter((s) => {
    const reads = WIDGET_PATHS[s.widget];
    return reads.length === 0 || reads.some((p) => paths.has(p));
  });
  return paths.has('funding.draws') && !kept.some((s) => s.widget === 'matrix-diff') ? [MATRIX, ...kept] : kept;
}
