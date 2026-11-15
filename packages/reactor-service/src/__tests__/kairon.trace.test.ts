// Trace wrappers for the forecast prototype (DEV-1364 stage 3): tool calls and
// Kairon API calls report their arguments, results and duration as events.

import { describe, expect, it } from 'vitest';
import type { ActivityContext, LLMProvider, ProgressEvent } from '@kolosochek/reactor-core';
import type { KaironApi } from '../kairon/client.js';
import { slimTraceEvent, traceActivity, traceKaironApi } from '../kairon/trace.js';

function clock(values: number[]): () => number {
  const queue = [...values];
  return () => queue.shift() ?? 0;
}

const llm: LLMProvider = { name: 'none', complete: async () => ({ content: '', model: 'none' }) };

function ctx(events: ProgressEvent[]): ActivityContext {
  return { state: {}, llm, onProgress: (e) => events.push(e) };
}

describe('kairon traceActivity', () => {
  it('reports the tool, its input schema, arguments, output and duration', async () => {
    // SCENARIO: a batch plan calls a traced tool
    // INPUT: tool "kairon.scoreVariants" returning { ok: true }; clock 100 -> 130
    // EXPECTED: tool.start with args and schema, tool.end with output and 30 ms
    const events: ProgressEvent[] = [];
    const traced = traceActivity('kairon.scoreVariants', 'explicit', { type: 'object' }, async () => ({ ok: true }), clock([100, 130]));
    const out = await traced({ a: 1 }, ctx(events));
    expect(out).toEqual({ ok: true });
    expect(events).toEqual([
      { type: 'tool.start', payload: { tool: 'kairon.scoreVariants', kind: 'explicit', inputSchema: { type: 'object' }, args: { a: 1 } } },
      { type: 'tool.end', payload: { tool: 'kairon.scoreVariants', ms: 30, output: { ok: true } } },
    ]);
  });

  it('reports a failing tool and rethrows', async () => {
    // SCENARIO: the baseline cannot reach Kairon
    // INPUT: tool throwing "Kairon 503"; clock 100 -> 105
    // EXPECTED: tool.start, tool.error with the message and 5 ms; the error propagates
    const events: ProgressEvent[] = [];
    const traced = traceActivity('kairon.baseline', 'explicit', {}, async () => {
      throw new Error('Kairon 503');
    }, clock([100, 105]));
    await expect(traced({}, ctx(events))).rejects.toThrow('Kairon 503');
    expect(events.map((e) => e.type)).toEqual(['tool.start', 'tool.error']);
    expect(events[1]?.payload).toEqual({ tool: 'kairon.baseline', ms: 5, message: 'Kairon 503' });
  });
});

describe('kairon traceKaironApi', () => {
  const api: KaironApi = {
    projectId: 'p1',
    pinnedVersionId: 'v-f',
    getProject: async () => ({ id: 'p1', name: 'Rivergate', currentApprovedVersionId: 'v-a', currency: { code: 'CZK', decimals: 2 } }),
    listVersions: async () => [
      { id: 'v-f', name: 'Forecast v3', role: 'forecast', isActive: true, fundingRevision: 0, payload: { lines: [], monthRange: { from: '2024-12', to: '2028-07' } } },
    ],
    getMilestones: async () => [],
    evaluate: async () => ({ status: 422, json: { message: 'closed month' } }),
    createVersion: async () => ({ status: 500, json: null }),
    putFunding: async () => ({ status: 500, json: null }),
  };

  it('reports an evaluate call with its request body and the server reply', async () => {
    // SCENARIO: a variant is scored and the server refuses it
    // INPUT: evaluate("v-f", { plan: 1 }) answered 422; clock 10 -> 25
    // EXPECTED: kairon.call with POST path, status 422, 15 ms, the body and the reply
    const events: ProgressEvent[] = [];
    const traced = traceKaironApi(api, (e) => events.push(e), clock([10, 25]));
    await traced.evaluate('v-f', { plan: 1 });
    expect(events).toEqual([
      {
        type: 'kairon.call',
        payload: {
          op: 'evaluate',
          method: 'POST',
          path: '/api/v1/project-cost/projects/p1/forecast-versions/v-f/evaluate',
          status: 422,
          ms: 15,
          requestBody: { plan: 1 },
          response: { message: 'closed month' },
        },
      },
    ]);
  });

  it('summarises the version list instead of repeating every plan', async () => {
    // SCENARIO: the version list carries every version's full plan
    // INPUT: listVersions with one version; clock 0 -> 7
    // EXPECTED: response is [{ id, name, role, isActive, lines: 0 }]
    const events: ProgressEvent[] = [];
    await traceKaironApi(api, (e) => events.push(e), clock([0, 7])).listVersions();
    expect(events[0]?.payload).toEqual({
      op: 'listVersions',
      method: 'GET',
      path: '/api/v1/project-cost/projects/p1/forecast-versions',
      status: 200,
      ms: 7,
      response: [{ id: 'v-f', name: 'Forecast v3', role: 'forecast', isActive: true, lines: 0 }],
    });
  });
});

describe('kairon slimTraceEvent (DEV-1381)', () => {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const cashData = { points: [{ month: '2026-09', amountMinor: '-37715335486' }] };
  const kpiData = { tiles: [{ label: 'Чистая прибыль', valueMinor: '33342746353' }] };
  const scored = () => ({
    variants: [
      { id: 'v1', status: 'ok', widgetData: { 'cash-line': cashData, 'kpi-tiles': kpiData }, widgetErrors: [] },
      { id: 'v9', status: 'invalid', widgetData: null, widgetErrors: [] },
    ],
    ranking: ['v1'],
  });
  const slimScored = {
    variants: [
      { id: 'v1', status: 'ok', widgetDataBytes: { 'cash-line': bytes(cashData), 'kpi-tiles': bytes(kpiData) }, widgetErrors: [] },
      { id: 'v9', status: 'invalid', widgetData: null, widgetErrors: [] },
    ],
    ranking: ['v1'],
  };
  const cash = { widget: 'cash-line', version: 1, buildId: 'b1', spec: { widget: 'cash-line', title: 'Деньги' }, data: cashData, provenance: 'kairon' };
  const kpi = { widget: 'kpi-tiles', version: 1, buildId: 'b1', spec: { widget: 'kpi-tiles', title: 'Показатели' }, data: kpiData, provenance: 'kairon' };
  const widgets = () => ({ widgets: { v1: [] }, instances: { v1: [cash, kpi] } });
  const slimWidgets = {
    widgets: { v1: [] },
    instances: {
      v1: [
        { widget: 'cash-line', version: 1, buildId: 'b1', bytes: bytes(cash) },
        { widget: 'kpi-tiles', version: 1, buildId: 'b1', bytes: bytes(kpi) },
      ],
    },
  };

  it('replaces widget data with its byte counts in a tool event', () => {
    // SCENARIO: the scoring cut 14 widgets per draft; the same data sat six times in a recording
    // INPUT: tool.end of kairon.scoreVariants with data for v1 and none for the invalid v9; tool.start of
    //        kairon.planWidgets with the same scored state as its argument
    // EXPECTED: v1 carries widgetDataBytes (bytes per widget) and no widgetData; v9 keeps its null; the rest is as it was
    expect([
      slimTraceEvent('tool.end', { tool: 'kairon.scoreVariants', ms: 30, output: scored() }),
      slimTraceEvent('tool.start', { tool: 'kairon.planWidgets', kind: 'latent', inputSchema: {}, args: { scored: scored() } }),
    ]).toEqual([
      { tool: 'kairon.scoreVariants', ms: 30, output: slimScored },
      { tool: 'kairon.planWidgets', kind: 'latent', inputSchema: {}, args: { scored: slimScored } },
    ]);
  });

  it('lists the instances of the widgets step by id and byte count', () => {
    // SCENARIO: the instances live once in a recording, in run.done; the step's own event names what it assembled
    // INPUT: tool.end of kairon.planWidgets with two instances for v1
    // EXPECTED: per instance the widget, its version, the build id and the bytes of the whole instance; specs as they were
    expect(slimTraceEvent('tool.end', { tool: 'kairon.planWidgets', ms: 5, output: widgets() })).toEqual({ tool: 'kairon.planWidgets', ms: 5, output: slimWidgets });
  });

  it('keeps the instances in full in the output of run.done and nowhere else in it', () => {
    // SCENARIO: the page draws a replayed run from solution.output; solution.calls repeats the steps' arguments
    // INPUT: run.done whose solution has calls [{ scored }] and output { scored, widgets }
    // EXPECTED: output.widgets.instances in full; widget data replaced by byte counts in calls and in output.scored
    expect(slimTraceEvent('run.done', { ms: 900, solution: { meta: { steps: 3 }, calls: [{ _tool: 'kairon.planWidgets', scored: scored() }], output: { scored: scored(), widgets: widgets() } } })).toEqual({
      ms: 900,
      solution: { meta: { steps: 3 }, calls: [{ _tool: 'kairon.planWidgets', scored: slimScored }], output: { scored: slimScored, widgets: widgets() } },
    });
  });

  it('leaves the payload it was given untouched', () => {
    // SCENARIO: the payload is the run's own state; the widgets step still reads the widget data from it
    // INPUT: a tool.end payload, slimmed
    // EXPECTED: the payload still equals a fresh copy with the data in place
    const payload = { tool: 'kairon.scoreVariants', ms: 30, output: scored() };
    slimTraceEvent('tool.end', payload);
    expect(payload).toEqual({ tool: 'kairon.scoreVariants', ms: 30, output: scored() });
  });

  it('returns an event with no widget fields as it is', () => {
    // SCENARIO: most events carry neither widget data nor instances
    // INPUT: a kairon.call payload; an llm.delta payload
    // EXPECTED: equal payloads
    const call = { op: 'evaluate', method: 'POST', status: 200, response: { draws: [{ sourceId: 's1' }] } };
    expect([slimTraceEvent('kairon.call', call), slimTraceEvent('llm.delta', { callId: 'c1', text: 'да' })]).toEqual([call, { callId: 'c1', text: 'да' }]);
  });
});
