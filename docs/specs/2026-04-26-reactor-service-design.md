# Reactor as Microservice: PostgreSQL-backed Idea-Transformer Service

> Spec author: brainstorming session 2026-04-26 (revised after Reactor-as-service pivot).
> Status: design accepted; awaits user spec review before plan writing.
> **Supersedes**: `docs/superpowers/specs/2026-04-26-text-tools-decouple-design.md` (which modeled Reactor as embedded library; pokeroid REACTOR.md:80-86 explicitly frames it as a microservice).
> Successor docs: per-sub-project plans under `docs/superpowers/plans/2026-04-2X-*.md`.

## TL;DR

The Reactor is a **microservice**, not a library that consumers embed. Per pokeroid's documented vision (`runtime/REACTOR.md:80-86`):

> The Reactor is **the first of many such "Idea-Transformer" microservices**. The same protocol will support a composable ecosystem of services...

Consumers (Chrome extension, hh.ru CLI/server, future pokeroid, future ereal) are **thin clients**. They build Idea triplets locally and dispatch them to a Reactor service via HTTP. The service:
- Hosts `Reactor.create({ llm }).use(textToolsAdapter, hhruAdapter)` in-process
- Persists the 5 SPI repositories (`experience` / `lessons` / `ideas` / `predictions` / `tools`) to **PostgreSQL via Docker**
- Returns Solution back to the consumer

This is a fundamental architectural pivot from the previous "text-tools as library, each consumer embeds its own Reactor" model. Each consumer's surface area shrinks dramatically (from `peer dep + LLM wiring + repository impl` down to `HTTP fetch + builder import`). All long-term memory, lessons, predictions, crystallization happen in **one place** (the service), aligned with pokeroid's "stateful agents with long-term memory" vision (`runtime/REACTOR.md:53-57`).

The work decomposes into four sub-projects:
- **4.0** Reactor service genesis (NEW; foundation, blocks the rest)
- **4.2** Extension as thin client
- **4.3** hh.ru CLI/server as thin client
- **4.4** End-to-end pipeline test against running service

## Goals

1. **Reactor lives once.** Single canonical instance, single canonical persistence (PostgreSQL). Consumers never duplicate Reactor logic.
2. **Thin clients.** Extension, CLI, and future consumers do not depend on `@kolosochek/reactor-core` at runtime. They construct Idea triplets locally and dispatch via HTTP.
3. **Long-term memory in one place.** All ExperienceRecords, Lessons, Predictions accumulate in the service's PostgreSQL. Crystallization (when it lands) reads one source of truth.
4. **Pokeroid-aligned storage.** PostgreSQL via Docker mirrors `pokeroid/storage/README.md` pattern; future Temporal integration possible.
5. **Per-request provider config.** Consumers pass their own LLM provider config (provider name + model + API key) per request, matching pokeroid `agent/src/Provider/index.ts:13-21` "config from minimal input".

## Non-goals (Out of scope)

- **Multi-tenancy / auth.** v0.1.0 service trusts every caller; assumes localhost or trusted network. Auth is post-MVP.
- **Service-managed master API keys.** v0.1.0 requires consumers to pass their own LLM provider credentials. Service does not store keys.
- **Temporal workflow integration.** Pokeroid uses Temporal for long-running poker workflows; we adopt PostgreSQL only for now. Temporal is a separate future sub-project.
- **Replacing hh.ru's existing SQLite.** hh.ru-server keeps its own DB for hh.ru-specific data (vacancies, applications, presets). Reactor service owns its own PostgreSQL for Idea/Experience/Lessons/Predictions/Tools.
- **Implementing crystallization.** Reactor service ships with the storage that crystallization will read (forward-looking), but the F1 factories (LessonsIntegration, PredictionGenerator, CrystallizationEngine) remain not-wired-into-execute as in 4.1.
- **Public/cloud deployment.** Service runs on user's machine via Docker Compose. Hosted/cloud deployment is post-MVP.

## What's preserved from sub-project 4.1

The 4.1 work (`@dkolosovsky/reactor-text-tools 0.1.0` + `@kolosochek/reactor-core 0.2.0`) **stays valuable**. It moves location of use:

| Artifact | Old role (per superseded spec) | New role |
|---|---|---|
| `@kolosochek/reactor-core 0.2.0` | Peer dep for every consumer | **Internal dep of `@dkolosovsky/reactor-service`** |
| `@dkolosovsky/reactor-text-tools 0.1.0` (Activities, schemas, builders, prompts, errors) | Library each consumer imports | **Internal dep of `@dkolosovsky/reactor-service`** for activities + adapter; **builders re-exported via `@dkolosovsky/reactor-client`** for type-safe Idea construction |
| `composeActivity` crystallization seam | Per-consumer | Service-internal (consumers never compose activities) |
| `createMockLLMProvider`, `runLLMProviderContractTests` | Consumed by extension/adapter migration tests | Consumed by service tests; also exposed via `@dkolosovsky/reactor-client/test-utils` for consumer integration tests |

Net: 4.1's surface stays; users of that surface relocate from "every consumer" to "the one service".

---

## Architecture

```mermaid
graph TB
  subgraph host["User's machine (or server)"]
    subgraph dock["Docker Compose"]
      PG["postgres:16-alpine<br/>port via REACTOR_DB_PORT env<br/>volume reactor-pg-data"]
    end
    subgraph node["Node.js process: @dkolosovsky/reactor-service"]
      API["HTTP server<br/>fastify or express<br/>port via REACTOR_HTTP_PORT env"]
      RC["Reactor instance<br/>+ textToolsAdapter<br/>+ hhruAdapter (after 4.3)"]
      DZ["Drizzle ORM (postgres-js)"]
      MIG["Drizzle Kit migrations"]
    end
    API --> RC
    RC --> DZ
    DZ -->|REACTOR_DATABASE_URL| PG
    MIG -->|"drizzle-kit migrate"| PG
  end

  subgraph clients["Consumers (thin clients)"]
    EXT["Extension popup"]
    HHCLI["hh.ru CLI scripts"]
    POK["pokeroid (future)"]
    EREAL["ereal (future)"]
  end

  subgraph clientpkg["@dkolosovsky/reactor-client (NEW thin SDK)"]
    BLD["Builders (re-export from text-tools)"]
    HTTP["fetch HTTP client class"]
  end

  EXT --> clientpkg
  HHCLI --> clientpkg
  POK --> clientpkg
  EREAL --> clientpkg
  clientpkg -->|"POST /reactor/execute<br/>{ idea, providerConfig }"| API
  API -->|"Solution JSON"| clientpkg
```

### Data flow per request

```
1. Consumer (extension popup, CLI script, etc.) gathers inputs.
2. Consumer imports buildXxxIdea from @dkolosovsky/reactor-client.
3. Consumer calls buildXxxIdea(input) → Idea triplet (validated locally via Zod).
4. Consumer calls reactorClient.execute(idea, providerConfig)
   → POST http://localhost:<PORT>/reactor/execute
      body: { idea, providerConfig: { provider, model, apiKey } }
5. Service receives request:
   a. Validates idea + providerConfig schemas.
   b. Constructs LLMProvider from providerConfig (transient, request-scoped).
   c. Reactor.execute(idea, { signal: req-scoped }) runs activity.
   d. Activity calls ctx.llm.complete(...) → providerConfig handler.
   e. Reactor appends ExperienceRecord to repositories.experience (PostgreSQL).
   f. Returns Solution.
6. Service responds 200 with Solution JSON.
7. Consumer renders Solution.
```

### Pokeroid alignment

| Pokeroid principle | Realized via |
|---|---|
| **REACTOR.md:80-86** "Reactor is the first of many Idea-Transformer microservices" | The service IS this Reactor microservice. |
| **REACTOR.md:53-57** "Stateful agents with long-term memory" | All 5 repos persisted in PostgreSQL. Memory survives service restarts, consumer reboots, browser closes. |
| **Decision 010** "No Hidden State, Everything explicit" | Single source of truth (one PostgreSQL DB). No duplicate stores per consumer. Idea triplet carries full state at API boundary. |
| **agent/src/Provider/index.ts** "Provider config from minimal input per Request" | Consumer passes providerConfig per request; service builds transient LLMProvider. |
| **storage/README.md** "PostgreSQL container with init scripts" | Our Docker Compose mirrors this pattern (PostgreSQL container, volume, healthcheck). |
| **Acts/016 Agent/Meta** "tracks versioning, branching, and origin" | Each ExperienceRecord persists `idea_meta` jsonb column with full lineage (`domain`, `path`, `version`, `parentRef`). |

---

## Pokeroid Vision Alignment (canonical traceability)

This section anchors every architectural decision below to the canonical Pokeroid documents. When a future reader asks "why does the service look this way?", the answer must trace to a cited line here.

### IDEA Triplet (the unit of communication)

Per `pokeroid/runtime/REACTOR.md:13-21` and `runtime/VISION.ru.md:11-17`:

> Каждое сообщение в системе будет представлять собой самодостаточный триплет: Schema (universal semantic definition), Context (rules, instructions, history), Solution (actual state conforming to schema). [...] Triplet будет единственной единицей данных, передаваемой по критическому пути всех рабочих процессов; мы отходим от передачи частичных состояний.

**Realized:** `Idea = { schema, context, solution }` is the sole payload of `POST /reactor/execute` (request body) and the sole shape of `Solution` (response). HTTP boundary preserves the triplet end-to-end. No partial-state shortcuts on either side.

### 9 Invariants (`runtime/ARCHITECTURE.md:16-27`)

| # | Pokeroid invariant | Hhru reactor-service realization |
|---|---|---|
| 1 | **Schema immutability** - no entity may modify Schema in the triplet | `executeIdea(idea)` returns a new Idea; Schema is passed through verbatim. Drizzle column `idea_schema` is a JSON snapshot, never updated in place. |
| 2 | **Idea self-sufficiency** - Idea carries everything needed at every pipeline stage | Service does not consult any out-of-band state. Builders construct full triplets from inputs; service only enriches Solution. |
| 3 | **Transparent context** - all Context is visible to LLM; no hidden state, only data relevant to computation | Adapters' `domain` + Activities' `parameters` are the only inputs to LLM. No env-derived branching at activity boundary. |
| 4 | **Schema conformance** - Solution validates against Schema; state of any Idea is fundamentally defined and validated by its schema | Zod schemas at builders + at `POST /reactor/execute` body validation; Activity output validated against tool's output schema (already in `text-tools` 0.1.0). |
| 5 | **State completeness via personalization** - per-player views compose to full game state | ⛔ **N/A for hhru.** Single-user job-search context; no multi-player composition. Surfaces only when service ever serves multi-tenant flows. |
| 6 | **Idea immutability** - workflows do not mutate input Idea; they create a new Idea (immutable Schema, new Context = processed + prior Solution, new Solution) | `Reactor.execute(idea)` returns a fresh Idea; ExperienceRecord stores both input and output snapshots. |
| 7 | **Session as return point** - Session is the pipeline endpoint that returns result to client | ⚠️ **Adapted.** In stateless HTTP model, the request itself plays Session's role: enter → execute → return Solution → done. No persistent Session workflow in v0.1.0 (would need Temporal). |
| 8 | **Hero autonomy** - Hero is sole source of truth for session state | ⛔ **N/A.** No persistent agent identity in v0.1.0. Forward-looking: when crystallization (4.5) introduces feedback loops, a "Hero" analog (per-consumer agent context) may emerge. |
| 9 | **Decentralized state** - no single place all pipeline parts query for current state | ⚠️ **Partially.** PostgreSQL is single store, but each request is stateless and self-sufficient (carries its full Idea). Inter-request state is in PG (long-term memory), not in-flight orchestration. |

**Net:** invariants 1-4 + 6 hold strictly. 5/7/8 are pokeroid-specific orchestration concepts (multi-player turn-based games) that don't apply to single-user single-shot text transforms. 9 holds in spirit (no in-flight shared cache).

### Acts of Emergence mapping (`pokeroid/agent/README.md`)

| Act | Hhru realization |
|---|---|
| **001 Request** - atomic LLM transaction | `Activity` invocation that runs ONE `ctx.llm.complete(...)` call (e.g. `scoreVacancyActivity`). |
| **002 Tool** - schema definition of capability | `text-tools` Tool definitions (`scoreVacancyTool`, `generateCoverLetterTool`, `answerQuestionsTool`) + `hhruAdapter` Tools (after 4.3). |
| **003 Activity** - deterministic code impl of Tool (Dual Registry) | `composeActivity(...)` registry in `@dkolosovsky/reactor-text-tools`; service registers via `Reactor.use(adapter)`. |
| **004 Call** - parameterized request for execution | `DataMessage._call` shape (`{ _tool, ...params }`). |
| **005 Data** | `DataMessage` envelope with `_call` discriminator. |
| **006 Input** | `InputMessage` triggers scenario mode (LLM picks tool). |
| **009 State** | `StateMessage` carries scratchpad in batch mode (`†state.X` refs). |
| **010 Loop** | Out of scope for v0.1.0 (single-shot service); enters when multi-step Plans land. |
| **012 Plan** | `PlanMessage` triggers batch mode in reactor-core (already supported). |
| **016 Meta** | `idea_meta` jsonb column persists `{ domain, path, version, parentRef }`. |
| **104 Latent Execution** ("no-code default") | Preserved via `composeActivity` seam: when crystallization (4.5) lands, Lessons can wrap any Activity to enrich/replace; if no Activity registered for a Tool, Reactor falls back to LLM-as-interpreter. |

### Latent ↔ Explicit crystallization (REACTOR.md:23-51)

> Эта стратегия кристаллизации от латентной к явной логике открывает революционный подход к разработке. [...] Симуляция предшествует коду и информирует его.

**Realized as forward-looking seam:** `composeActivity` in `@dkolosovsky/reactor-text-tools` 0.1.0 is the precise hook where Lessons (PG-persisted insights) and Predictions (PG-persisted forecasts) will compose with raw Activity execution. v0.1.0 ships the storage; sub-project **4.5** wires the composition. Until then, all execution runs the Explicit (engine) path. No crystallization tables added in 4.0 schema (tracked under Open Question #2 of pre-T3 alignment, deferred to 4.5).

### Per-request LLM contract (resolved Open Question #2)

**Decision (2026-04-27):** **Fresh `Reactor.create({ llm })` per request.** Each `POST /reactor/execute`:
1. Validates `providerConfig` (Zod).
2. Builds transient `LLMProvider = buildLLMProvider(providerConfig)`.
3. Constructs `reactor = Reactor.create({ llm }).use({ ...adapter, repositories: postgresRepos })`.
4. Calls `reactor.execute(idea)` and returns the Solution.

**Rationale:**
- **Zero changes to `@kolosochek/reactor-core` 0.2.0** - we don't touch published API; no breaking change to other consumers.
- **Stateless transaction model** - matches Pokeroid's "Reactor as black box for triplet transformation" (`runtime/ARCHITECTURE.md:14`).
- **Cost is negligible** - `Reactor.create` is a thin object construction; the heavy work (LLM call + Drizzle queries) dominates per-request cost.
- **Repository injection stays consistent** - `postgresRepos` is a long-lived pool-bound singleton; only the Reactor wrapper is per-request.

**Rejected alternative:** extending `Reactor.execute(idea, opts.llmOverride?)` in core. Would require a 0.3.0 release of reactor-core, breaking existing API for a benefit (single shared Reactor) that doesn't materialize at our request rates.

---

## Component design

### 1. `@dkolosovsky/reactor-service` (NEW workspace package)

**Location**: `packages/reactor-service/` in this repo (npm workspace). Standalone since 2026-04-27.

**Responsibilities**:
- Boot HTTP server on `REACTOR_HTTP_PORT` (default 3030).
- Connect to PostgreSQL via `REACTOR_DATABASE_URL`.
- Expose REST endpoints (see API surface below).
- Host one `Reactor` instance with `textToolsAdapter` registered (and `hhruAdapter` after 4.3).
- Persist 5 repositories via Drizzle/Postgres `RepositoriesProvider` impl.
- Run Drizzle Kit migrations on start (idempotent).

**Tech choices**:
- HTTP framework: `fastify` (fast, schema-aware, TypeScript-friendly).
- Drizzle dialect: `postgres-js` driver (lightweight, async, no native bindings).
- Migrations: Drizzle Kit (`drizzle-kit generate` + `drizzle-kit migrate`).
- Runtime config: `dotenv` + `zod` validation of env shape.

### 2. `@dkolosovsky/reactor-client` (NEW workspace package)

**Location**: `packages/reactor-client/` in this repo.

**Responsibilities**:
- Re-export builders from `@dkolosovsky/reactor-text-tools` (`buildCoverLetterIdea`, etc.) so consumers get type-safe Idea construction.
- Provide `ReactorClient` class with methods: `execute(idea, providerConfig, opts?)`, `experience.list(query)`, `lessons.list(query)`, etc.
- Pure HTTP - `fetch` based. Zero native deps. Browser-friendly (Chrome MV3 service workers, popups). Node-friendly (CLI scripts).

**Public surface**:
```ts
import { buildCoverLetterIdea, buildScoreIdea, buildQuestionsIdea, ReactorClient } from '@dkolosovsky/reactor-client';

const client = new ReactorClient({ baseUrl: 'http://localhost:3030' });

const idea = buildCoverLetterIdea({ vacancy, resume, prompt });
const solution = await client.execute(idea, {
  providerConfig: { provider: 'cerebras', model: 'llama-...', apiKey: '...' },
  signal: controller.signal,
});
```

**Type-only deps** on `@kolosochek/reactor-core` for `Idea`/`Solution`/`Message` types (zero runtime cost — type-only imports tree-shaken). No `Reactor` class import; no `LLMProvider` runtime import.

### 3. Updated workspace topology

```
/Users/noone/data/
├── ereal/
│   └── reactor-core/                       @kolosochek/reactor-core 0.2.0 (unchanged from 4.1)
│
└── hhru/                                   npm workspace root
    ├── docker-compose.yml                  NEW: postgres service
    ├── .env.example                        NEW: env vars contract
    ├── packages/
    │   ├── text-tools/                     @dkolosovsky/reactor-text-tools 0.1.0 (4.1, unchanged; service-internal)
    │   ├── reactor-adapter/                @hhru/reactor-adapter 0.2.0 (Phase C; service-internal after 4.3)
    │   ├── reactor-service/                NEW: HTTP server + Drizzle/Postgres
    │   │   ├── src/
    │   │   │   ├── server.ts               fastify server bootstrap
    │   │   │   ├── routes/
    │   │   │   │   ├── execute.ts          POST /reactor/execute
    │   │   │   │   └── repositories.ts     GET /reactor/{experience,lessons,...}
    │   │   │   ├── reactor/
    │   │   │   │   ├── instance.ts         Reactor.create + use(adapters)
    │   │   │   │   └── llmFromConfig.ts    builds transient LLMProvider per request
    │   │   │   ├── db/
    │   │   │   │   ├── schema.ts           Drizzle schema (5 tables)
    │   │   │   │   ├── client.ts           drizzle(postgres(...))
    │   │   │   │   └── repositories/       PostgresExperienceRepository, etc.
    │   │   │   ├── config.ts               env var loading + Zod validation
    │   │   │   └── index.ts                main entry (used by `npm run reactor:start`)
    │   │   ├── drizzle/
    │   │   │   └── migrations/             generated SQL migrations
    │   │   ├── drizzle.config.ts           Drizzle Kit config
    │   │   ├── package.json                deps: reactor-core, text-tools, drizzle, postgres-js, fastify
    │   │   └── ...
    │   └── reactor-client/                 NEW: thin SDK
    │       ├── src/
    │       │   ├── ReactorClient.ts        HTTP client class
    │       │   ├── index.ts                re-exports + builders
    │       │   └── test-utils/             re-export from text-tools/test-utils
    │       └── package.json                deps: text-tools (for builders); type-only on reactor-core
    └── extension/                          Chrome extension (4.2 will integrate)
        └── package.json                    NEW dep: @dkolosovsky/reactor-client (workspace link)
```

---

## Service API surface

All endpoints under `/reactor` prefix. JSON in / JSON out. No auth in v0.1.0.

### `POST /reactor/execute`

Execute a single Idea.

**Request**:
```json
{
  "idea": { "schema": ..., "context": [...], "solution": null },
  "providerConfig": {
    "provider": "cerebras" | "openrouter" | "openai" | "groq" | "deepseek" | "xai",
    "model": "string",
    "apiKey": "string",
    "temperature": 0.7,
    "topP": 1.0,
    "topK": 40,
    "maxTokens": 4000
  }
}
```

**Response 200**:
```json
{
  "solution": {
    "meta": { "domain": "text-tools", "path": "/cover-letter/...", "version": "0.1.0", ... },
    "calls": [...],
    "output": { "letter": "...", "tokensUsed": 1234, "durationMs": 567 }
  }
}
```

**Response 4xx/5xx**:
```json
{
  "error": {
    "class": "LLMQuotaError" | "LLMTimeoutError" | "IdeaSchemaError" | ...,
    "message": "string",
    "retryAfterMs": 30000  // only for LLMQuotaError
  }
}
```

### `GET /reactor/experience`

List ExperienceRecords. Query params: `?domain=text-tools&toolName=generateCoverLetter&outcome=success&limit=100&since=2026-04-01`.

### `GET /reactor/lessons`, `GET /reactor/predictions`, `GET /reactor/ideas`

Symmetric. Future-facing for crystallization features.

### `POST /reactor/lessons/seed` (future)

Seed lessons for a domain. Used by adapters that ship pre-built lessons.

### `GET /reactor/health`

Liveness/readiness check. Returns `{ ok: true, db: 'connected' }`. Used by Docker healthcheck and consumers.

---

## Persistence: PostgreSQL via Docker

### `docker-compose.yml` (root of hhru repo)

```yaml
services:
  reactor-postgres:
    image: postgres:16-alpine
    container_name: reactor-postgres
    environment:
      POSTGRES_USER: ${REACTOR_DB_USER:-reactor}
      POSTGRES_PASSWORD: ${REACTOR_DB_PASSWORD:-reactor}
      POSTGRES_DB: ${REACTOR_DB_NAME:-reactor}
    volumes:
      - reactor-pg-data:/var/lib/postgresql/data
    ports:
      - "${REACTOR_DB_PORT:-5433}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${REACTOR_DB_USER:-reactor} -d ${REACTOR_DB_NAME:-reactor}"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

volumes:
  reactor-pg-data:
```

Why `5433` default and not `5432`: leaves user's potential other Postgres on `5432` undisturbed. Configurable via env.

### Drizzle schema (sketch)

`packages/reactor-service/src/db/schema.ts`:

```ts
import { pgTable, serial, text, timestamp, jsonb, integer, varchar, index } from 'drizzle-orm/pg-core';

export const experience = pgTable('experience', {
  id: serial('id').primaryKey(),
  toolName: varchar('tool_name', { length: 128 }).notNull(),
  domain: varchar('domain', { length: 128 }).notNull(),
  input: jsonb('input').notNull(),
  output: jsonb('output').notNull(),
  outcome: varchar('outcome', { length: 32 }).notNull(),  // 'success' | 'failure'
  errorMessage: text('error_message'),
  errorClass: varchar('error_class', { length: 128 }),
  durationMs: integer('duration_ms').notNull(),
  ideaMeta: jsonb('idea_meta').notNull(),  // lineage from Acts/016 Agent/Meta
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  byToolName: index('experience_tool_name_idx').on(t.toolName),
  byDomain: index('experience_domain_idx').on(t.domain),
  byOutcome: index('experience_outcome_idx').on(t.outcome),
  byCreatedAt: index('experience_created_at_idx').on(t.createdAt),
}));

export const lessons = pgTable('lessons', {
  id: serial('id').primaryKey(),
  domain: varchar('domain', { length: 128 }).notNull(),
  type: varchar('type', { length: 32 }).notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  evidence: jsonb('evidence'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  byDomain: index('lessons_domain_idx').on(t.domain),
  byType: index('lessons_type_idx').on(t.type),
}));

export const ideas = pgTable('ideas', {
  id: serial('id').primaryKey(),
  domain: varchar('domain', { length: 128 }).notNull(),
  path: varchar('path', { length: 512 }).notNull(),
  version: varchar('version', { length: 32 }).notNull(),
  parentRef: varchar('parent_ref', { length: 512 }),
  schema: jsonb('schema').notNull(),
  context: jsonb('context').notNull(),
  solution: jsonb('solution'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  byDomain: index('ideas_domain_idx').on(t.domain),
  byPath: index('ideas_path_idx').on(t.path),
  byParentRef: index('ideas_parent_ref_idx').on(t.parentRef),
}));

export const predictions = pgTable('predictions', {
  id: serial('id').primaryKey(),
  activity: varchar('activity', { length: 128 }).notNull(),
  expected: jsonb('expected').notNull(),
  actual: jsonb('actual'),
  confidence: integer('confidence'),  // 0-100
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const tools = pgTable('tools', {
  name: varchar('name', { length: 128 }).primaryKey(),
  classification: varchar('classification', { length: 32 }).notNull(),
  metrics: jsonb('metrics').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

`jsonb` for structured payloads enables future indexed queries on inner fields without schema migrations (e.g., `WHERE idea_meta->>'domain' = 'hhru'`).

---

## Configuration

`.env.example` at hhru root (committed; users copy to `.env`):

```
# Reactor Service
REACTOR_HTTP_HOST=127.0.0.1
REACTOR_HTTP_PORT=3030

# PostgreSQL (used by both docker-compose and the service)
REACTOR_DB_USER=reactor
REACTOR_DB_PASSWORD=reactor
REACTOR_DB_NAME=reactor
REACTOR_DB_PORT=5433

# Service-side derived (do not set manually unless overriding)
REACTOR_DATABASE_URL=postgres://reactor:reactor@localhost:5433/reactor

# Logging
REACTOR_LOG_LEVEL=info  # debug | info | warn | error
```

Service uses `dotenv` + Zod schema to load and validate at boot. Mismatch between `docker-compose.yml` env defaults and service `.env` values produces clear startup error.

---

## LLM provider per-request

Per pokeroid `agent/src/Provider/index.ts:13-21`, provider config is "data, built per Request". Service implementation:

```ts
// packages/reactor-service/src/reactor/llmFromConfig.ts
import { createOpenRouter } from '@kolosochek/reactor-core';  // existing reference impl
import type { LLMProvider } from '@kolosochek/reactor-core';

export interface ProviderConfig {
  provider: 'openrouter' | 'cerebras' | 'openai' | 'groq' | 'deepseek' | 'xai';
  model: string;
  apiKey: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
}

export function buildLLMProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case 'openrouter':
      return createOpenRouter({ apiKey: config.apiKey, defaultModel: config.model });
    case 'cerebras':
      return createCerebras({ apiKey: config.apiKey, defaultModel: config.model });
    // ... other providers
  }
}
```

Each `POST /reactor/execute` builds a transient LLMProvider for that request, passes it to a request-scoped Reactor (or to a shared Reactor whose execute() takes opts.llmOverride if reactor-core gains that — see Open Question #2). Provider configs are not persisted; API keys never touch the database.

---

## Migration: four sub-projects

Each gets its own brainstorm → spec → plan → execute cycle.

### 4.0 Reactor service genesis (NEW, blocks everything else)

**Goal**: `packages/reactor-service/` and `packages/reactor-client/` exist, run end-to-end with mock LLM, talk to local Postgres via Docker.

**Tasks**:
1. Bootstrap `packages/reactor-service/` workspace (package.json, tsconfig, vitest, drizzle.config).
2. Bootstrap `packages/reactor-client/` workspace.
3. `docker-compose.yml` at hhru root with reactor-postgres service.
4. `.env.example` + Zod-validated config loader.
5. Drizzle schema + initial migration.
6. PostgresExperienceRepository, PostgresLessonsRepository, etc. (5 repos against schema).
7. Reactor instance bootstrap inside service: `Reactor.create({ llm: stubLLM /* placeholder */ }).use({ ...textToolsAdapter, repositories: postgresRepos })`.
8. `buildLLMProvider(config)` factory.
9. Route handlers: POST /reactor/execute, GET /reactor/experience, GET /reactor/health.
10. `ReactorClient` HTTP client class.
11. `@dkolosovsky/reactor-client` re-exports text-tools builders.
12. Tests: testcontainers-node spins up isolated Postgres for integration tests; mock LLM for activity tests; client → service → service-side-handler full round-trip test.
13. README + CHANGELOG.

**Dependencies**: reactor-core 0.2.0 (already shipped), text-tools 0.1.0 (already shipped).

**Outcome**: `npm run reactor:start` boots service against running `docker compose up reactor-postgres`. `ReactorClient.execute(buildCoverLetterIdea(...), { providerConfig: { ... } })` returns a Solution. ExperienceRecords accumulate in Postgres.

### 4.2 Extension as thin client

**Goal**: Chrome extension consumes `@dkolosovsky/reactor-client`. `extension/src/lib/actions/{generateCoverLetter,answerQuestions}.ts` removed.

**Tasks**:
1. Add `@dkolosovsky/reactor-client` workspace dep to `extension/package.json`.
2. Each of 4 caller sites (popup × 2 + service-worker × 2): replace `await generateCoverLetter({...})` with `await reactorClient.execute(buildCoverLetterIdea({...}), { providerConfig })`.
3. Build `providerConfig` from extension's settings (active preset + apiKey).
4. Remove obsolete `extension/src/lib/actions/`. Existing prompts/llm/storage stay (storage retains HistoryEntry for now, with optional read-from-service via /reactor/experience as enhancement).
5. Tests: existing extension tests pass; mock ReactorClient in tests; `runLLMProviderContractTests` not applicable here (LLM lives in service).

**Dependencies**: 4.0 must ship first (service exists; client SDK exists).

**Outcome**: Extension is the first production thin client. Pasted-text path works; LLM call routed through service.

### 4.3 hh.ru CLI/server as thin client

**Goal**: hh.ru-server's CLI scripts (`scripts/cli/{score,letter,apply,fetch}.ts`) and server-side workers consume `@dkolosovsky/reactor-client` for LLM operations. `@hhru/reactor-adapter` is **absorbed into the service** (its activities `fetchActivity`/`applyActivity` register with the service's Reactor; CLI scripts don't run them locally).

**Tasks**:
1. Service-side: register `hhruAdapter` in service's Reactor instance (alongside `textToolsAdapter`). Now service handles ALL hh.ru pipeline activities.
2. CLI scripts replaced: `scripts/cli/score.ts` reads vacancy from hh.ru DB → calls `reactorClient.execute(buildScoreIdea(...), { providerConfig })` → writes result to hh.ru DB via existing tRPC mutation.
3. `submitScoreVacancyTask` server worker: same pattern (in-process call replaced by service HTTP call).
4. Phase C tests adapted: existing test infrastructure mocks the ReactorClient; existing flag surface (`--auto`, `--min-score`, etc.) preserved.
5. `@hhru/reactor-adapter` package retained as service-side dependency only; eventually merged into reactor-service.

**Dependencies**: 4.0 (service exists), 4.1 (text-tools available).

**Outcome**: hh.ru pipeline routed through service. Single canonical LLM execution path. Phase C test count preserved (73 still pass).

### 4.4 Phase D - end-to-end pipeline integration test

**Goal**: original Phase D from earliest spec. End-to-end test against running service + Docker Postgres + real fixtures.

**Tasks**: unchanged from earlier spec; harness now uses ReactorClient + testcontainers Postgres + real `npm run reactor:start`.

**Dependencies**: 4.3.

**Outcome**: Phase D test ships. Decoupled architecture validated end-to-end.

### Ordering

```mermaid
graph LR
  T40["✅ 4.1 text-tools genesis (already shipped)"]
  T40b["⏳ 4.0 reactor service genesis<br/>(service+client+docker)"]
  T42["⏳ 4.2 extension thin client"]
  T43["⏳ 4.3 hh.ru thin client + adapter absorption"]
  T44["⏳ 4.4 Phase D E2E"]

  T40 --> T40b
  T40b --> T42
  T40b --> T43
  T43 --> T44
```

4.0 first; 4.2/4.3 parallel-friendly after; 4.4 last.

---

## Testing strategy

### Layered (per pokeroid Acts spirit)

| Layer | Owns | Tools |
|---|---|---|
| Drizzle schema | Migrations apply cleanly; jsonb queries work | testcontainers-node Postgres |
| Repositories (PostgresExperienceRepository, etc.) | Append/list/query semantics | testcontainers Postgres + Drizzle |
| Reactor + Adapter assembly inside service | Idea executes correctly with mocked LLMProvider | mock LLMProvider via `createMockLLMProvider` from `@dkolosovsky/reactor-text-tools/test-utils` |
| Route handlers (POST /execute, etc.) | HTTP contract: status codes, error mapping, request validation | supertest or fastify inject |
| ReactorClient | Constructs correct HTTP requests; parses responses; surfaces typed errors | mock-fetch |
| End-to-end | Full client → service → DB round-trip | testcontainers + spawn service in test |

### testcontainers-node pattern

```ts
import { GenericContainer, StartedTestContainer } from 'testcontainers';

let container: StartedTestContainer;
beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'reactor_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready'))
    .start();
  process.env.REACTOR_DATABASE_URL = `postgres://test:test@localhost:${container.getMappedPort(5432)}/reactor_test`;
  await runMigrations();
}, 30000);
afterAll(async () => container?.stop());
```

Tests get isolated DB instance, real Postgres semantics, no shared state across runs.

---

## Error handling

Service maps internal errors to HTTP responses. Client SDK reconstitutes typed errors.

| Internal error class | HTTP status | Response body `error.class` |
|---|---|---|
| `IdeaSchemaError` | 400 | `IdeaSchemaError` |
| `IdeaContextMissingError` | 400 | `IdeaContextMissingError` |
| `LLMTimeoutError` | 504 | `LLMTimeoutError` |
| `LLMQuotaError` | 429 (with Retry-After header) | `LLMQuotaError` |
| `LLMNetworkError` | 502 | `LLMNetworkError` |
| `LLMOutputParseError` | 502 | `LLMOutputParseError` |
| `ActivityCancelledError` | 499 (client closed) | `ActivityCancelledError` |
| Unhandled internal error | 500 | `ServiceError` |

`ReactorClient.execute()` throws appropriate typed errors so consumer code can `try/catch` on specific classes. Re-uses `TextToolsError` hierarchy from text-tools 4.1 plus a small `ReactorClientError` parent for HTTP-level issues (network, malformed response).

---

## Backward compatibility

What stays compatible across the migration:

| Interface / surface | Preserved? |
|---|---|
| `@dkolosovsky/reactor-text-tools` 0.1.0 builders, schemas, types | ✅ yes; re-exported via `@dkolosovsky/reactor-client` |
| `@dkolosovsky/reactor-text-tools` Activities, adapter, prompts | ✅ yes; consumed service-side |
| `@kolosochek/reactor-core` 0.2.0 SPI | ✅ yes; used internally by service |
| `@hhru/reactor-adapter` 0.2.0 (Phase C) shape | ✅ yes; will be registered in service's Reactor in 4.3 |
| Phase C CLI flag surface (`hhru:fetch`, `--auto`, `--min-score N --no-letter`, `--has-letter`, etc.) | ✅ yes; CLI scripts stay; only their internals shift to ReactorClient |
| Extension's `chrome.storage.local` HistoryEntry FORMAT | ⚠️ deprecated; new history reads come from `/reactor/experience`; old entries can be migrated one-shot or read alongside (consumer decision in 4.2) |
| Extension's `actions/{generateCoverLetter,answerQuestions}.ts` | ❌ removed in 4.2 |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Docker not installed on user's machine | Medium | High | Document `docker compose up` in extension README; provide install link; fallback: deploy reactor-service as separate process without Docker if user-managed Postgres exists |
| Service availability: extension breaks if service down | Medium | High | Health endpoint + retry logic in client; popup shows "Reactor unreachable" with actionable error; consider local fallback for v0.2 |
| HTTP latency adds to user-perceived time | Low | Low | localhost roundtrip is sub-ms; service execution time dominated by LLM call (seconds) — same as before |
| Postgres schema migration drift between dev/prod | Medium | Medium | Drizzle Kit migrations are versioned + applied on service start; CI runs migrations against testcontainers as smoke check |
| API key transmission over HTTP (even localhost) | Low | Medium | Localhost-only by default (`REACTOR_HTTP_HOST=127.0.0.1`); add HTTPS + auth in v0.2 if remote deployment desired |
| Multi-process Reactor: two services hitting same DB | Low | Medium | v0.1.0 expects single service instance; multi-process needs distributed locks (post-MVP concern) |
| Service binary distribution | Medium | Medium | v0.1.0 runs from source via `npm run reactor:start`; `pkg`/`nexe` for single-binary distribution is post-MVP |

---

## Open questions

Deferred to per-sub-project specs/plans:

1. **HistoryEntry migration in extension**: read existing `chrome.storage.local` HistoryEntry rows + POST them to `/reactor/experience/import` on first run, then deprecate local storage? Or leave existing rows alone, only new history goes through service? (Sub-project 4.2.)
2. ~~**`Reactor.execute(idea, opts.llmOverride?)` vs request-scoped Reactor**~~ **RESOLVED (2026-04-27): fresh `Reactor.create({ llm })` per request.** No changes to `@kolosochek/reactor-core` 0.2.0. See "Per-request LLM contract" subsection of Pokeroid Vision Alignment for full rationale.
3. **Provider routing for full pokeroid coverage**: `@kolosochek/reactor-core` ships `createOpenRouter`. Other providers (cerebras, groq, deepseek, xai, openai) need their own factories. Are they part of reactor-core's reference impls, or do they live in `@dkolosovsky/reactor-service` only? (Sub-project 4.0.)
4. **Service binary packaging**: ship as workspace package run from source vs `pkg`/`nexe` standalone binary vs Docker image of the Node process itself? (Future; post-4.0.)
5. **Auth in v0.2**: bearer token? mTLS? OIDC? Localhost-only is sufficient for MVP. (Future.)
6. **Multi-instance / horizontal scale**: Postgres handles concurrent connections; service is mostly stateless. Connection pool tuning + leader election for migrations are knobs. (Future.)

---

## Acceptance criteria

After 4.0 ships:
- [ ] `docker compose up reactor-postgres` succeeds; healthcheck green.
- [ ] `npm run reactor:start` boots service against running Postgres.
- [ ] Drizzle Kit migration applied; 5 tables created in `reactor` database.
- [ ] `POST /reactor/execute` with `{ idea: buildCoverLetterIdea(...), providerConfig: { ... } }` and a mock LLM provider returns a valid `Solution` JSON.
- [ ] `GET /reactor/experience?domain=text-tools` returns the persisted record from the previous step.
- [ ] `ReactorClient` instance correctly constructs requests and parses responses.
- [ ] All builders (`buildCoverLetterIdea`, `buildScoreIdea`, `buildQuestionsIdea`) re-exported from `@dkolosovsky/reactor-client`.
- [ ] Test suite passes: testcontainers Postgres for integration, mock LLM for activity tests, mock-fetch for client tests.
- [ ] `.env.example` documents all required env vars.
- [ ] README explains `docker compose up`, `npm run reactor:db:migrate`, `npm run reactor:start`.

After 4.2 ships:
- [ ] `extension/src/lib/actions/{generateCoverLetter,answerQuestions}.ts` removed.
- [ ] Extension popup generates a cover letter via `ReactorClient.execute(...)`.
- [ ] Extension's existing settings (preset, apiKey) flow into `providerConfig` per request.
- [ ] Existing extension tests pass.

After 4.3 ships:
- [ ] hh.ru CLI scripts use `ReactorClient`; bash subprocess for LLM operations gone.
- [ ] `hhruAdapter` registered server-side; CLI argv flags preserved.
- [ ] Phase C 73 tests pass against new flow.

After 4.4 ships:
- [ ] End-to-end test runs against `npm run reactor:start` + Docker Postgres.
- [ ] Test takes < 2 minutes.
- [ ] Test isolation: dedicated test DB; no interference with dev data.

---

## Decisions log (from brainstorming)

For future readers / executors:

1. **Reactor is a microservice, not an embedded library** (per pokeroid REACTOR.md:80-86). Old library-per-consumer model in superseded spec is rejected.
2. **PostgreSQL via Docker** for service-side persistence. Aligns with pokeroid `storage/README.md` pattern. Drizzle ORM with `postgres-js` driver. SQLite/in-memory rejected: doesn't scale for multi-consumer, doesn't match pokeroid storage vision.
3. **Per-request provider config** from consumer (matches pokeroid `agent/src/Provider/index.ts` "config from minimal input"). Service does not store API keys.
4. **`@dkolosovsky/reactor-service` and `@dkolosovsky/reactor-client` as workspace packages** in this repo.for now. Promote to own repos when stable.
5. **Sub-project ordering** prepends 4.0 (service genesis) before 4.2/4.3/4.4. Old superseded spec's 4.1 (text-tools genesis, already shipped) becomes service-internal dependency.
6. **Strict Idea-Triplet paradigm** preserved. Idea triplet IS the unit of communication across the HTTP boundary; consumer constructs locally, service executes, both sides see the same Idea shape.
7. **No partial states** preserved. Service either persists a complete ExperienceRecord (success or failure) and returns Solution, or throws typed error and persists `outcome: 'failure'` record.
8. **Fresh `Reactor.create({ llm })` per request** (resolved 2026-04-27). Rejected `Reactor.execute(idea, opts.llmOverride?)` because it would force a breaking 0.3.0 of reactor-core for a benefit that doesn't materialize at our request rates. PG repos remain long-lived (pool-bound singletons); only the Reactor wrapper is per-request. See Pokeroid Vision Alignment > Per-request LLM contract.
9. **Crystallization tables deferred to 4.5** (decided 2026-04-27). T3 Drizzle schema ships only the 5 SPI tables (experience, lessons, ideas, predictions, tools). Composition tables (`lesson_compositions`, `prediction_for_idea`, etc.) materialize when sub-project 4.5 wires the F1 seam. Forward-looking note in 4.0 schema only.

---

## Spec / commit anchors

- This spec: `docs/superpowers/specs/2026-04-26-reactor-service-design.md`
- Superseded by this: `docs/superpowers/specs/2026-04-26-text-tools-decouple-design.md` (commit `4654dfa`; will be marked SUPERSEDED in a follow-up edit)
- Pokeroid REACTOR.md: `/Users/noone/data/pokeroid/runtime/REACTOR.md`
- Pokeroid storage: `/Users/noone/data/pokeroid/storage/README.md`
- Pokeroid agent provider abstraction: `/Users/noone/data/pokeroid/agent/src/Provider/`
- Pokeroid Decision 010 (No Hidden State): `/Users/noone/data/pokeroid/_akoppela-design-lab/_decisions/010-graph-centric-state-management.md`
- text-tools 4.1 (preserved as service-internal dep): commit `b2c0ca6` of hhru repo
- reactor-core 0.2.0 (preserved as service-internal dep): commit `ad67d9e` in `/Users/noone/data/ereal/reactor-core/`
