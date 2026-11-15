// A stand-in for the forecast widgets build (DEV-1380): core.mjs, manifest.json and browser.mjs
// written to a temp directory, so the reactor's tests need no build of the widgets package.
// The stub keeps the contract's shape: a manifest, select per widget, spec parsing, instances.
// Its data is a few fields read from the subjects, enough to see what the server handed over.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const STUB_BUILD_ID = 'stub-build-1';

export const STUB_MANIFEST = [
  { id: 'stub-cash', version: 2, title: 'Cumulative cash', whenToUse: 'The cash line moved', reads: ['walk.cumulativeNetCashMinor'], arity: 'pair' },
  { id: 'stub-profit', version: 1, title: 'Net profit', whenToUse: 'The profit moved', reads: ['netProfit', 'exit.month'], arity: 'pair' },
];

const CORE = `
const WIDGETS = ${JSON.stringify(STUB_MANIFEST)};
const known = (id) => {
  const found = WIDGETS.find((w) => w.id === id);
  if (found === undefined) throw new Error('unknown widget "' + id + '"');
  return found;
};
export const buildId = ${JSON.stringify(STUB_BUILD_ID)};
export function parseSnapshot(raw) {
  if (raw.evaluation === null || typeof raw.evaluation !== 'object') throw new Error('snapshot has no evaluation');
  return raw;
}
export const catalog = {
  manifest: () => WIDGETS,
  selectData(id, input) {
    known(id);
    if (input.current.snapshot.evaluation.failSelect === id) throw new Error('widget "' + id + '" selected data that breaks its schema: boom');
    return {
      widget: id,
      current: { id: input.current.id, label: input.current.label, role: input.current.role },
      baseline: input.baseline === null ? [] : [{ id: input.baseline.id, label: input.baseline.label, role: input.baseline.role }],
      currency: input.current.snapshot.context.currency,
      closedThrough: input.current.snapshot.context.closedThrough,
      months: Object.keys(input.current.snapshot.evaluation.walk.cumulativeNetCashMinor).length,
      planLines: input.current.snapshot.document.plan.lines.length,
    };
  },
  parseSpec(raw) {
    if (raw === null || typeof raw !== 'object' || typeof raw.title !== 'string' || raw.title === '') throw new Error('the widget spec breaks its schema: title');
    known(raw.widget);
    return { widget: raw.widget, title: raw.title, focus: raw.focus };
  },
  instance: (spec, data, provenance = 'kairon') => ({ widget: spec.widget, version: known(spec.widget).version, spec, data, provenance }),
  specJsonSchema(ids) {
    return {
      type: 'object',
      properties: { widget: { type: 'string', enum: ids ?? WIDGETS.map((w) => w.id) }, title: { type: 'string' } },
      required: ['widget', 'title'],
      additionalProperties: false,
    };
  },
};
`;

export interface StubDist {
  dir: string;
  remove(): void;
}

/** Writes the stub build; `omit` leaves one file out and `manifestBuildId` states another build in manifest.json. */
export function writeStubWidgetsDist(options: { omit?: 'core.mjs' | 'manifest.json' | 'browser.mjs'; manifestBuildId?: string } = {}): StubDist {
  const dir = mkdtempSync(join(tmpdir(), 'kairon-widgets-'));
  const files: Record<string, string> = {
    'core.mjs': CORE,
    'manifest.json': JSON.stringify({ buildId: options.manifestBuildId ?? STUB_BUILD_ID, specVersion: 1, widgets: STUB_MANIFEST }),
    'browser.mjs': 'export const buildId = "stub-build-1";\nexport function mount() { return () => {}; }\n',
  };
  for (const [name, text] of Object.entries(files)) {
    if (name !== options.omit) writeFileSync(join(dir, name), text);
  }
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
