// packages/reactor-service/src/kairon/widgetCatalog.ts
//
// The forecast widgets catalog (DEV-1380). The widgets package is built outside this repository;
// KAIRON_WIDGETS_DIST names the directory with its build:
//   core.mjs      schemas, select and validation, no React (loaded here);
//   manifest.json the build id and the widget list;
//   browser.mjs   the same plus the components and mount(), served to the page.
// Unset, the catalog is null and the service works as before: no widget data, no instances.
// Only JSON crosses the boundary: the package validates with its own zod, this service with its own.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const WIDGETS_DIST_ENV = 'KAIRON_WIDGETS_DIST';
const ENV_NAME = WIDGETS_DIST_ENV;

export interface WidgetManifestEntry {
  id: string;
  version: number;
  title: string;
  whenToUse: string;
  /** JSON paths of the evaluate response and the document the widget reads. */
  reads: string[];
  arity: string;
}

/** What an LLM (or the server's default) states about a widget: which one, its title, what to narrow rows to. */
export interface CatalogSpec {
  widget: string;
  title: string;
  focus: { sourceIds: string[]; partnerIds: string[]; lineCodes: string[] };
}

export interface WidgetInstance {
  widget: string;
  version: number;
  spec: CatalogSpec;
  data: unknown;
  provenance: 'kairon' | 'llm';
  /**
   * The widgets build whose core.mjs cut `data`. The page mounts an instance only with the
   * browser.mjs of the same build, so a saved session replayed after a rebuild draws with the
   * page's own renderers.
   */
  buildId: string;
}

/** A forecast as a widget's select reads it; `snapshot` is opaque to this service. */
export interface CatalogSubject {
  id: string;
  label: string;
  role: 'active' | 'approved' | 'draft';
  snapshot: unknown;
}

export interface SubjectInput {
  id: string;
  label: string;
  role: CatalogSubject['role'];
  /** The forecast document or the evaluate body the evaluation was computed from. */
  document: unknown;
  evaluation: unknown;
  context: { currency: { code: string; decimals: number }; closedThrough: string };
}

export interface WidgetCatalog {
  dir: string;
  buildId: string;
  manifest: WidgetManifestEntry[];
  subject(input: SubjectInput): CatalogSubject;
  /** The widget's data for these forecasts, validated by the package against the widget's schema. */
  selectData(id: string, input: { current: CatalogSubject; baseline: CatalogSubject | null; others: CatalogSubject[] }): unknown;
  parseSpec(raw: unknown): CatalogSpec;
  instance(spec: CatalogSpec, data: unknown): WidgetInstance;
  /** The JSON Schema of a spec, its widget narrowed to `ids`. */
  specJsonSchema(ids: string[]): Record<string, unknown>;
}

const ManifestFile = z.object({
  buildId: z.string().min(1),
  widgets: z.array(
    z.object({
      id: z.string().min(1),
      version: z.number(),
      title: z.string(),
      whenToUse: z.string(),
      reads: z.array(z.string()),
      arity: z.string(),
    }),
  ),
});

/** The part of core.mjs this service calls. */
interface CoreModule {
  buildId: string;
  parseSnapshot(raw: unknown): unknown;
  catalog: {
    selectData(id: string, input: unknown): unknown;
    parseSpec(raw: unknown): CatalogSpec;
    instance(spec: CatalogSpec, data: unknown): Omit<WidgetInstance, 'buildId'>;
    specJsonSchema(ids: string[]): Record<string, unknown>;
  };
}

const CORE_FUNCTIONS = ['selectData', 'parseSpec', 'instance', 'specJsonSchema'] as const;

function isCoreModule(module: unknown): module is CoreModule {
  if (typeof module !== 'object' || module === null) return false;
  const core = module as { buildId?: unknown; parseSnapshot?: unknown; catalog?: Record<string, unknown> };
  const { catalog } = core;
  return (
    typeof core.buildId === 'string' &&
    typeof core.parseSnapshot === 'function' &&
    typeof catalog === 'object' &&
    catalog !== null &&
    CORE_FUNCTIONS.every((name) => typeof catalog[name] === 'function')
  );
}

/** The directory KAIRON_WIDGETS_DIST names, or null when it is unset or blank. */
export function widgetsDistDir(env: Record<string, string | undefined>): string | null {
  const dir = (env[ENV_NAME] ?? '').trim();
  return dir === '' ? null : dir;
}

/** manifest.json of the build, or an error that names the variable when the file is cut short or holds something else. */
function readManifest(dir: string): z.infer<typeof ManifestFile> {
  const file = join(dir, 'manifest.json');
  try {
    return ManifestFile.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`${ENV_NAME}: ${file} is not a widgets manifest: ${messageOf(err)}`);
  }
}

/**
 * The catalog of the build KAIRON_WIDGETS_DIST names; null when the variable is unset. Every fault
 * of the build (a missing file, a manifest that does not parse, a core that does not load or is of
 * another build) rejects with a message that starts with the variable's name.
 */
export async function loadWidgetCatalog(env: Record<string, string | undefined>): Promise<WidgetCatalog | null> {
  const dir = widgetsDistDir(env);
  if (dir === null) return null;
  for (const file of ['core.mjs', 'manifest.json']) {
    if (!existsSync(join(dir, file))) throw new Error(`${ENV_NAME}: ${dir} has no ${file}; run "npm run build" in the widgets package`);
  }
  const manifest = readManifest(dir);
  // The build id in the query makes a rebuilt core load afresh in a process that already imported an older one.
  const url = `${pathToFileURL(join(dir, 'core.mjs')).href}?build=${encodeURIComponent(manifest.buildId)}`;
  const core: unknown = await import(/* @vite-ignore */ url).catch((err: unknown) => {
    throw new Error(`${ENV_NAME}: ${join(dir, 'core.mjs')} does not load: ${messageOf(err)}`);
  });
  if (!isCoreModule(core)) throw new Error(`${ENV_NAME}: core.mjs does not export buildId, parseSnapshot and catalog`);
  if (core.buildId !== manifest.buildId) {
    throw new Error(`${ENV_NAME}: manifest.json is of build ${manifest.buildId}, core.mjs of build ${core.buildId}`);
  }
  return {
    dir,
    buildId: core.buildId,
    manifest: manifest.widgets,
    subject: ({ id, label, role, document, evaluation, context }) => ({
      id,
      label,
      role,
      snapshot: core.parseSnapshot({ document, evaluation, context }),
    }),
    selectData: (id, input) => core.catalog.selectData(id, input),
    parseSpec: (raw) => core.catalog.parseSpec(raw),
    instance: (spec, data) => ({ ...core.catalog.instance(spec, data), buildId: core.buildId }),
    specJsonSchema: (ids) => core.catalog.specJsonSchema(ids),
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every manifest widget's data for a forecast against its baseline. A widget that cannot cut its
 * data (the build and the evaluate disagree) is named in `errors` and left out, so one widget
 * never stops the scoring of a draft.
 */
export function cutWidgetData(
  catalog: WidgetCatalog,
  current: SubjectInput,
  baseline: SubjectInput,
): { data: Record<string, unknown>; errors: string[] } {
  const data: Record<string, unknown> = {};
  const errors: string[] = [];
  let subjects: { current: CatalogSubject; baseline: CatalogSubject; others: CatalogSubject[] };
  try {
    subjects = { current: catalog.subject(current), baseline: catalog.subject(baseline), others: [] };
  } catch (err) {
    return { data, errors: [`snapshot: ${messageOf(err)}`] };
  }
  for (const { id } of catalog.manifest) {
    try {
      data[id] = catalog.selectData(id, subjects);
    } catch (err) {
      errors.push(`${id}: ${messageOf(err)}`);
    }
  }
  return { data, errors };
}

/**
 * A loader that loads once and hands the same result to every later call. The service builds a
 * reactor, and with it one of these loaders, for every POST /kairon/run, so each run reads the
 * build afresh and a rebuilt dist is picked up by the next run without a restart. core.mjs itself
 * is imported once per build id (Node caches the module by its URL).
 */
export function lazyWidgetCatalog(env: Record<string, string | undefined> = process.env): () => Promise<WidgetCatalog | null> {
  let loaded: Promise<WidgetCatalog | null> | null = null;
  return () => {
    loaded ??= loadWidgetCatalog(env);
    return loaded;
  };
}
