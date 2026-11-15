// packages/reactor-service/src/routes/kaironRun.ts
//
// DEV-1364 stage 3 routes for the forecast prototype page:
// - GET  /kairon/models: models that accept response_format json_schema, after
//   the free sample model (canned LLM answers, real Kairon evaluate).
// - POST /kairon/run: executes one batch Idea and streams every event as
//   NDJSON ({ t, type, payload } per line): run.start with the request (API
//   key redacted), tool.start / tool.end, llm.request / llm.first_token /
//   llm.delta / llm.done, kairon.call, then run.done with the solution or
//   run.error. Widget data is left out of the events and the catalog instances
//   are written once, in run.done (DEV-1381). /reactor/execute stays unchanged.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Idea, LLMProvider, ProgressEvent, Reactor } from '@kolosochek/reactor-core';
import { DEFAULT_MODEL, loadStructuredModels, type ModelInfo } from '../kairon/models.js';
import { SAMPLE_MODEL } from '../kairon/sampleLlm.js';
import { slimTraceEvent } from '../kairon/trace.js';

const SAMPLE_ENTRY: ModelInfo = {
  id: SAMPLE_MODEL,
  name: 'Демо без LLM: заготовленные варианты, Kairon считает по-настоящему',
  contextLength: null,
  promptUsdPerMTok: 0,
  completionUsdPerMTok: 0,
  preferred: true,
};

const RunBody = z.object({
  idea: z.object({
    schema: z.unknown(),
    context: z.array(z.unknown()),
    solution: z.unknown().nullable(),
  }),
  providerConfig: z.object({
    model: z.string().min(1),
    apiKey: z.string().default(''),
  }),
});

export interface KaironRunDeps {
  /** OPENROUTER_API_KEY from the service .env; used when the page sends no key. */
  defaultApiKey(): string | undefined;
  createLLM(config: { apiKey: string; model: string; emit: (event: ProgressEvent) => void }): LLMProvider;
  buildReactor(llm: LLMProvider): Reactor;
}

export function redactKey(key: string): string {
  return key.length <= 10 ? '…' : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function registerKaironRunRoute(app: FastifyInstance, deps: KaironRunDeps): void {
  app.get('/kairon/models', async () => {
    const { source, models } = await loadStructuredModels();
    return { default: DEFAULT_MODEL, source, serverKey: (deps.defaultApiKey() ?? '') !== '', models: [SAMPLE_ENTRY, ...models] };
  });

  app.post('/kairon/run', async (request, reply) => {
    const parsed = RunBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { class: 'RequestValidationError', message: parsed.error.message } });
    }
    const { idea, providerConfig } = parsed.data;
    const sample = providerConfig.model === SAMPLE_MODEL;
    const envKey = deps.defaultApiKey() ?? '';
    const apiKey = providerConfig.apiKey !== '' ? providerConfig.apiKey : envKey;
    if (apiKey === '' && !sample) {
      return reply.status(400).send({
        error: {
          class: 'RequestValidationError',
          message: 'No OpenRouter key: type it on the page or set OPENROUTER_API_KEY in the service .env',
        },
      });
    }
    const keyShown = sample
      ? 'не нужен'
      : providerConfig.apiKey !== ''
        ? redactKey(apiKey)
        : `.env: ${redactKey(apiKey)}`;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    const started = Date.now();
    const write = (type: string, payload: unknown) => {
      // Widget data is written once per run, not once per event that carries the run's state (slimTraceEvent).
      if (!res.writableEnded) res.write(`${JSON.stringify({ t: Date.now() - started, type, payload: slimTraceEvent(type, payload) })}\n`);
    };
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    write('run.start', {
      request: { idea, providerConfig: { provider: sample ? 'sample' : 'openrouter', model: providerConfig.model, apiKey: keyShown } },
    });
    try {
      const emit = (event: ProgressEvent) => write(event.type, event.payload);
      const llm = deps.createLLM({ apiKey, model: providerConfig.model, emit });
      const reactor = deps.buildReactor(llm);
      const solution = await reactor.execute(idea as Idea, { signal: abort.signal, onProgress: emit });
      write('run.done', { ms: Date.now() - started, solution });
    } catch (err) {
      write('run.error', {
        ms: Date.now() - started,
        class: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    res.end();
  });
}
