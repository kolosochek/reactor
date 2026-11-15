// /kairon/models and the streaming /kairon/run route (DEV-1364 stage 3).

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { Reactor, type LLMProvider } from '@kolosochek/reactor-core';
import { createKaironForecastAdapter } from '../kairon/adapter.js';
import { DEFAULT_MODEL, selectStructuredModels } from '../kairon/models.js';
import { SAMPLE_MODEL } from '../kairon/sampleLlm.js';
import { registerKaironRunRoute } from '../routes/kaironRun.js';
import { baselineEvaluate, fakeKaironApi } from './_helpers/kaironFake.js';

describe('kairon selectStructuredModels', () => {
  it('keeps models with structured outputs, drops batch twins, puts the default first', () => {
    // SCENARIO: the OpenRouter catalog filtered for json_schema output
    // INPUT: 4 models: one without structured_outputs, one :batch twin, gemini-3.8-flash, gpt-5.4-mini
    // EXPECTED: gemini-3.8-flash first (default), then gpt-5.4-mini; prices per 1M tokens
    const catalog = {
      data: [
        { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini', context_length: 400000, pricing: { prompt: '0.00000075', completion: '0.0000045' }, supported_parameters: ['structured_outputs'] },
        { id: 'google/gemini-omni-1.2-flash', name: 'Omni', context_length: 131072, pricing: { prompt: '0.0000015', completion: '0.000009' }, supported_parameters: ['tools'] },
        { id: 'google/gemini-3.8-flash:batch', name: 'Batch', context_length: 1048576, pricing: { prompt: '0.0000004', completion: '0.000002' }, supported_parameters: ['structured_outputs'] },
        { id: DEFAULT_MODEL, name: 'Gemini 3.8 Flash', context_length: 1048576, pricing: { prompt: '0.000000825', completion: '0.000004125' }, supported_parameters: ['structured_outputs', 'response_format'] },
      ],
    };
    expect(selectStructuredModels(catalog)).toEqual([
      { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextLength: 1048576, promptUsdPerMTok: 0.825, completionUsdPerMTok: 4.125, preferred: true },
      { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini', contextLength: 400000, promptUsdPerMTok: 0.75, completionUsdPerMTok: 4.5, preferred: true },
    ]);
  });
});

describe('POST /kairon/run', () => {
  function app(defaultApiKey?: string) {
    const server = Fastify({ logger: false });
    registerKaironRunRoute(server, {
      defaultApiKey: () => defaultApiKey,
      createLLM: () => ({ name: 'none', complete: async () => ({ content: '', model: 'none' }) }) as LLMProvider,
      buildReactor: (llm) => Reactor.create({ llm }).use(createKaironForecastAdapter(fakeKaironApi(baselineEvaluate))),
    });
    return server;
  }

  it('refuses a body without providerConfig with 400', async () => {
    // SCENARIO: the page sends a malformed request
    // INPUT: { idea: {...} } without providerConfig
    // EXPECTED: 400 RequestValidationError
    const res = await app().inject({ method: 'POST', url: '/kairon/run', payload: { idea: { schema: {}, context: [], solution: null } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.class).toBe('RequestValidationError');
  });

  it('streams NDJSON events for a one-step plan and ends with the solution', async () => {
    // SCENARIO: a plan with only kairon.baseline, no LLM step
    // INPUT: providerConfig with a key "sk-or-abcdef123456"
    // EXPECTED: run.start (key redacted) -> tool.start -> 5 kairon.call -> tool.end -> run.done; ndjson content type
    const res = await app().inject({
      method: 'POST',
      url: '/kairon/run',
      payload: {
        idea: {
          schema: {},
          context: [{ type: 'plan', plan: { title: 't', description: 'd', reasoning: 'r', calls: [{ _tool: 'kairon.baseline', _outputPath: '†state.baseline' }] } }],
          solution: null,
        },
        providerConfig: { model: 'google/gemini-3.8-flash', apiKey: 'sk-or-abcdef123456' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    const events = res.body.trim().split('\n').map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
    expect(events.map((e) => e.type)).toEqual([
      'run.start', 'tool.start', 'kairon.call', 'kairon.call', 'kairon.call', 'kairon.call', 'kairon.call', 'tool.end', 'run.done',
    ]);
    expect((events[0]?.payload.request as { providerConfig: unknown }).providerConfig).toEqual({
      provider: 'openrouter',
      model: 'google/gemini-3.8-flash',
      apiKey: 'sk-or-…3456',
    });
    expect(res.body.includes('abcdef12')).toBe(false);
    const solution = events.at(-1)?.payload.solution as { output: { baseline: { closedThrough: string } } };
    expect(solution.output.baseline.closedThrough).toBe('2026-08');
  });

  const baselineOnly = {
    schema: {},
    context: [{ type: 'plan', plan: { title: 't', description: 'd', reasoning: 'r', calls: [{ _tool: 'kairon.baseline', _outputPath: '\u2020state.baseline' }] } }],
    solution: null,
  };

  it('uses the key from the service env when the page sends none', async () => {
    // SCENARIO: OPENROUTER_API_KEY is set in .env and the key field on the page is empty
    // INPUT: providerConfig { model, apiKey: "" }, env key "sk-or-v1-envkey9876"
    // EXPECTED: the run starts; run.start says the key came from .env, redacted
    const res = await app('sk-or-v1-envkey9876').inject({
      method: 'POST',
      url: '/kairon/run',
      payload: { idea: baselineOnly, providerConfig: { model: 'google/gemini-3.8-flash', apiKey: '' } },
    });
    const first = JSON.parse(res.body.split('\n')[0] ?? '{}') as { payload: { request: { providerConfig: unknown } } };
    expect(first.payload.request.providerConfig).toEqual({
      provider: 'openrouter',
      model: 'google/gemini-3.8-flash',
      apiKey: '.env: sk-or-…9876',
    });
    expect(res.body.includes('envkey')).toBe(false);
  });

  it('refuses a run with no key on the page and none in the env', async () => {
    // SCENARIO: nothing to authenticate with OpenRouter
    // INPUT: apiKey "" and no env key
    // EXPECTED: 400 with a message naming both places
    const res = await app().inject({
      method: 'POST',
      url: '/kairon/run',
      payload: { idea: baselineOnly, providerConfig: { model: 'm', apiKey: '' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('No OpenRouter key: type it on the page or set OPENROUTER_API_KEY in the service .env');
  });

  it('runs the free sample model without any key', async () => {
    // SCENARIO: the page demo with canned LLM answers, no OpenRouter key anywhere
    // INPUT: model "kairon/sample-no-llm", apiKey "", no env key
    // EXPECTED: 200; run.start names provider "sample" and no key
    const res = await app().inject({
      method: 'POST',
      url: '/kairon/run',
      payload: { idea: baselineOnly, providerConfig: { model: SAMPLE_MODEL, apiKey: '' } },
    });
    expect(res.statusCode).toBe(200);
    const first = JSON.parse(res.body.split('\n')[0] ?? '{}') as { payload: { request: { providerConfig: unknown } } };
    expect(first.payload.request.providerConfig).toEqual({ provider: 'sample', model: SAMPLE_MODEL, apiKey: 'не нужен' });
  });

  it('writes a run with widget data once: byte counts in the steps, the instances in run.done (DEV-1381)', async () => {
    // SCENARIO: a run with a widgets catalog; a recording must not repeat the widget data in every event
    // INPUT: a reactor that emits tool.end of kairon.scoreVariants with widget data for v1, then returns a
    //        solution whose output holds the scored state and one instance
    // EXPECTED: tool.end carries widgetDataBytes and no widgetData; run.done carries the instance in full and
    //           widgetDataBytes in output.scored
    const data = { points: [{ month: '2026-09', amountMinor: '-1' }] };
    const instance = { widget: 'cash-line', version: 2, buildId: 'b1', spec: { widget: 'cash-line', title: 'Деньги' }, data, provenance: 'kairon' };
    const scored = { variants: [{ id: 'v1', widgetData: { 'cash-line': data } }] };
    const server = Fastify({ logger: false });
    registerKaironRunRoute(server, {
      defaultApiKey: () => undefined,
      createLLM: () => ({ name: 'none', complete: async () => ({ content: '', model: 'none' }) }) as LLMProvider,
      buildReactor: () =>
        ({
          execute: async (_idea: unknown, options: { onProgress?: (event: { type: string; payload: unknown }) => void }) => {
            options.onProgress?.({ type: 'tool.end', payload: { tool: 'kairon.scoreVariants', ms: 1, output: scored } });
            return { calls: [], output: { scored, widgets: { widgets: { v1: [] }, instances: { v1: [instance] } } } };
          },
        }) as unknown as Reactor,
    });
    const res = await server.inject({
      method: 'POST',
      url: '/kairon/run',
      payload: { idea: { schema: {}, context: [], solution: null }, providerConfig: { model: SAMPLE_MODEL } },
    });
    const events = res.body.trim().split('\n').map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
    const slimScored = { variants: [{ id: 'v1', widgetDataBytes: { 'cash-line': Buffer.byteLength(JSON.stringify(data), 'utf8') } }] };
    expect([events.find((e) => e.type === 'tool.end')?.payload, (events.find((e) => e.type === 'run.done')?.payload as { solution: unknown }).solution]).toEqual([
      { tool: 'kairon.scoreVariants', ms: 1, output: slimScored },
      { calls: [], output: { scored: slimScored, widgets: { widgets: { v1: [] }, instances: { v1: [instance] } } } },
    ]);
  });
});
