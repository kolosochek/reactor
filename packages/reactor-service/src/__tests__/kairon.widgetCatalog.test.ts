// The forecast widgets catalog as the reactor loads it (DEV-1380): the built core.mjs and
// manifest.json of the widgets package, from the directory KAIRON_WIDGETS_DIST names. The package
// lives outside this public repository; only JSON crosses the boundary.

import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ActivityContext, LLMCompletionRequest, LLMCompletionResponse, LLMProvider, ProgressEvent } from '@kolosochek/reactor-core';
import { createKaironActivities } from '../kairon/activities.js';
import { loadWidgetCatalog, widgetsDistDir } from '../kairon/widgetCatalog.js';
import { baselineEvaluate, fakeKaironApi } from './_helpers/kaironFake.js';
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
    // EXPECTED: the stub's data names both subjects; the instance carries the manifest version 2, provenance kairon
    //           and the build id of the core that cut the data
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
      buildId: STUB_BUILD_ID,
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

  it('names the variable when manifest.json is not a widgets manifest', async () => {
    // SCENARIO: a build was interrupted while writing manifest.json, or the file holds something else (review minor 7)
    // INPUT: (a) manifest.json cut mid-object; (b) manifest.json holding null
    // EXPECTED: both reject with an error naming the variable and the file
    const cut = writeStubWidgetsDist({ manifestText: '{"buildId": "stub-bu' });
    const empty = writeStubWidgetsDist({ manifestText: 'null' });
    await expect(loadWidgetCatalog({ KAIRON_WIDGETS_DIST: cut.dir })).rejects.toThrow(`KAIRON_WIDGETS_DIST: ${cut.dir}/manifest.json is not a widgets manifest: `);
    await expect(loadWidgetCatalog({ KAIRON_WIDGETS_DIST: empty.dir })).rejects.toThrow(`KAIRON_WIDGETS_DIST: ${empty.dir}/manifest.json is not a widgets manifest: `);
    cut.remove();
    empty.remove();
  });

  it('names the variable when core.mjs does not load', async () => {
    // SCENARIO: a partial build left a core.mjs that does not parse (review I4)
    // INPUT: core.mjs holding half a statement
    // EXPECTED: an error naming the variable and the file
    const partial = writeStubWidgetsDist({ coreText: 'export const buildId = ' });
    await expect(loadWidgetCatalog({ KAIRON_WIDGETS_DIST: partial.dir })).rejects.toThrow(`KAIRON_WIDGETS_DIST: ${partial.dir}/core.mjs does not load: `);
    partial.remove();
  });
});

describe('a run and the widgets build (DEV-1380 review, I4)', () => {
  const ROUTE_INPUT = { message: 'Что с банком?', drafts: [{ id: 'v1', title: 'Только задержка' }], selected: null };
  const ROUTE_REPLY = '{"kind":"question","scope":[]}';
  const SCORED = { scored: { variants: [{ id: 'v1', status: 'ok', changed: [{ path: 'funding.draws', cells: 14 }], widgetData: null }] } };

  /** A run's context that records, in order, each widgets warning and each LLM call. */
  function recorded(replies: string[]) {
    const order: string[] = [];
    const warnings: unknown[] = [];
    const queue = [...replies];
    const complete = vi.fn<[LLMCompletionRequest], Promise<LLMCompletionResponse>>(async () => {
      order.push('llm');
      return { content: queue.shift() ?? '{}', model: 'scripted' };
    });
    const llm: LLMProvider = { name: 'scripted', complete };
    const ctx: ActivityContext = {
      state: {},
      llm,
      onProgress: (event: ProgressEvent) => {
        if (event.type !== 'kairon.widgets.warning') return;
        order.push('warning');
        warnings.push(event.payload);
      },
    };
    return { ctx, order, warnings };
  }

  it('warns once before the first LLM call and runs with no catalog when the build is broken', async () => {
    // SCENARIO: KAIRON_WIDGETS_DIST names a directory with no core.mjs; the run must not fail after paid LLM calls
    // INPUT: one set of activities over that directory; kairon.route, then kairon.planWidgets, on one context
    // EXPECTED: one warning that names the variable, emitted before the first LLM call; the route answers as it
    //           does with no catalog; the widgets step returns specs alone, with no instances key
    const broken = writeStubWidgetsDist({ omit: 'core.mjs' });
    const activities = createKaironActivities(fakeKaironApi(baselineEvaluate), () => loadWidgetCatalog({ KAIRON_WIDGETS_DIST: broken.dir }));
    const run = recorded([ROUTE_REPLY, JSON.stringify({ widgets: [] })]);
    const routed = await activities['kairon.route'](ROUTE_INPUT, run.ctx);
    const planned = await activities['kairon.planWidgets'](SCORED, run.ctx);
    expect([run.order, run.warnings, routed, Object.keys(planned as object)]).toEqual([
      ['warning', 'llm', 'llm'],
      [{ message: `KAIRON_WIDGETS_DIST: ${broken.dir} has no core.mjs; run "npm run build" in the widgets package. The run goes on with no catalog widgets.` }],
      { kind: 'question', scope: [], error: null },
      ['widgets'],
    ]);
    broken.remove();
  });

  it('loads a working build before the first LLM call, once per set of activities, with no warning', async () => {
    // SCENARIO: the catalog is loaded up front so a fault shows before any LLM call is paid for
    // INPUT: a loader over the stub build that records each call; kairon.route, then kairon.planWidgets
    // EXPECTED: one load, before the first LLM call; no warning; the widgets step returns instances
    const loads: string[] = [];
    const run = recorded([ROUTE_REPLY, JSON.stringify({ widgets: [] })]);
    const activities = createKaironActivities(fakeKaironApi(baselineEvaluate), () => {
      run.order.push('load');
      loads.push('load');
      return loadWidgetCatalog({ KAIRON_WIDGETS_DIST: dist.dir });
    });
    await activities['kairon.route'](ROUTE_INPUT, run.ctx);
    const planned = await activities['kairon.planWidgets'](SCORED, run.ctx);
    expect([run.order, loads.length, run.warnings, Object.keys(planned as object)]).toEqual([['load', 'llm', 'llm'], 1, [], ['widgets', 'instances']]);
  });
});
