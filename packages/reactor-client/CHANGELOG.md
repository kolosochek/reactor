# Changelog

All notable changes to `@reactor/client`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 - reactor client genesis (sub-project 4.0)

### Added

- `ReactorClient` class - HTTP client over `@reactor/service`. Pure fetch-based; browser- and Node-friendly. Constructor normalizes `baseUrl` (trailing slash stripped) and accepts an injectable `fetchImpl` for testing.
- `execute(idea, opts)` method - POSTs to `/reactor/execute`; returns `Solution`; reconstructs typed `TextToolsError` from the service error response. Forwards an optional `AbortSignal` to `fetch`.
- `ReactorClientError` - parent for HTTP-level issues (network, malformed JSON, unknown error class on the wire).
- Re-exports `buildCoverLetterIdea` / `buildScoreIdea` / `buildQuestionsIdea` plus their input/solution Zod shapes from `@reactor/text-tools` so consumers get the whole surface from a single import path.
- Re-exports the full `TextToolsError` hierarchy (`IdeaSchemaError`, `IdeaContextMissingError`, `LLMTimeoutError`, `LLMQuotaError`, `LLMNetworkError`, `LLMOutputParseError`, `ActivityCancelledError`) for typed `instanceof` checks.
- Type-only dep on `@kolosochek/reactor-core` (`Idea` / `Solution` shapes); zero runtime cost.

### Requirements

- `@reactor/text-tools` >= 0.1.0
- Type-only `@kolosochek/reactor-core` >= 0.2.0
