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
import type { CatalogSpec, WidgetCatalog, WidgetInstance, WidgetManifestEntry } from './widgetCatalog.js';

export type ChangedPath = 'plan.lines' | 'funding.draws' | 'walk.cumulativeNetCashMinor' | 'exit.partners' | 'events';

/** The paths counted with or without a widgets catalog, each by its own counter. */
const OWN_PATHS: readonly ChangedPath[] = ['plan.lines', 'funding.draws', 'walk.cumulativeNetCashMinor', 'exit.partners', 'events'];

/**
 * A changed path and how many cells it changed. An own path counts lines' months, source-months,
 * months, partners or events; a path a widgets manifest reads counts records, keys or 1 (see `cellsBetween`).
 */
export interface PathChange {
  path: string;
  cells: number;
}

/**
 * Every path a manifest's widgets read, once each, in manifest order (DEV-1381). The service counts
 * each one generically, so a widget is never left without an instance for reading a path the
 * service has no counter for.
 */
export function catalogPaths(manifest: Array<{ reads: string[] }>): string[] {
  return [...new Set(manifest.flatMap((entry) => entry.reads))];
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

/** The declarative widgets this service draws itself; any other name in an LLM reply is a catalog widget or unknown. */
export const OWN_WIDGETS: readonly string[] = Object.keys(WIDGET_PATHS);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted, so two records that differ only in key order are the same record. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? 'undefined';
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/** The value at a dotted path; a step into a list reads the rest of the path from every item. */
function valueAt(root: unknown, steps: string[]): unknown {
  const [step, ...rest] = steps;
  if (step === undefined) return root;
  if (Array.isArray(root)) return root.map((item) => valueAt(item, steps));
  return isRecord(root) ? valueAt(root[step], rest) : undefined;
}

/**
 * How many cells differ between two values of one path: for two lists, the records one side has
 * and the other lacks (the larger side); for two maps, the keys whose values differ; otherwise 1
 * when the values differ.
 */
function cellsBetween(parent: unknown, draft: unknown): number {
  if (Array.isArray(parent) && Array.isArray(draft)) {
    const left = parent.map(canonical);
    const right = draft.map(canonical);
    const missingFrom = (from: string[], other: string[]) => {
      const spare = new Map<string, number>();
      for (const item of other) spare.set(item, (spare.get(item) ?? 0) + 1);
      return from.filter((item) => {
        const count = spare.get(item) ?? 0;
        spare.set(item, count - 1);
        return count <= 0;
      }).length;
    };
    return Math.max(missingFrom(left, right), missingFrom(right, left));
  }
  if (isRecord(parent) && isRecord(draft)) {
    return [...new Set([...Object.keys(parent), ...Object.keys(draft)])].filter((key) => canonical(parent[key]) !== canonical(draft[key])).length;
  }
  return canonical(parent) === canonical(draft) ? 0 : 1;
}

/** A forecast as the manifest's paths read it: `document.<path>` from the document, any other path from the evaluation. */
function readAt(side: { document: unknown; evaluation: unknown }, path: string): unknown {
  const steps = path.split('.');
  return steps[0] === 'document' ? valueAt(side.document, steps.slice(1)) : valueAt(side.evaluation, steps);
}

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

/**
 * The paths a draft changed against its parent. `extra` names the paths a widgets manifest reads
 * (`catalogPaths`); each is counted from the two evaluations, or for a `document.` path from the
 * two documents: the widget subjects' documents when given, the evaluate bodies otherwise. A path
 * the service counts itself is listed once, under its own counter.
 */
export function changedPaths(
  input: {
    parentBody: EvaluateBody;
    draftBody: EvaluateBody;
    parentEval: unknown;
    draftEval: unknown;
    diff: VariantDiff;
    parentDocument?: unknown;
    draftDocument?: unknown;
  },
  extra: readonly string[] = [],
): PathChange[] {
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
  const parentSide = { document: input.parentDocument ?? input.parentBody, evaluation: input.parentEval };
  const draftSide = { document: input.draftDocument ?? input.draftBody, evaluation: input.draftEval };
  for (const path of new Set(extra)) {
    if ((OWN_PATHS as readonly string[]).includes(path)) continue;
    counts.push({ path, cells: cellsBetween(readAt(parentSide, path), readAt(draftSide, path)) });
  }
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

// ---------- catalog widgets (DEV-1380) ----------

/** The spec the server writes for a catalog widget the LLM gave none for: the manifest's title and no narrowing. */
export function defaultCatalogSpec(entry: Pick<WidgetManifestEntry, 'id' | 'title'>): CatalogSpec {
  return { widget: entry.id, title: entry.title, focus: { sourceIds: [], partnerIds: [], lineCodes: [] } };
}

// The LLM gives a widget and a title. Its prompt lists no source, partner or line ids, so a focus
// from it names ids that do not exist and the widget hides every row (DEV-1380 review, I3).
// z.object drops the key from a reply that still carries one; the server writes an empty focus.
const LlmCatalogSpec = z.object({ widget: z.string(), title: z.string() });

/** The spec schema offered to the LLM: the package's spec without `focus`. */
export function llmCatalogSpecSchema(catalog: WidgetCatalog, ids: string[]): Record<string, unknown> {
  const schema = catalog.specJsonSchema(ids);
  const { focus: _focus, ...properties } = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.filter((key) => key !== 'focus') : [];
  return { ...schema, properties, required };
}

/** A spec the LLM gave, as the package validates it; null for an unknown widget, a blank title or a broken spec. */
function llmCatalogSpec(catalog: WidgetCatalog, raw: unknown): CatalogSpec | null {
  const parsed = LlmCatalogSpec.safeParse(raw);
  if (!parsed.success || parsed.data.title.trim() === '') return null;
  try {
    return catalog.parseSpec({ ...parsed.data, focus: { sourceIds: [], partnerIds: [], lineCodes: [] } });
  } catch {
    return null;
  }
}

/**
 * The catalog widgets of one scored draft, in manifest order. The server decides which ones: a
 * widget is drawn when the draft's scoring cut its data and one of the paths it reads changed.
 * The LLM's spec gives the title; the default spec fills in when it gave none or a blank one.
 * Each instance carries the build id of the catalog that cut its data (WidgetCatalog.instance).
 */
export function catalogInstances(
  catalog: WidgetCatalog,
  variant: { changed: Array<{ path: string }>; widgetData: Record<string, unknown> | null },
  llmSpecs: unknown[],
): WidgetInstance[] {
  const { widgetData } = variant;
  if (widgetData === null) return [];
  const paths = new Set(variant.changed.map((c) => c.path));
  const given = new Map<string, CatalogSpec>();
  for (const raw of llmSpecs) {
    const spec = llmCatalogSpec(catalog, raw);
    if (spec !== null && !given.has(spec.widget)) given.set(spec.widget, spec);
  }
  return catalog.manifest
    .filter((entry) => Object.hasOwn(widgetData, entry.id) && (entry.reads.length === 0 || entry.reads.some((path) => paths.has(path))))
    .map((entry) => catalog.instance(given.get(entry.id) ?? defaultCatalogSpec(entry), widgetData[entry.id]));
}
