# @dkolosovsky/reactor-client

Thin HTTP SDK for `@dkolosovsky/reactor-service`. Consumers (Chrome extension, hh.ru CLI scripts, future apps) build Idea triplets locally and dispatch them to a running Reactor service via this client. Browser-friendly (Chrome MV3) and Node-friendly (CLI).

## Status

`v0.1.0` - reactor client genesis (sub-project 4.0).

## Usage

```ts
import { ReactorClient, buildCoverLetterIdea } from '@dkolosovsky/reactor-client';

const client = new ReactorClient({ baseUrl: 'http://localhost:3030' });

const idea = buildCoverLetterIdea({
  vacancy: { title: 'Senior FE', description: 'React, 5+ years' },
  resume: { title: 'FE Eng', content: '7 years React, TypeScript' },
});

const solution = await client.execute(idea, {
  providerConfig: {
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
  },
});

console.log(solution.output);
```

The same pattern works for `buildScoreIdea` (returns `{ score, reasoning, skillMatch }`) and `buildQuestionsIdea` (returns `{ qaPairs }`).

## Error handling

Activity errors come through as typed `TextToolsError` subclasses (`LLMQuotaError`, `LLMTimeoutError`, `IdeaSchemaError`, etc.) reconstructed from the service response. HTTP-level issues (network failure, malformed response, unknown error class) throw `ReactorClientError`.

```ts
import { LLMQuotaError, ReactorClientError } from '@dkolosovsky/reactor-client';

try {
  const sol = await client.execute(idea, { providerConfig });
} catch (err) {
  if (err instanceof LLMQuotaError) {
    console.log(`retry after ${err.retryAfterMs}ms`);
  } else if (err instanceof ReactorClientError) {
    console.log('service unreachable or malformed:', err.message);
  } else {
    throw err;
  }
}
```

## Cancellation

`ReactorClient.execute(idea, { providerConfig, signal })` forwards the `AbortSignal` to the underlying `fetch`, so consumers can wire it to their own `AbortController` for timeout / abort flows.

## Dependencies

- Runtime: `@dkolosovsky/reactor-text-tools` (for builder re-exports and the typed error hierarchy).
- Type-only: `@kolosochek/reactor-core` (for `Idea` / `Solution` shapes); zero runtime cost on the consumer side.

## Spec / plan

- Spec: `docs/specs/2026-04-26-reactor-service-design.md`
- Plan: `docs/plans/2026-04-26-reactor-service-genesis.md`
