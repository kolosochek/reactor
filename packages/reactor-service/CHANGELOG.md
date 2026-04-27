# Changelog

All notable changes to `@reactor/service`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 - reactor service genesis (sub-project 4.0)

### Added

- HTTP microservice (Fastify 5) hosting one Reactor instance per request.
- `POST /reactor/execute` - executes an Idea triplet with consumer-provided LLM provider config; persists ExperienceRecord; returns Solution.
- `GET /reactor/experience` - lists ExperienceRecords with filters (`toolName`, `outcome`, `since`, `limit`).
- `GET /reactor/health` - liveness check.
- 5 Postgres-backed SPI repositories (experience, lessons, ideas, predictions, tools) via Drizzle ORM + postgres-js, schema aligned 1:1 with `@kolosochek/reactor-core 0.2.0`.
- Drizzle Kit migrations (`drizzle/migrations/0000_*.sql`).
- `buildLLMProvider` factory (openrouter only in 0.1.0; `ProviderNotImplementedError` for the rest).
- Per-request Reactor instance: each `/reactor/execute` builds a fresh `Reactor.create({ llm }).use(textToolsAdapter)` with the request-specific LLM and the long-lived shared repositories.
- Zod-validated env config loader (`REACTOR_HTTP_HOST` / `REACTOR_HTTP_PORT`, `REACTOR_LOG_LEVEL`, `REACTOR_DATABASE_URL`).
- `TextToolsError` -> HTTP status mapping (errorMapper) covering `IdeaSchemaError` / `IdeaContextMissingError` / `LLMTimeoutError` / `LLMQuotaError` (with `retryAfterMs`) / `LLMNetworkError` / `LLMOutputParseError` / `ActivityCancelledError`.
- Permissive CORS (`origin: '*'`) for v0.1.0 localhost-only deployment.
- Graceful shutdown on SIGINT / SIGTERM in `start.ts`.
- testcontainers-node integration tests for repositories and routes.

### Requirements

- `@kolosochek/reactor-core` >= 0.2.0
- `@reactor/text-tools` >= 0.1.0
- Docker (for Postgres container)
- Node 20+
