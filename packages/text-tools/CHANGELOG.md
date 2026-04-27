# Changelog

All notable changes to `@reactor/text-tools`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 - text-tools genesis (sub-project 4.1)

### Added

- Initial public surface for `@reactor/text-tools`.
- Three Activities: `generateCoverLetterActivity`, `scoreVacancyActivity`, `answerQuestionsActivity`. Each composed via `composeActivity({ llmFallback })` so future crystallization is a one-line addition.
- Three Tool definitions with Zod input + Solution schemas: `CoverLetterTool`, `ScoreTool`, `QuestionsTool`.
- Three Idea builders for direct-mode invocation: `buildCoverLetterIdea`, `buildScoreIdea`, `buildQuestionsIdea`. Each builder validates input via Zod and constructs an `Idea` with `MetaMessage` + `DataMessage._call`.
- `textToolsAdapter` Adapter object bundling tools + activities + `textToolsDomain`.
- Default prompts (en + ru) for all three tools, ported from existing extension and hh.ru server prompts.
- `composeActivity` factory - crystallization seam for future deterministic preCheck and postValidate layers.
- `TextToolsError` typed hierarchy: `IdeaSchemaError`, `IdeaContextMissingError`, `LLMTimeoutError`, `LLMQuotaError`, `LLMNetworkError`, `LLMOutputParseError`, `ActivityCancelledError`.
- `createMockLLMProvider` for unit tests; exported from `@reactor/text-tools/test-utils`.
- `runLLMProviderContractTests` - vitest-compatible conformance suite that any LLMProvider implementation can run against itself.

### Requirements

- `@kolosochek/reactor-core` >= 0.2.0 (which extends `ActivityContext` with `llm: LLMProvider` and adds opts param to `Reactor.execute`).
