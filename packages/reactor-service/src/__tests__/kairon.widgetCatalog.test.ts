// The forecast widgets catalog as the reactor loads it (DEV-1380): the built core.mjs and
// manifest.json of the widgets package, from the directory KAIRON_WIDGETS_DIST names. The package
// lives outside this public repository; only JSON crosses the boundary.

import { afterAll, describe, expect, it } from 'vitest';
import { loadWidgetCatalog, widgetsDistDir } from '../kairon/widgetCatalog.js';
import { STUB_BUILD_ID, STUB_MANIFEST, writeStubWidgetsDist } from './_helpers/widgetsStub.js';

const dist = writeStubWidgetsDist();
afterAll(() => dist.remove());

const CONTEXT = { currency: { code: 'CZK', decimals: 2 }, closedThrough: '2026-08' };
const snapshotOf = (months: string[]) => ({
  document: { plan: { lines: [{ code: 'A1' }] } },
  evaluation: { walk: { cumulativeNetCashMinor: Object.fromEntries(months.map((m) => [m, '1'])) } },
  context: CONTEXT,
});

describe('widgetsDistDir', () => {
  it('is null when the variable is unset or blank', () => {
    // SCENARIO: the service runs with no widgets build, as before DEV-1380
    // INPUT: an env without KAIRON_WIDGETS_DIST; one with an empty value; one with spaces
    // EXPECTED: null for all three
    expect([widgetsDistDir({}), widgetsDistDir({ KAIRON_WIDGETS_DIST: '' }), widgetsDistDir({ KAIRON_WIDGETS_DIST: '  ' })]).toEqual([null, null, null]);
  });

  it('is the directory the variable names', () => {
    // SCENARIO: the owner points the service at a build
    // INPUT: KAIRON_WIDGETS_DIST = the stub directory
    // EXPECTED: that directory
    expect(widgetsDistDir({ KAIRON_WIDGETS_DIST: dist.dir })).toBe(dist.dir);
  });
});

describe('loadWidgetCatalog', () => {
  it('returns null without the variable', async () => {
    // SCENARIO: no widgets build is configured
    // INPUT: an empty env
    // EXPECTED: null, so every caller keeps the old behaviour
    expect(await loadWidgetCatalog({})).toBeNull();
  });

  it('loads the manifest and the build id from the directory', async () => {
    // SCENARIO: a build is configured
    // INPUT: KAIRON_WIDGETS_DIST = the stub directory
    // EXPECTED: the directory, the stub build id and the two manifest entries
    const catalog = await loadWidgetCatalog({ KAIRON_WIDGETS_DIST: dist.dir });
    expect([catalog?.dir, catalog?.buildId, catalog?.manifest]).toEqual([dist.dir, STUB_BUILD_ID, STUB_MANIFEST]);
  });

  it('cuts data for a draft against its parent and assembles an instance', async () => {
    // SCENARIO: the server hands two forecasts to a widget's select and wraps the data with a spec
    // INPUT: a draft with 3 months against an active forecast; spec { widget: stub-cash, title: Деньги }
    // EXPECTED: the stub's data names both subjects; the instance carries the manifest version 2 and provenance kairon
    const catalog = await loadWidgetCatalog({ KAIRON_WIDGETS_DIST: dist.dir });
    if (catalog === null) throw new Error('the stub catalog did not load');
    const current = catalog.subject({ id: 'v1', label: 'v1', role: 'draft', ...snapshotOf(['2026-09', '2026-10', '2026-11']) });
    const baseline = catalog.subject({ id: 'active', label: 'Forecast v3', role: 'active', ...snapshotOf(['2026-09']) });
    const data = catalog.selectData('stub-cash', { current, baseline, others: [] });
    const spec = catalog.parseSpec({ widget: 'stub-cash', title: 'Деньги', focus: { sourceIds: [], partnerIds: [], lineCodes: [] } });
    expect(catalog.instance(spec, data)).toEqual({
      widget: 'stub-cash',
      version: 2,
      spec: { widget: 'stub-cash', title: 'Деньги', focus: { sourceIds: [], partnerIds: [], lineCodes: [] } },
      data: {
        widget: 'stub-cash',
        current: { id: 'v1', label: 'v1', role: 'draft' },
        baseline: [{ id: 'active', label: 'Forecast v3', role: 'active' }],
        currency: { code: 'CZK', decimals: 2 },
        closedThrough: '2026-08',
        months: 3,
        planLines: 1,
      },
      provenance: 'kairon',
    });
  });

  it('narrows the spec schema to the ids it is given', async () => {
    // SCENARIO: one LLM call may name only the widgets a batch can use
    // INPUT: specJsonSchema(['stub-profit'])
    // EXPECTED: the widget enum holds that id alone
    const catalog = await loadWidgetCatalog({ KAIRON_WIDGETS_DIST: dist.dir });
    const schema = catalog?.specJsonSchema(['stub-profit']) as { properties: { widget: { enum: string[] } } };
    expect(schema.properties.widget.enum).toEqual(['stub-profit']);
  });

  it('names the missing file when the directory holds no core.mjs', async () => {
    // SCENARIO: the variable points at a directory the build never wrote to
    // INPUT: a directory with manifest.json and no core.mjs
    // EXPECTED: an error naming the variable and the file
    const broken = writeStubWidgetsDist({ omit: 'core.mjs' });
    await expect(loadWidgetCatalog({ KAIRON_WIDGETS_DIST: broken.dir })).rejects.toThrow(
      `KAIRON_WIDGETS_DIST: ${broken.dir} has no core.mjs; run "npm run build" in the widgets package`,
    );
    broken.remove();
  });

  it('refuses a manifest of another build than the core', async () => {
    // SCENARIO: a half-written build: manifest.json is newer than core.mjs
    // INPUT: manifest.json with buildId other-build beside the stub core
    // EXPECTED: an error naming both build ids
    const mixed = writeStubWidgetsDist({ manifestBuildId: 'other-build' });
    await expect(loadWidgetCatalog({ KAIRON_WIDGETS_DIST: mixed.dir })).rejects.toThrow(
      `KAIRON_WIDGETS_DIST: manifest.json is of build other-build, core.mjs of build ${STUB_BUILD_ID}`,
    );
    mixed.remove();
  });
});
