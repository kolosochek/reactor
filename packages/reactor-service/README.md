# @reactor/service

HTTP microservice that hosts the Reactor instance and persists Idea / Experience / Lessons / Predictions / Tools to PostgreSQL via Drizzle. Consumers (Chrome extension, hh.ru CLI, future integrations) call `POST /reactor/execute` with an Idea triplet plus their own LLM provider config; the service constructs a request-scoped Reactor with those credentials, runs the Activity, persists the ExperienceRecord, and returns the Solution.

## Status

`v0.1.0` - reactor service genesis (sub-project 4.0).

## Quick start

```bash
# 1. Postgres via docker-compose
npm run db:up

# 2. Configure .env (copy from .env.example at repo root)
cp .env.example .env

# 3. Apply migrations
npm run db:migrate

# 4. Start service
npm run service:start
```

Service listens on `http://localhost:3030` by default (configurable via `REACTOR_HTTP_HOST` / `REACTOR_HTTP_PORT`).

## Endpoints (v0.1.0)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/reactor/execute` | Execute an Idea triplet; persist ExperienceRecord; return Solution |
| `GET` | `/reactor/experience` | List ExperienceRecords (filters: `toolName`, `outcome`, `since`, `limit`) |
| `GET` | `/reactor/health` | Liveness probe |

## Provider support (v0.1.0)

- `openrouter` only. Other provider names throw `ProviderNotImplementedError`. Adding `cerebras`, `groq`, `deepseek`, `openai`, `xai` is a follow-up task once `@kolosochek/reactor-core` ships them.

## Tests

```bash
npm test
```

Runs vitest. Integration tests use `testcontainers-node` to spin up isolated Postgres per suite. Total 48 tests; first run ~30-60 seconds (container startup).

## Architecture pointers

- Schema is 1:1 with `@kolosochek/reactor-core 0.2.0` SPI shapes; service-side extensions live in a `metadata` jsonb column on every table (Decision #10 in the spec).
- Per-request Reactor: `buildReactor(llm, repos)` constructs a fresh instance for each `/reactor/execute` call so the per-request `LLMProvider` doesn't pollute long-lived state (Decision #8).
- jsonb writes wrap values via `` sql`${value}` `` to bypass a drizzle-orm 0.30 + postgres-js double-encoding bug; otherwise jsonb path filters silently break.

## Spec / plan

- Spec: `docs/specs/2026-04-26-reactor-service-design.md`
- Plan: `docs/plans/2026-04-26-reactor-service-genesis.md`
