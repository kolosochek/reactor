// Trace wrappers for the forecast prototype (DEV-1364 stage 3): tool calls and
// Kairon API calls report their arguments, results and duration as events.

import { describe, expect, it } from 'vitest';
import type { ActivityContext, LLMProvider, ProgressEvent } from '@kolosochek/reactor-core';
import type { KaironApi } from '../kairon/client.js';
import { traceActivity, traceKaironApi } from '../kairon/trace.js';

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
      { id: 'v-f', name: 'Forecast v3', role: 'forecast', isActive: true, payload: { lines: [], monthRange: { from: '2024-12', to: '2028-07' } } },
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
