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

/**
 * Paths counted only for a widgets catalog whose manifest reads them (DEV-1380). Without a catalog
 * the list of changed paths, and so the widgets prompt, stays as it was.
 */
export const CATALOG_PATHS = ['netProfit', 'exit.month', 'walk.uncoveredNeedMinor'] as const;
export type CatalogPath = (typeof CATALOG_PATHS)[number];

/** A changed path and how many cells (lines' months, source-months, months, partners, events) it changed. */
export interface PathChange {
  path: ChangedPath | CatalogPath;
  cells: number;
}

/** The catalog paths a manifest's widgets read, once each, in the order of CATALOG_PATHS. */
export function catalogPaths(manifest: Array<{ reads: string[] }>): CatalogPath[] {
  const reads = new Set(manifest.flatMap((entry) => entry.reads));
  return CATALOG_PATHS.filter((path) => reads.has(path));
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

/** What the catalog paths read; parsed only when one of them is asked for. */
const CatalogPathShape = z.object({
  netProfit: z.string().nullable(),
  exit: z.object({ month: z.string() }).nullable(),
  walk: z.object({ uncoveredNeedMinor: z.record(z.string()) }),
});

type CatalogEvaluation = z.infer<typeof CatalogPathShape>;

const CATALOG_COUNTERS: Record<CatalogPath, (parent: CatalogEvaluation, draft: CatalogEvaluation) => number> = {
  netProfit: (parent, draft) => (parent.netProfit === draft.netProfit ? 0 : 1),
  'exit.month': (parent, draft) => ((parent.exit?.month ?? null) === (draft.exit?.month ?? null) ? 0 : 1),
  'walk.uncoveredNeedMinor': (parent, draft) => differing(parent.walk.uncoveredNeedMinor, draft.walk.uncoveredNeedMinor, '0'),
};

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
 * The paths a draft changed against its parent. `extra` names the catalog paths to count as well
 * (the ones the loaded widgets read); a name with no counter is ignored.
 */
export function changedPaths(
  input: {
    parentBody: EvaluateBody;
    draftBody: EvaluateBody;
    parentEval: unknown;
    draftEval: unknown;
    diff: VariantDiff;
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
  const asked = CATALOG_PATHS.filter((path) => extra.includes(path));
  if (asked.length > 0) {
    const catalogParent = CatalogPathShape.parse(input.parentEval);
    const catalogDraft = CatalogPathShape.parse(input.draftEval);
    for (const path of asked) counts.push({ path, cells: CATALOG_COUNTERS[path](catalogParent, catalogDraft) });
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

/** Russian titles of the shipped catalog widgets; the manifest's own titles are English. */
const CATALOG_TITLES_RU: Record<string, string> = {
  'cash-line': 'Накопленный денежный поток',
  'kpi-tiles': 'Ключевые показатели',
};

/** The spec the server writes for a catalog widget the LLM gave none for: a title and no narrowing. */
export function defaultCatalogSpec(entry: Pick<WidgetManifestEntry, 'id' | 'title'>): CatalogSpec {
  return { widget: entry.id, title: CATALOG_TITLES_RU[entry.id] ?? entry.title, focus: { sourceIds: [], partnerIds: [], lineCodes: [] } };
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
