# Reactor

> An ecosystem of **Idea-Transformer microservices** built around the **Idea-Triplet protocol** `{Schema, Context, Solution}`.

A consumer constructs an **Idea** (a typed, immutable triplet) and dispatches it to a Reactor instance. The Reactor selects an **Activity** (an Idea-Transformer) by domain + tool name, executes it (calling an LLM if the Activity is Latent), persists the **ExperienceRecord** for long-term memory, and returns the same Idea with `solution` populated.

## Status

| Sub-project | State | Detail |
|---|---|---|
| **4.0** | `complete` (2026-04-27) | service genesis: Postgres-backed HTTP microservice + thin SDK; 17/17 plan tasks shipped |
| **4.1** | `inherited` | text-tools (cover-letter / score / questions) carried over from prior work |
| **4.5** | `pending` | crystallization tables wiring (composeActivity reading Lessons, gating Activity execution) |

Prior planned sub-projects 4.2 / 4.3 / 4.4 (Chrome extension migration / hh.ru CLI migration / e2e pipeline test) were dropped from scope.

## Packages

| Package | Version | Description |
|---|---|---|
| [`@reactor/service`](./packages/reactor-service) | `0.1.0` | HTTP microservice (Fastify 5 + Drizzle ORM + PostgreSQL). Hosts Reactor + 5 SPI repositories. |
| [`@reactor/client`](./packages/reactor-client) | `0.1.0` | Thin HTTP SDK. Browser- and Node-friendly. Reconstructs typed errors. |
| [`@reactor/text-tools`](./packages/text-tools) | `0.1.0` | Service-internal Activity bundle: `generateCoverLetter`, `scoreVacancy`, `answerQuestions`. |
| `@reactor/docs` | `deferred` | Documentation site (Vike + vite-plugin-markdown). Not yet bootstrapped. |

External dependency: [`@kolosochek/reactor-core`](https://github.com/kolosochek/reactor-core) `>= 0.2.0` (sibling repo at `../ereal/reactor-core` via `file:` link in this monorepo).

## Concept

The Reactor accepts an immutable `Idea = { schema, context, solution }`, executes a domain Activity (or runs latent LLM interpretation), persists an `ExperienceRecord`, and returns a new `Idea` with the populated `solution`.

Three execution modes:
- **batch**: walks `PlanMessage.calls` in array order with `†state.X` ref resolution.
- **direct**: runs a single registered Activity for a `DataMessage._call._tool`.
- **scenario**: asks the LLM to pick one Tool and run it (Latent Execution by default).

Built-in invariants (subset of pokeroid's 9): Idea is immutable on the wire (#1), fragments are self-sufficient (#2), every execution emits an ExperienceRecord (#4), Idea-Triplet is the unit of communication (#6).

## Architecture

```mermaid
flowchart LR
    Consumer["Consumer<br/>(extension / CLI / future apps)"]
    Client["@reactor/client<br/>ReactorClient.execute(idea, opts)"]
    Service["@reactor/service<br/>POST /reactor/execute"]
    Reactor["per-request Reactor<br/>Reactor.create({llm}).use(textToolsAdapter)"]
    LLM["LLM (consumer-provided<br/>via providerConfig)"]
    PG[("PostgreSQL<br/>experience / lessons / ideas /<br/>predictions / tools")]

    Consumer -->|build Idea| Client
    Client -->|HTTP POST<br/>{idea, providerConfig}| Service
    Service -->|build| Reactor
    Reactor -->|invoke| LLM
    Reactor -->|append ExperienceRecord| PG
    Service -->|Solution| Client
    Client -->|typed result or error| Consumer
```

The service stores no API keys: each `POST /reactor/execute` carries its own `providerConfig`, and the service constructs a transient `LLMProvider` for that request only. Repositories are long-lived (pool-bound singletons); only the Reactor wrapper is per-request.

## Quick start

```bash
# 1. Install
npm install

# 2. Start PostgreSQL via docker-compose
npm run db:up                              # binds to localhost:5433

# 3. Configure environment (copy and edit if needed)
cp .env.example .env

# 4. Apply Drizzle migrations
npm run db:migrate

# 5. Start the service
npm run service:start                      # listens on http://localhost:3030
```

Health check:

```bash
curl http://localhost:3030/reactor/health
# {"ok":true}
```

End-to-end via the SDK:

```ts
import { ReactorClient, buildCoverLetterIdea } from '@reactor/client';

const client = new ReactorClient({ baseUrl: 'http://localhost:3030' });

const idea = buildCoverLetterIdea({
  vacancy: { title: 'Senior FE', description: 'React, 5+ years' },
  resume: { title: 'FE Engineer', content: '7 years React, TypeScript' },
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

## HTTP endpoints (v0.1.0)

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| `POST` | `/reactor/execute` | `{ idea, providerConfig }` | Execute Idea triplet; persist ExperienceRecord; return Solution |
| `GET` | `/reactor/experience` | `?toolName&outcome&since&limit` | List ExperienceRecords (filters per `ExperienceQuery` SPI) |
| `GET` | `/reactor/health` | (none) | Liveness probe; returns `{ ok: true }` |

Errors map to typed HTTP statuses: `IdeaSchemaError` 400, `LLMQuotaError` 429 (with `retryAfterMs`), `LLMTimeoutError` 504, `LLMNetworkError` / `LLMOutputParseError` 502, `ActivityCancelledError` 499, unknown 500. The SDK reconstructs the original `TextToolsError` subclass on the consumer side.

## Provider support

`v0.1.0` ships **openrouter only**. Other provider names (`cerebras` / `groq` / `deepseek` / `openai` / `xai`) throw `ProviderNotImplementedError` until they land in `@kolosochek/reactor-core`.

## Repository layout

```
reactor/
├── README.md                              this file
├── EVOLUTION.md                           known future architectural shifts (deferred decisions)
├── docker-compose.yml                     reactor-postgres on :5433
├── .env.example                           Zod-validated env template
├── package.json                           workspace root + root scripts
├── docs/
│   ├── specs/                             architecture documents
│   │   ├── 2026-04-26-reactor-service-design.md
│   │   └── 2026-04-26-text-tools-decouple-design.md
│   └── plans/                             TDD implementation plans
│       ├── 2026-04-26-reactor-service-genesis.md
│       └── 2026-04-26-text-tools-genesis.md
└── packages/
    ├── reactor-service/
    │   ├── README.md
    │   ├── CHANGELOG.md
    │   ├── drizzle.config.ts
    │   ├── drizzle/migrations/0000_*.sql
    │   └── src/
    │       ├── start.ts                   production entry (`npm run service:start`)
    │       ├── server.ts                  buildServer (Fastify factory)
    │       ├── config.ts                  Zod env loader
    │       ├── db/
    │       │   ├── schema.ts              5 SPI-aligned tables
    │       │   ├── client.ts              Drizzle client factory
    │       │   └── repositories/          5 PostgresXxxRepository + factory
    │       ├── reactor/
    │       │   ├── llmFromConfig.ts       buildLLMProvider
    │       │   └── buildReactor.ts        per-request Reactor factory
    │       ├── routes/
    │       │   ├── execute.ts             POST /reactor/execute
    │       │   ├── experience.ts          GET /reactor/experience
    │       │   ├── health.ts              GET /reactor/health
    │       │   └── errorMapper.ts         TextToolsError -> HTTP
    │       └── __tests__/                 11 test files (8 unit + 3 testcontainer integration)
    ├── reactor-client/
    │   ├── README.md
    │   ├── CHANGELOG.md
    │   └── src/
    │       ├── ReactorClient.ts           fetch-based HTTP client
    │       ├── errors.ts                  ReactorClientError + re-exports
    │       └── __tests__/                 3 test files (10 tests via vi.fn() fetchImpl)
    └── text-tools/
        └── src/                           Activity + Tool definitions (cover-letter / score / questions)
```

## Design decisions

10 architectural decisions are recorded in `docs/specs/2026-04-26-reactor-service-design.md`. Key ones:

| # | Decision | Why it matters |
|---|---|---|
| 1 | Reactor is a **microservice**, not an embedded library | Single canonical persistence; consumers are thin clients |
| 2 | PostgreSQL via Docker | Aligned with pokeroid storage pattern; Drizzle ORM + postgres-js |
| 3 | Per-request `providerConfig` | Service stores no API keys; consumer brings own LLM credentials |
| 6 | Strict Idea-Triplet preserved across HTTP | No partial-state shortcuts on the wire |
| 7 | No partial outcomes | Service either persists complete ExperienceRecord or throws typed error |
| 8 | Fresh `Reactor.create({ llm })` per request | Zero breaking change to `@kolosochek/reactor-core 0.2.0` |
| 9 | Crystallization tables deferred to 4.5 | v0.1.0 ships the storage substrate, not the composition logic |
| 10 | Schema is **1:1 with reactor-core 0.2.0 SPI**; extensions in `metadata` jsonb | Future indexed queries via `metadata->>'key'` without schema migration |

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript 5.4 (strict, `noUncheckedIndexedAccess`) |
| HTTP | Fastify 5 + `@fastify/cors` |
| Database | PostgreSQL 16 (Docker) |
| ORM | Drizzle ORM 0.30 + Drizzle Kit + `postgres-js` |
| Validation | Zod 3 |
| Tests | Vitest 1 + `testcontainers-node` (isolated Postgres per suite) |
| Runtime | Node 20+, ESM, `tsx` for `start.ts` |
| Logger | Pino (Fastify default) |
| Module system | npm workspaces |

## Tests

138/138 tests pass across the monorepo at sub-project 4.0 closure.

| Workspace | Test files | Tests | Notes |
|---|---|---|---|
| `@reactor/service` | 11 | 48 | 27 unit + 21 testcontainer integration |
| `@reactor/client` | 3 | 10 | All unit; `vi.fn()` fetchImpl injection |
| `@reactor/text-tools` | 15 | 80 | All unit |
| **Total** | **29** | **138** | tsc clean across all three packages |

```bash
npm test                                   # all workspaces
npm test -w @reactor/service               # service only
npm test -w @reactor/client                # client only
```

Integration tests use isolated `postgres:16-alpine` containers via `testcontainers-node`. First run takes 30-60 seconds for image pull + container startup; subsequent runs reuse the image.

## Known issue: drizzle-orm 0.30 + postgres-js jsonb double-encoding

When using bare-object `.values({ jsonb_col: object })` writes, drizzle calls `JSON.stringify` and postgres-js applies its own jsonb serializer, double-encoding the result as a jsonb scalar string. This breaks `metadata->>'key'` path filters silently.

**Workaround applied throughout the service**: every jsonb insert/update wraps the value with `` sql`${value}` ``, which routes through postgres-js's tagged-template path and produces a proper jsonb object.

```ts
import { sql } from 'drizzle-orm';

await db.insert(experience).values({
  ...,
  input: sql`${rec.input}`,
  output: sql`${rec.output}`,
  metadata: rec.metadata != null ? sql`${rec.metadata}` : null,
});
```

To revisit when drizzle-orm is upgraded to a version that ships a fixed postgres-js adapter.

## Development

Per-workspace commands:

```bash
# typecheck only (no emit)
npm run typecheck -w @reactor/service
npm run typecheck -w @reactor/client
npm run typecheck -w @reactor/text-tools

# build (emits dist/)
npm run build -w @reactor/service
npm run build -w @reactor/client
npm run build -w @reactor/text-tools

# vitest watch mode
npm run test:watch -w @reactor/service
```

Root-level shortcuts:

```bash
npm run db:up                              docker compose up -d reactor-postgres
npm run db:down                            docker compose down reactor-postgres
npm run db:generate                        drizzle-kit generate (after schema.ts edits)
npm run db:migrate                         apply migrations to running Postgres
npm run service:start                      tsx packages/reactor-service/src/start.ts
```

## Future work

- **Sub-project 4.5**: crystallization tables wiring. Adds `lesson_compositions`, `prediction_for_idea`, `crystallization_runs`, etc., and wires the `composeActivity` seam in text-tools so Lessons read from PG can gate or augment Activity execution.
- **`@reactor/docs`** scaffold: documentation site mirroring the pokeroid Vite + vite-plugin-markdown stack. Spec in `docs/specs/`. Triggers when documentation surface is non-trivial.

Anticipated architectural shifts not yet active are captured in [`EVOLUTION.md`](./EVOLUTION.md), each with an explicit triggering event.

## Genesis

This repository was extracted from the `hhru` job-search-tracker monorepo on 2026-04-27. The pre-extraction history is folded into the `Initial commit`. All subsequent commits are sub-project 4.0 chunk work.

## Documents

- [`docs/specs/2026-04-26-reactor-service-design.md`](./docs/specs/2026-04-26-reactor-service-design.md): service architecture, 9 invariants, Acts of Emergence mapping, decisions log
- [`docs/plans/2026-04-26-reactor-service-genesis.md`](./docs/plans/2026-04-26-reactor-service-genesis.md): the 17-task TDD plan that built sub-project 4.0
- [`EVOLUTION.md`](./EVOLUTION.md): known future architectural shifts (deferred decisions, with triggering events)

## License

MIT.
