# @reactor/text-tools

Platform-agnostic text-LLM domain adapter on top of `@kolosochek/reactor-core`.

Provides three Idea-Triplet Activities - `generateCoverLetter`, `scoreVacancy`, `answerQuestions` - that operate on raw text input (`{ vacancy: { title, description }, resume: { title, content } }`) and return structured Solutions. No platform coupling, no DB roundtrip. Consumed by both the Chrome extension and the hh.ru `@hhru/reactor-adapter` (after Phase C+ migrations 4.2 and 4.3).

## Status

`v0.1.0` - text-tools genesis (sub-project 4.1 of the Phase C+ decoupling work).

## Usage

```ts
import { Reactor, InMemoryRepositories, createOpenRouter } from '@kolosochek/reactor-core';
import {
  textToolsAdapter,
  buildCoverLetterIdea,
  buildScoreIdea,
  buildQuestionsIdea,
} from '@reactor/text-tools';

const reactor = Reactor.create({ llm: createOpenRouter({ apiKey: '...' }) });
reactor.use({ ...textToolsAdapter, repositories: new InMemoryRepositories() });

// Cover letter on a pasted vacancy:
const ideaLetter = buildCoverLetterIdea({
  vacancy: {
    title: 'Senior Frontend Engineer',
    description: 'React, TypeScript, 5+ years',
    url: 'https://hh.ru/vacancy/42',
    platform: 'hh.ru',
  },
  resume: {
    title: 'Frontend Engineer',
    content: '7 years React, TypeScript, GraphQL...',
  },
});
const sol = await reactor.execute(ideaLetter);
console.log(sol.output.letter);
```

The same pattern works for `buildScoreIdea` (returns `{ score, reasoning, skillMatch }`) and `buildQuestionsIdea` (returns `{ qaPairs }`).

## Testing

The package exports a `test-utils` subpath for consumers:

```ts
import {
  createMockLLMProvider,
  runLLMProviderContractTests,
} from '@reactor/text-tools/test-utils';
import { describe } from 'vitest';

// Mock LLM for unit tests:
const llm = createMockLLMProvider({
  onComplete: async () => ({ content: 'mocked', model: 'mock' }),
});

// Conformance suite for any LLMProvider implementation:
runLLMProviderContractTests(describe, () => myLLMProviderFactory());
```

## Acceptance criteria

- All Activities accept `vacancy: { title, description, url?, platform? }` (no `vacancyId` anywhere).
- Each Activity uses `composeActivity({ llmFallback })` so future crystallization (`preCheck`, `postValidate`) is one-line addition.
- `LLMProvider` reaches Activities via `ctx.llm` (requires `@kolosochek/reactor-core` >= 0.2.0).
- Idea immutability preserved (frozen Ideas execute without throwing).
- 80 tests passing (run via `vitest`).

## Out of scope (post-4.1)

- Real `LLMProvider` implementation tied to a specific provider (use `createOpenRouter` from reactor-core for OpenRouter; consumers wire their own).
- Crystallization (Phase 1 `preCheck` for any tool - to be addressed once experience data accumulates).
- Streaming output.
- Multi-message conversational LLM flows (single-turn only at 0.1.0).

## Source

- Spec: `docs/superpowers/specs/2026-04-26-text-tools-decouple-design.md`
- Plan: `docs/superpowers/plans/2026-04-26-text-tools-genesis.md`
