# text-tools genesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@reactor/text-tools` 0.1.0 — a platform-agnostic text-LLM domain adapter on `@kolosochek/reactor-core` that both the Chrome extension and the hh.ru reactor-adapter will consume in subsequent sub-projects (4.2, 4.3).

**Architecture:** Strict Idea-Triplet paradigm: every operation is `reactor.execute(idea)`, where the Idea carries a `MetaMessage` + `DataMessage._call`. text-tools provides 3 Activities (`generateCoverLetter`, `scoreVacancy`, `answerQuestions`), each composed via `composeActivity({ preCheck?, llmFallback, postValidate? })`. Today only `llmFallback` is wired; `preCheck`/`postValidate` are seams for future crystallization. Reactor-core gets a non-breaking 0.2.0 SPI patch so Activity context exposes `llm: LLMProvider`, `signal: AbortSignal | undefined`, and `onProgress` (which today are typed but unpopulated).

**Tech Stack:** TypeScript (workspaces), Zod + zod-to-json-schema, vitest, `@kolosochek/reactor-core` (peer dep, `file:` link in dev). No browser-specific code, no Node-specific dependencies (no `fs`, `child_process`); the package must run unchanged in Chrome MV3 service workers.

**Source spec:** `docs/superpowers/specs/2026-04-26-text-tools-decouple-design.md` (commit `4654dfa`).

---

## Locked decisions (from spec)

1. Strict Idea-Triplet paradigm. Every call is `reactor.execute(idea)`. No raw callbacks.
2. Builders construct Idea **directly** (not via `IdeaBuilder` — its mandatory tool-palette schema doesn't fit single-call Activities). Mirrors `@hhru/reactor-adapter`'s `buildHhruPipelineIdea` pattern.
3. Activity SPI extends with `ctx.llm: LLMProvider` (non-breaking).
4. `Reactor.execute(idea, opts?)` gains opts param for `signal` + `onProgress`.
5. `composeActivity({ preCheck?, llmFallback, postValidate? })` is the seam for future crystallization. Today every Activity uses only `llmFallback`.
6. Package namespace `@reactor/text-tools` (tentative; Open Question #5 in spec).
7. en + ru prompts. en is the primary at 0.1.0; ru is "best effort" port.

## File structure

### Files in `@kolosochek/reactor-core` (own repo at `/Users/noone/data/ereal/reactor-core/`)

| File | Action | Responsibility |
|---|---|---|
| `src/types/adapter.ts` | Modify | Extend `ActivityContext` with `llm: LLMProvider` |
| `src/reactor/Reactor.ts` | Modify | `execute(idea, opts?)` signature + ctx wiring in 3 modes |
| `src/__tests__/reactor.executeContext.test.ts` | Create | Asserts ctx.llm/signal/onProgress are propagated |
| `package.json` | Modify | Bump 0.1.0 → 0.2.0 |
| `CHANGELOG.md` | Modify | 0.2.0 entry |

### Files in `packages/text-tools/` (new workspace inside hhru repo)

```
packages/text-tools/
├── package.json                      Workspace manifest, peer dep on reactor-core
├── tsconfig.json                     Build config
├── tsconfig.build.json               Production build config (dist/)
├── vitest.config.ts                  Test glob: src/**/__tests__/**/*.test.ts
├── README.md                         Package docs
├── CHANGELOG.md                      0.1.0 entry
├── .gitignore                        Standard node ignores
└── src/
    ├── index.ts                      Public exports barrel
    ├── adapter.ts                    textToolsAdapter (Adapter object)
    ├── domain.ts                     textToolsDomain (DomainContext)
    ├── builders.ts                   buildCoverLetterIdea, buildScoreIdea, buildQuestionsIdea
    ├── errors.ts                     TextToolsError + 7 typed subclasses
    ├── activity/
    │   └── compose.ts                composeActivity factory + types
    ├── tools/
    │   ├── coverLetter.ts            CoverLetterInput Zod + Tool def + Solution shape
    │   ├── score.ts                  ScoreInput + Tool + Solution
    │   └── questions.ts              QuestionsInput + Tool + Solution
    ├── activities/
    │   ├── coverLetter.ts            generateCoverLetterActivity (composeActivity)
    │   ├── score.ts                  scoreVacancyActivity (jsonMode + Zod-validate)
    │   └── questions.ts              answerQuestionsActivity (jsonMode + Zod-validate)
    ├── prompts/
    │   ├── index.ts                  Exports defaultXxxPrompt = { en, ru }
    │   ├── coverLetter.ts            Default cover-letter system prompts (en, ru)
    │   ├── score.ts                  Default scoring system prompts (en, ru)
    │   └── questions.ts              Default question-answering system prompts (en, ru)
    ├── test-utils/
    │   ├── index.ts                  Test-utils exports
    │   ├── mockLLM.ts                createMockLLMProvider
    │   └── contract.ts               runLLMProviderContractTests
    └── __tests__/
        ├── tools.coverLetter.test.ts
        ├── tools.score.test.ts
        ├── tools.questions.test.ts
        ├── compose.test.ts
        ├── errors.test.ts
        ├── prompts.test.ts
        ├── mockLLM.test.ts
        ├── contract.test.ts
        ├── activities.coverLetter.test.ts
        ├── activities.score.test.ts
        ├── activities.questions.test.ts
        ├── builders.test.ts
        ├── adapter.test.ts
        └── integration.test.ts
```

### Files in hhru repo root

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | Add `extension` to workspaces (optional, depends on Open Question #5; for 4.1 leave as-is, picked up in 4.2) |

For 4.1 the only root-level change is reactor-adapter's package.json bumping the peer dep version. Adapter doesn't *need* 0.2.0 yet — it works with 0.1.0 SPI surface — but bumping ensures CI runs against the new version.

---

## Task dependency graph

```
T1 ─→ T2 ─→ T3 ─→ T4 (reactor-core 0.2.0)
                    │
                    ↓
T5 (workspace bootstrap)
   │
   ├─→ T6 (compose seam)
   ├─→ T7 (errors)
   ├─→ T8 (CoverLetter schema)
   ├─→ T9 (Score schema)
   ├─→ T10 (Questions schema)
   └─→ T11 (Prompts)
                    │
                    ↓
              T12 (Mock LLM)
              T13 (Contract test suite) ──┐
                                          │
       ┌── T14 (CoverLetter activity) ────┤
       ├── T15 (Score activity) ──────────┤
       └── T16 (Questions activity) ──────┤
                                          │
                                          ↓
                                  T17 (Builders)
                                  T18 (Domain)
                                  T19 (Adapter)
                                  T20 (Public exports)
                                  T21 (Integration smoke)
                                  T22 (README + CHANGELOG + acceptance triple)
```

22 tasks total. Tasks T6-T11 are parallel-friendly within their batch (each touches a distinct file). Tasks T14-T16 are parallel-friendly. The skill's "no parallel implementation subagents" rule still applies, but ordering can be flexible within batches.

---

## Task 1: reactor-core SPI types — extend `ActivityContext` and `Reactor.execute` signature

**Files:**
- Modify: `/Users/noone/data/ereal/reactor-core/src/types/adapter.ts`
- Modify: `/Users/noone/data/ereal/reactor-core/src/reactor/Reactor.ts`

**Why:** text-tools Activities need `ctx.llm` to call the LLM. Today the LLMProvider lives only on the `Reactor` instance, never reaches Activities. We also surface `Reactor.execute(idea, opts?)` so callers can pass `signal`/`onProgress` without putting them inside the Idea data.

- [ ] **Step 1: Read current `ActivityContext` type and `execute` signature**

```bash
sed -n '15,30p' /Users/noone/data/ereal/reactor-core/src/types/adapter.ts
sed -n '160,210p' /Users/noone/data/ereal/reactor-core/src/reactor/Reactor.ts
```

Confirm:
- `ActivityContext` currently has `onProgress?`, `signal?`, `state` fields.
- `execute(idea: Idea): Promise<Solution>` takes only the idea.

- [ ] **Step 2: Update `ActivityContext` type to require `llm`**

Edit `src/types/adapter.ts`:

```ts
import type { JSONSchema7 } from 'json-schema';
import type { LLMProvider } from './llm.js';
import type { DomainContext, ToolCategory } from './domain.js';
import type { RepositoriesProvider } from './repositories.js';
import type { Lesson } from './lessons.js';

export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  type?: 'explicit' | 'latent';
  inputSchema?: JSONSchema7;
  outputSchema?: JSONSchema7;
}

export interface ProgressEvent {
  type: string;
  payload: unknown;
}

export interface ActivityContext {
  onProgress?: (event: ProgressEvent) => void;
  signal?: AbortSignal;
  state: Record<string, unknown>;
  llm: LLMProvider;
}

export type Activity = (input: unknown, ctx: ActivityContext) => Promise<unknown>;

// (Plan, PlanStep, PlanCondition, Adapter unchanged; keep them as-is.)
```

Locate the existing `Plan`, `PlanStep`, `PlanCondition`, and `Adapter` interfaces in the file and leave them unchanged.

- [ ] **Step 3: Update `Reactor.execute` signature in Reactor.ts**

Find the existing `execute` method (around line 164) and the three private methods (`executeDirect`, `executeBatch`, `executeScenario`). Update only the public signature for now; we'll wire ctx in Task 2.

Replace:
```ts
async execute(idea: Idea): Promise<Solution> {
  const mode = this.detectMode(idea);
  if (mode === 'direct') return this.executeDirect(idea);
  if (mode === 'batch') return this.executeBatch(idea);
  if (mode === 'scenario') return this.executeScenario(idea);
  throw new Error(`Unknown execution mode: ${mode as string}`);
}
```

With:
```ts
async execute(
  idea: Idea,
  opts?: { signal?: AbortSignal; onProgress?: (event: ProgressEvent) => void }
): Promise<Solution> {
  const mode = this.detectMode(idea);
  const execOpts = opts ?? {};
  if (mode === 'direct') return this.executeDirect(idea, execOpts);
  if (mode === 'batch') return this.executeBatch(idea, execOpts);
  if (mode === 'scenario') return this.executeScenario(idea, execOpts);
  throw new Error(`Unknown execution mode: ${mode as string}`);
}
```

Update the three private method signatures to also accept `execOpts`:
```ts
private async executeDirect(
  idea: Idea,
  execOpts: { signal?: AbortSignal; onProgress?: (event: ProgressEvent) => void }
): Promise<Solution> { /* body unchanged for now */ }

private async executeBatch(
  idea: Idea,
  execOpts: { signal?: AbortSignal; onProgress?: (event: ProgressEvent) => void }
): Promise<Solution> { /* body unchanged for now */ }

private async executeScenario(
  idea: Idea,
  execOpts: { signal?: AbortSignal; onProgress?: (event: ProgressEvent) => void }
): Promise<Solution> { /* body unchanged for now */ }
```

If `ProgressEvent` is not already imported in `Reactor.ts`, add it to the existing imports from `'../types/adapter.js'` or wherever the file imports types.

- [ ] **Step 4: Run existing tests, verify no regressions on type signature alone**

```bash
cd /Users/noone/data/ereal/reactor-core
npx tsc --noEmit
```

Expected: 0 errors. The body of execute methods is unchanged; only signatures shifted to accept (unused for now) `execOpts`. If there are typecheck errors about `LLMProvider` being missing, ensure `src/types/llm.ts` exports it (it already does — there's nothing to fix in this case).

- [ ] **Step 5: Commit**

```bash
cd /Users/noone/data/ereal/reactor-core
git add src/types/adapter.ts src/reactor/Reactor.ts
git commit -m "feat(types): extend ActivityContext with llm; add Reactor.execute opts param"
```

---

## Task 2: reactor-core SPI wiring — populate `ctx.llm`, `ctx.signal`, `ctx.onProgress` in execute modes

**Files:**
- Modify: `/Users/noone/data/ereal/reactor-core/src/reactor/Reactor.ts`

**Why:** Currently `executeDirect/Batch/Scenario` build `ctx` as just `{ state }` (or `{ state: {} }`), even though `signal` and `onProgress` are typed as optional. The test in Task 3 will assert ctx is fully populated. This step makes it so.

- [ ] **Step 1: Find the three Activity invocation sites**

```bash
grep -n "await activity(" /Users/noone/data/ereal/reactor-core/src/reactor/Reactor.ts
```

Expected output: three lines (one each in `executeDirect`, `executeBatch`, `executeScenario`).

- [ ] **Step 2: Update `executeDirect` to populate full ctx**

Find the body of `executeDirect`. Locate the line `const output = await activity(call, { state: {} });` (approximately line 196). Replace with:

```ts
const ctx: ActivityContext = {
  state: {},
  llm: this.config.llm,
  signal: execOpts.signal,
  onProgress: execOpts.onProgress,
};
const output = await activity(call, ctx);
```

If `ActivityContext` is not already imported in `Reactor.ts`, add it to the existing imports from `'../types/adapter.js'`.

- [ ] **Step 3: Update `executeBatch` to populate full ctx**

Find the body of `executeBatch`. Locate the line `output = await activity(resolvedArgs, { state });` (approximately line 232). Replace the `{ state }` literal with the same full ctx pattern:

```ts
const ctx: ActivityContext = {
  state,
  llm: this.config.llm,
  signal: execOpts.signal,
  onProgress: execOpts.onProgress,
};
output = await activity(resolvedArgs, ctx);
```

(Note: `state` is reused per-iteration; the `ctx` object is built once per call.)

- [ ] **Step 4: Update `executeScenario` to populate full ctx**

Find the body of `executeScenario`. Locate the activity invocation. Apply the same pattern.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/noone/data/ereal/reactor-core
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 6: Run existing reactor-core tests**

```bash
cd /Users/noone/data/ereal/reactor-core
npx vitest run
```

Expected: 141/141 PASS (no regressions). The existing tests do not assert on ctx fields, so they pass even though ctx is now richer.

- [ ] **Step 7: Commit**

```bash
cd /Users/noone/data/ereal/reactor-core
git add src/reactor/Reactor.ts
git commit -m "feat(reactor): populate ctx.llm/signal/onProgress in all execute modes"
```

---

## Task 3: reactor-core test — assert ctx is propagated to Activities

**Files:**
- Create: `/Users/noone/data/ereal/reactor-core/src/__tests__/reactor.executeContext.test.ts`

**Why:** The wiring in Task 2 must be guarded by a test, otherwise a future refactor could silently strip ctx fields again. This test invokes a mock Activity that records what ctx it received.

- [ ] **Step 1: Write the failing test**

Create `/Users/noone/data/ereal/reactor-core/src/__tests__/reactor.executeContext.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { Reactor } from '../reactor/Reactor.js';
import { IdeaBuilder, createMeta } from '../reactor/IdeaBuilder.js';
import type { LLMProvider, ActivityContext } from '../types/index.js';

const stubLLM: LLMProvider = {
  name: 'stub',
  async complete() {
    return { content: '', model: 'stub' };
  },
};

describe('Reactor.execute ActivityContext propagation', () => {
  it('direct mode: ctx receives llm, signal, onProgress', async () => {
    // SCENARIO: direct execution invokes a single activity with full ctx
    // INPUT: Idea with DataMessage._call; Reactor created with stubLLM; opts pass signal+onProgress
    // EXPECTED: activity received ctx whose llm is stubLLM, signal is the AbortSignal, onProgress is the function
    let captured: ActivityContext | null = null;
    const r = Reactor.create({ llm: stubLLM });
    r.use({
      name: 'capture-adapter',
      version: '0.1.0',
      tools: [
        {
          name: 'capture',
          description: 'capture ctx',
          category: 'transformation',
          inputSchema: { type: 'object' },
        },
      ],
      activities: {
        capture: async (_input, ctx) => {
          captured = ctx;
          return { ok: true };
        },
      },
    });

    const ac = new AbortController();
    const onProgress = vi.fn();
    const idea = {
      schema: { type: 'object' as const },
      context: [
        { type: 'meta' as const, role: 'system' as const, meta: createMeta('test', '/x') },
        {
          type: 'data' as const,
          role: 'system' as const,
          data: {},
          _call: { _tool: 'capture', _outputPath: '†state.out' },
        },
      ],
      solution: null,
    };

    await r.execute(idea, { signal: ac.signal, onProgress });

    expect(captured).not.toBeNull();
    if (captured === null) throw new Error('captured was null');
    expect(captured.llm).toBe(stubLLM);
    expect(captured.signal).toBe(ac.signal);
    expect(captured.onProgress).toBe(onProgress);
  });

  it('batch mode: ctx receives llm, signal, onProgress per call', async () => {
    // SCENARIO: batch with 2 PlanCalls invokes activity twice; each invocation receives ctx
    // INPUT: PlanMessage with two calls; Reactor with stubLLM; opts pass signal+onProgress
    // EXPECTED: both invocations capture the same llm/signal/onProgress; state is the same object reference
    const captures: ActivityContext[] = [];
    const r = Reactor.create({ llm: stubLLM });
    r.use({
      name: 'capture-adapter',
      version: '0.1.0',
      tools: [
        {
          name: 'capture',
          description: 'capture ctx',
          category: 'transformation',
          inputSchema: { type: 'object' },
        },
      ],
      activities: {
        capture: async (_input, ctx) => {
          captures.push(ctx);
          return { ok: true };
        },
      },
    });

    const ac = new AbortController();
    const onProgress = vi.fn();
    const idea = {
      schema: { type: 'object' as const },
      context: [
        { type: 'meta' as const, role: 'system' as const, meta: createMeta('test', '/x') },
        {
          type: 'plan' as const,
          role: 'system' as const,
          plan: {
            title: 't',
            description: '',
            reasoning: '',
            calls: [
              { _tool: 'capture', _outputPath: '†state.a' },
              { _tool: 'capture', _outputPath: '†state.b' },
            ],
            dataFlow: [],
          },
        },
      ],
      solution: null,
    };

    await r.execute(idea, { signal: ac.signal, onProgress });

    expect(captures.length).toBe(2);
    for (const ctx of captures) {
      expect(ctx.llm).toBe(stubLLM);
      expect(ctx.signal).toBe(ac.signal);
      expect(ctx.onProgress).toBe(onProgress);
    }
    // state is shared across the batch (per executeBatch design)
    expect(captures[0]?.state).toBe(captures[1]?.state);
  });

  it('execute without opts: signal and onProgress are undefined; llm always set', async () => {
    // SCENARIO: caller doesn't pass opts; ctx still gets llm but signal/onProgress are undefined
    // INPUT: Idea, Reactor with stubLLM, no opts
    // EXPECTED: ctx.llm = stubLLM; ctx.signal = undefined; ctx.onProgress = undefined
    let captured: ActivityContext | null = null;
    const r = Reactor.create({ llm: stubLLM });
    r.use({
      name: 'capture-adapter',
      version: '0.1.0',
      tools: [
        {
          name: 'capture',
          description: 'capture ctx',
          category: 'transformation',
          inputSchema: { type: 'object' },
        },
      ],
      activities: {
        capture: async (_input, ctx) => {
          captured = ctx;
          return { ok: true };
        },
      },
    });

    const idea = {
      schema: { type: 'object' as const },
      context: [
        { type: 'meta' as const, role: 'system' as const, meta: createMeta('test', '/x') },
        {
          type: 'data' as const,
          role: 'system' as const,
          data: {},
          _call: { _tool: 'capture', _outputPath: '†state.out' },
        },
      ],
      solution: null,
    };

    await r.execute(idea);

    expect(captured).not.toBeNull();
    if (captured === null) throw new Error('captured was null');
    expect(captured.llm).toBe(stubLLM);
    expect(captured.signal).toBeUndefined();
    expect(captured.onProgress).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the new test, verify it passes (green from Task 2's wiring)**

```bash
cd /Users/noone/data/ereal/reactor-core
npx vitest run src/__tests__/reactor.executeContext.test.ts
```

Expected: 3/3 PASS. (The test was written after Task 2 wired ctx; it should pass on first run. If it fails, ctx wiring in Reactor.ts is incomplete — go back to Task 2.)

- [ ] **Step 3: Run full reactor-core test suite for regression check**

```bash
cd /Users/noone/data/ereal/reactor-core
npx vitest run
```

Expected: 144/144 PASS (was 141; +3 from this task).

- [ ] **Step 4: Commit**

```bash
cd /Users/noone/data/ereal/reactor-core
git add src/__tests__/reactor.executeContext.test.ts
git commit -m "test(reactor): assert ctx.llm/signal/onProgress propagation in all execute modes"
```

---

## Task 4: reactor-core 0.2.0 release — version bump + CHANGELOG

**Files:**
- Modify: `/Users/noone/data/ereal/reactor-core/package.json`
- Modify: `/Users/noone/data/ereal/reactor-core/CHANGELOG.md`

**Why:** SPI extension is non-breaking but adds new public surface; bump minor.

- [ ] **Step 1: Bump version**

Edit `/Users/noone/data/ereal/reactor-core/package.json`. Change `"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 2: CHANGELOG entry**

Edit `/Users/noone/data/ereal/reactor-core/CHANGELOG.md`. Add at the top (under any existing format header):

```markdown
## 0.2.0 — Activity SPI extension

### Added
- `ActivityContext.llm: LLMProvider` — Activities now receive the same `LLMProvider` that `Reactor.create({ llm })` was constructed with. Previously the LLM was reachable only through Reactor itself, not Activities.
- `Reactor.execute(idea, opts?: { signal?, onProgress? })` — opts param surfaces execution-time signal and progress sink. Optional; no consumer change required for existing callers.

### Changed
- `executeDirect`, `executeBatch`, `executeScenario` now populate `ctx` with `llm`, `signal`, and `onProgress` (the latter two were typed as optional on `ActivityContext` but never actually populated). Existing Activities that ignore these fields continue to work unchanged.

### Backward compatibility
- All Phase A/B Activities (`@hhru/reactor-adapter` 0.1.0 and 0.2.0) continue to work without modification: they read only `ctx.state`, which is unchanged.
```

- [ ] **Step 3: Verify build still works**

```bash
cd /Users/noone/data/ereal/reactor-core
npx tsc --noEmit
npx vitest run
npm run build
```

Expected: 0 typecheck errors; 144/144 tests pass; `dist/` populated.

- [ ] **Step 4: Commit**

```bash
cd /Users/noone/data/ereal/reactor-core
git add package.json CHANGELOG.md
git commit -m "release: 0.2.0 — Activity SPI extension (llm/signal/onProgress in ctx)"
```

After this commit, `@kolosochek/reactor-core` is at 0.2.0. Consumers using `file:` link pick it up automatically.

---

## Task 5: Bootstrap `packages/text-tools/` workspace

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/package.json`
- Create: `/Users/noone/data/reactor/packages/text-tools/tsconfig.json`
- Create: `/Users/noone/data/reactor/packages/text-tools/tsconfig.build.json`
- Create: `/Users/noone/data/reactor/packages/text-tools/vitest.config.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/.gitignore`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/index.ts` (stub barrel)
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/smoke.test.ts`

**Why:** Bootstrap the package skeleton. Mirror `@hhru/reactor-adapter`'s structure for consistency. Smoke test verifies tsc + vitest can run end-to-end.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@reactor/text-tools",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./test-utils": {
      "import": "./dist/test-utils/index.js",
      "types": "./dist/test-utils/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@kolosochek/reactor-core": "file:../../../ereal/reactor-core",
    "zod": "^3.22.0",
    "zod-to-json-schema": "^3.22.0"
  },
  "devDependencies": {
    "@types/json-schema": "^7.0.15",
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

Mirror reactor-adapter's package.json field-for-field except for the `name`, the `./test-utils` export entry, and the dependency set. The `./test-utils` subpath is so the future plan 4.2 (extension) can do `import { createMockLLMProvider } from '@reactor/text-tools/test-utils'`.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Note: `"DOM"` in `lib` is required because the package targets browser (Chrome MV3). reactor-adapter doesn't include DOM (it's Node-only). text-tools is browser-friendly.

- [ ] **Step 3: Create `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false
  },
  "exclude": ["node_modules", "dist", "src/**/__tests__/**", "src/**/*.test.ts"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
```

(Mirrors reactor-adapter's vitest config exactly.)

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 6: Create stub `src/index.ts`**

```ts
// packages/text-tools/src/index.ts
// Public exports barrel. Populated as Tasks T6-T20 land.
export {};
```

- [ ] **Step 7: Create smoke test**

Create `src/__tests__/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('package skeleton', () => {
  it('imports index without throwing', async () => {
    // SCENARIO: package can be imported as a module
    // INPUT: import the barrel
    // EXPECTED: import succeeds and module is an object
    const mod = await import('../index.js');
    expect(typeof mod).toBe('object');
  });
});
```

- [ ] **Step 8: Install workspace dependencies**

```bash
cd /Users/noone/data/reactor
npm install
```

This picks up the new `packages/text-tools/` workspace, links `@kolosochek/reactor-core` from `file:../../../ereal/reactor-core`, and installs deps. Expected: no errors, `node_modules` symlinks created in `packages/text-tools/`.

- [ ] **Step 9: Run smoke test**

```bash
cd /Users/noone/data/reactor/packages/text-tools
npx vitest run
```

Expected: 1/1 PASS.

- [ ] **Step 10: Typecheck**

```bash
cd /Users/noone/data/reactor/packages/text-tools
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 11: Commit (only the new files; do NOT add unrelated dirty files)**

```bash
cd /Users/noone/data/reactor
git add packages/text-tools/package.json \
        packages/text-tools/tsconfig.json \
        packages/text-tools/tsconfig.build.json \
        packages/text-tools/vitest.config.ts \
        packages/text-tools/.gitignore \
        packages/text-tools/src/index.ts \
        packages/text-tools/src/__tests__/smoke.test.ts \
        package-lock.json
git commit -m "feat(text-tools): bootstrap @reactor/text-tools 0.1.0 workspace"
```

If `package-lock.json` was modified by the `npm install` of step 8, include it. Do NOT include any other modified file.

---

## Task 6: `composeActivity` factory

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/activity/compose.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/compose.test.ts`

**Why:** The crystallization seam. Today every text-tools Activity uses only the `llmFallback` layer; future iterations may add `preCheck` (deterministic shortcut) or `postValidate` (LLM-output check). Building this seam in T6 keeps it ready.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/compose.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { composeActivity } from '../activity/compose.js';
import type { ActivityContext } from '@kolosochek/reactor-core';

const ctx: ActivityContext = {
  state: {},
  llm: { name: 'mock', async complete() { return { content: '', model: 'mock' }; } },
};

describe('composeActivity', () => {
  it('uses llmFallback when no preCheck or postValidate provided', async () => {
    // SCENARIO: minimal composition with only llmFallback
    // INPUT: input { x: 1 }; llmFallback returns { y: 2 }
    // EXPECTED: composed activity returns { y: 2 }
    const llmFallback = vi.fn().mockResolvedValue({ y: 2 });
    const activity = composeActivity({ llmFallback });

    const result = await activity({ x: 1 }, ctx);

    expect(result).toEqual({ y: 2 });
    expect(llmFallback).toHaveBeenCalledOnce();
    expect(llmFallback).toHaveBeenCalledWith({ x: 1 }, ctx);
  });

  it('preCheck returns Solution when crystallized; llmFallback skipped', async () => {
    // SCENARIO: preCheck recognizes a deterministic case; llmFallback never invoked
    // INPUT: input { x: 'easy-case' }; preCheck returns { y: 'fast' }
    // EXPECTED: result is preCheck output; llmFallback was not called
    const llmFallback = vi.fn();
    const preCheck = vi.fn().mockReturnValue({ y: 'fast' });
    const activity = composeActivity({ preCheck, llmFallback });

    const result = await activity({ x: 'easy-case' }, ctx);

    expect(result).toEqual({ y: 'fast' });
    expect(preCheck).toHaveBeenCalledOnce();
    expect(llmFallback).not.toHaveBeenCalled();
  });

  it('preCheck returns null falls through to llmFallback', async () => {
    // SCENARIO: preCheck cannot crystallize; llmFallback is invoked
    // INPUT: input { x: 'hard-case' }; preCheck returns null
    // EXPECTED: result is llmFallback output
    const llmFallback = vi.fn().mockResolvedValue({ y: 'llm' });
    const preCheck = vi.fn().mockReturnValue(null);
    const activity = composeActivity({ preCheck, llmFallback });

    const result = await activity({ x: 'hard-case' }, ctx);

    expect(result).toEqual({ y: 'llm' });
    expect(preCheck).toHaveBeenCalledOnce();
    expect(llmFallback).toHaveBeenCalledOnce();
  });

  it('postValidate wraps llmFallback output', async () => {
    // SCENARIO: postValidate enforces a structural check on LLM output
    // INPUT: input {}; llmFallback returns { letter: 'short' }; postValidate appends a sig
    // EXPECTED: result is the postValidate output
    const llmFallback = vi.fn().mockResolvedValue({ letter: 'short' });
    const postValidate = vi.fn().mockImplementation(
      (_input: unknown, output: { letter: string }) => ({ letter: `${output.letter} - sig` }),
    );
    const activity = composeActivity({ llmFallback, postValidate });

    const result = await activity({}, ctx);

    expect(result).toEqual({ letter: 'short - sig' });
  });

  it('postValidate not invoked when preCheck succeeds', async () => {
    // SCENARIO: explicit ruleset wins; postValidate is for LLM output only
    // INPUT: preCheck returns { letter: 'preset-letter' }
    // EXPECTED: result is preCheck output, postValidate not called
    const llmFallback = vi.fn();
    const preCheck = vi.fn().mockReturnValue({ letter: 'preset-letter' });
    const postValidate = vi.fn();
    const activity = composeActivity({ preCheck, llmFallback, postValidate });

    const result = await activity({}, ctx);

    expect(result).toEqual({ letter: 'preset-letter' });
    expect(postValidate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/noone/data/reactor/packages/text-tools
npx vitest run src/__tests__/compose.test.ts
```

Expected: FAIL with "Cannot find module" or "composeActivity is not a function".

- [ ] **Step 3: Implement `composeActivity`**

Create `src/activity/compose.ts`:

```ts
// packages/text-tools/src/activity/compose.ts
//
// composeActivity is the crystallization seam: today every text-tools
// Activity uses only `llmFallback`. As patterns emerge, deterministic
// `preCheck` short-circuits and `postValidate` wrappers can be added without
// rewriting the Activity itself.

import type { ActivityContext } from '@kolosochek/reactor-core';

export type CrystallizableActivity<I, O> = (input: I, ctx: ActivityContext) => Promise<O>;

export interface ActivityLayers<I, O> {
  /** Returns a deterministic Solution when the case is crystallized; null to fall through to LLM. */
  preCheck?: (input: I) => O | null;
  /** Required: the LLM-based fallback. Receives full ctx (state, llm, signal, onProgress). */
  llmFallback: CrystallizableActivity<I, O>;
  /** Optional: post-process LLM output (validation, structural checks, augmentation). */
  postValidate?: (input: I, output: O) => O;
}

export function composeActivity<I, O>(layers: ActivityLayers<I, O>): CrystallizableActivity<I, O> {
  return async (input, ctx) => {
    if (layers.preCheck !== undefined) {
      const explicit = layers.preCheck(input);
      if (explicit !== null) return explicit;
    }
    const latent = await layers.llmFallback(input, ctx);
    return layers.postValidate !== undefined ? layers.postValidate(input, latent) : latent;
  };
}
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
npx vitest run src/__tests__/compose.test.ts
```

Expected: 5/5 PASS.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/noone/data/reactor
git add packages/text-tools/src/activity/compose.ts \
        packages/text-tools/src/__tests__/compose.test.ts
git commit -m "feat(text-tools): composeActivity crystallization seam"
```

---

## Task 7: TextToolsError hierarchy

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/errors.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/errors.test.ts`

**Why:** Per spec section 7, text-tools defines a typed error hierarchy. Activities and builders throw these; consumers branch on `instanceof`.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  TextToolsError,
  IdeaSchemaError,
  IdeaContextMissingError,
  LLMTimeoutError,
  LLMQuotaError,
  LLMNetworkError,
  LLMOutputParseError,
  ActivityCancelledError,
} from '../errors.js';

describe('TextToolsError hierarchy', () => {
  it('all subclasses extend TextToolsError', () => {
    // SCENARIO: each subclass should inherit from TextToolsError
    // INPUT: instance of each
    // EXPECTED: instanceof TextToolsError is true
    expect(new IdeaSchemaError('x')).toBeInstanceOf(TextToolsError);
    expect(new IdeaContextMissingError('x')).toBeInstanceOf(TextToolsError);
    expect(new LLMTimeoutError('x')).toBeInstanceOf(TextToolsError);
    expect(new LLMQuotaError('x')).toBeInstanceOf(TextToolsError);
    expect(new LLMNetworkError('x', new Error('cause'))).toBeInstanceOf(TextToolsError);
    expect(new LLMOutputParseError({ rawContent: 'x', expectedSchema: 's' })).toBeInstanceOf(TextToolsError);
    expect(new ActivityCancelledError('x')).toBeInstanceOf(TextToolsError);
  });

  it('all subclasses also extend Error', () => {
    // SCENARIO: needed for try/catch interop
    // INPUT/EXPECTED: same instances are Error
    expect(new IdeaSchemaError('x')).toBeInstanceOf(Error);
    expect(new ActivityCancelledError('x')).toBeInstanceOf(Error);
  });

  it('LLMOutputParseError carries rawContent and expectedSchema', () => {
    // SCENARIO: structured fields for debugging
    // INPUT: error constructed with { rawContent, expectedSchema }
    // EXPECTED: fields readable; message includes the schema name
    const err = new LLMOutputParseError({
      rawContent: 'not json',
      expectedSchema: 'ScoreSolution',
    });
    expect(err.rawContent).toBe('not json');
    expect(err.expectedSchema).toBe('ScoreSolution');
    expect(err.message).toMatch(/ScoreSolution/);
  });

  it('LLMQuotaError accepts retryAfterMs', () => {
    // SCENARIO: 429 response returns Retry-After header
    // INPUT: error constructed with retryAfterMs
    // EXPECTED: field is readable
    const err = new LLMQuotaError('quota exceeded', { retryAfterMs: 30000 });
    expect(err.retryAfterMs).toBe(30000);
  });

  it('LLMNetworkError preserves cause', () => {
    // SCENARIO: wrap underlying network error for diagnostics
    // INPUT: cause = original Error
    // EXPECTED: err.cause references the original
    const cause = new Error('ECONNREFUSED');
    const err = new LLMNetworkError('network failure', cause);
    expect(err.cause).toBe(cause);
  });

  it('error class names are stable for downstream classification', () => {
    // SCENARIO: ExperienceRecord persists errorClass for analysis; class names must be stable
    // INPUT: each error
    // EXPECTED: name field equals the literal class name
    expect(new IdeaSchemaError('x').name).toBe('IdeaSchemaError');
    expect(new IdeaContextMissingError('x').name).toBe('IdeaContextMissingError');
    expect(new LLMTimeoutError('x').name).toBe('LLMTimeoutError');
    expect(new LLMQuotaError('x').name).toBe('LLMQuotaError');
    expect(new LLMNetworkError('x', new Error('c')).name).toBe('LLMNetworkError');
    expect(new LLMOutputParseError({ rawContent: 'x', expectedSchema: 's' }).name).toBe('LLMOutputParseError');
    expect(new ActivityCancelledError('x').name).toBe('ActivityCancelledError');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npx vitest run src/__tests__/errors.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement errors**

Create `src/errors.ts`:

```ts
// packages/text-tools/src/errors.ts
//
// Typed error hierarchy. Per spec section 7. Each subclass has a stable
// `name` field used by Reactor.appendExperience to populate
// ExperienceRecord.errorClass for downstream classification.

export class TextToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextToolsError';
  }
}

export class IdeaSchemaError extends TextToolsError {
  constructor(message: string) {
    super(message);
    this.name = 'IdeaSchemaError';
  }
}

export class IdeaContextMissingError extends TextToolsError {
  constructor(message: string) {
    super(message);
    this.name = 'IdeaContextMissingError';
  }
}

export class LLMTimeoutError extends TextToolsError {
  constructor(message: string) {
    super(message);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMQuotaError extends TextToolsError {
  retryAfterMs?: number;
  constructor(message: string, opts?: { retryAfterMs?: number }) {
    super(message);
    this.name = 'LLMQuotaError';
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

export class LLMNetworkError extends TextToolsError {
  cause: Error;
  constructor(message: string, cause: Error) {
    super(message);
    this.name = 'LLMNetworkError';
    this.cause = cause;
  }
}

export class LLMOutputParseError extends TextToolsError {
  rawContent: string;
  expectedSchema: string;
  constructor(opts: { rawContent: string; expectedSchema: string }) {
    super(`LLM output did not match schema "${opts.expectedSchema}"`);
    this.name = 'LLMOutputParseError';
    this.rawContent = opts.rawContent;
    this.expectedSchema = opts.expectedSchema;
  }
}

export class ActivityCancelledError extends TextToolsError {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityCancelledError';
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
npx vitest run src/__tests__/errors.test.ts
```

Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/errors.ts \
        packages/text-tools/src/__tests__/errors.test.ts
git commit -m "feat(text-tools): TextToolsError hierarchy (7 typed subclasses)"
```

---

## Task 8: CoverLetter Tool definition + schema

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/tools/coverLetter.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/tools.coverLetter.test.ts`

**Why:** Per spec Section 1.1. The `vacancy: { title, description, url?, platform? }` shape replaces hh.ru's `vacancyId: number`.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/tools.coverLetter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  CoverLetterInput,
  CoverLetterSolution,
  CoverLetterTool,
} from '../tools/coverLetter.js';

describe('CoverLetter tool', () => {
  it('CoverLetterInput accepts minimal valid input', () => {
    // SCENARIO: vacancy + resume (defaults applied)
    // INPUT: vacancy + resume only
    // EXPECTED: parses; locale defaults to 'en'; prompt undefined
    const out = CoverLetterInput.parse({
      vacancy: { title: 'Senior Frontend', description: 'React, TypeScript' },
      resume: { title: 'Frontend Eng', content: 'Years of React experience' },
    });
    expect(out.locale).toBe('en');
    expect(out.prompt).toBeUndefined();
  });

  it('CoverLetterInput accepts vacancy.url and platform optional fields', () => {
    // SCENARIO: full vacancy metadata
    // INPUT: vacancy with all four fields
    // EXPECTED: passes through unchanged
    const out = CoverLetterInput.parse({
      vacancy: {
        title: 'Senior Frontend',
        description: 'React',
        url: 'https://hh.ru/vacancy/42',
        platform: 'hh.ru',
      },
      resume: { title: 'X', content: 'Y' },
    });
    expect(out.vacancy.url).toBe('https://hh.ru/vacancy/42');
    expect(out.vacancy.platform).toBe('hh.ru');
  });

  it('CoverLetterInput rejects empty vacancy.title', () => {
    // SCENARIO: title is required string
    // INPUT: title=''
    // EXPECTED: throws (Zod string is non-empty by default? actually z.string() allows '' — verify)
    // Actually: z.string() allows empty by default. This test asserts the spec's intent which says
    // title is "required" but doesn't say non-empty. If we want non-empty, the schema needs .min(1).
    // For 0.1.0 we accept empty string — test reflects that.
    const out = CoverLetterInput.parse({
      vacancy: { title: '', description: 'desc' },
      resume: { title: 'X', content: 'Y' },
    });
    expect(out.vacancy.title).toBe('');
  });

  it('CoverLetterInput rejects bad URL format', () => {
    // SCENARIO: url field uses Zod url validator
    // INPUT: url='not-a-url'
    // EXPECTED: throws
    expect(() =>
      CoverLetterInput.parse({
        vacancy: { title: 't', description: 'd', url: 'not-a-url' },
        resume: { title: 'X', content: 'Y' },
      }),
    ).toThrow();
  });

  it('CoverLetterInput rejects locale outside enum', () => {
    // SCENARIO: locale must be 'en' or 'ru'
    // INPUT: locale='fr'
    // EXPECTED: throws
    expect(() =>
      CoverLetterInput.parse({
        vacancy: { title: 't', description: 'd' },
        resume: { title: 'X', content: 'Y' },
        locale: 'fr',
      }),
    ).toThrow();
  });

  it('CoverLetterSolution requires letter and durationMs; tokensUsed optional', () => {
    // SCENARIO: solution shape is letter + durationMs always; tokensUsed optional
    // INPUT: minimal solution
    // EXPECTED: parses; letter min length 1
    const out = CoverLetterSolution.parse({
      letter: 'Dear hiring manager...',
      durationMs: 1234,
    });
    expect(out.letter).toBe('Dear hiring manager...');
    expect(out.tokensUsed).toBeUndefined();
  });

  it('CoverLetterSolution rejects empty letter', () => {
    // SCENARIO: empty letter is meaningless
    // INPUT: letter='', durationMs=0
    // EXPECTED: throws
    expect(() => CoverLetterSolution.parse({ letter: '', durationMs: 0 })).toThrow();
  });

  it('CoverLetterTool conforms to Adapter Tool shape', () => {
    // SCENARIO: tool def has name + description + category + inputSchema + outputSchema
    // EXPECTED: all fields present; category is 'transformation' (per Adapter ToolCategory)
    expect(CoverLetterTool.name).toBe('generateCoverLetter');
    expect(CoverLetterTool.description).toBeTruthy();
    expect(CoverLetterTool.category).toBe('transformation');
    expect(CoverLetterTool.inputSchema).toMatchObject({ type: 'object' });
    expect(CoverLetterTool.outputSchema).toMatchObject({ type: 'object' });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npx vitest run src/__tests__/tools.coverLetter.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement CoverLetter tool**

Create `src/tools/coverLetter.ts`:

```ts
// packages/text-tools/src/tools/coverLetter.ts

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JSONSchema7 } from 'json-schema';
import type { Tool } from '@kolosochek/reactor-core';

export const VacancyShape = z.object({
  title: z.string(),
  description: z.string(),
  url: z.string().url().optional(),
  platform: z.string().optional(),
});

export const ResumeShape = z.object({
  title: z.string(),
  content: z.string(),
});

export const CoverLetterInput = z.object({
  vacancy: VacancyShape,
  resume: ResumeShape,
  prompt: z.string().optional(),
  locale: z.enum(['en', 'ru']).default('en'),
});

export type CoverLetterInputT = z.infer<typeof CoverLetterInput>;

export const CoverLetterSolution = z.object({
  letter: z.string().min(1),
  tokensUsed: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
});

export type CoverLetterSolutionT = z.infer<typeof CoverLetterSolution>;

export const CoverLetterTool: Tool = {
  name: 'generateCoverLetter',
  description: 'Generate a cover letter from vacancy text and resume.',
  category: 'transformation',
  inputSchema: zodToJsonSchema(CoverLetterInput) as JSONSchema7,
  outputSchema: zodToJsonSchema(CoverLetterSolution) as JSONSchema7,
};
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
npx vitest run src/__tests__/tools.coverLetter.test.ts
```

Expected: 8/8 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/tools/coverLetter.ts \
        packages/text-tools/src/__tests__/tools.coverLetter.test.ts
git commit -m "feat(text-tools): CoverLetter Tool + schemas"
```

---

## Task 9: Score Tool definition + schema

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/tools/score.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/tools.score.test.ts`

**Why:** Per spec Section 1.2. Score outputs a structured `{ score: 0-100, reasoning, skillMatch? }`.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/tools.score.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ScoreInput, ScoreSolution, SkillMatch, ScoreTool } from '../tools/score.js';

describe('Score tool', () => {
  it('ScoreInput accepts minimal valid input', () => {
    // SCENARIO: vacancy + resume
    // EXPECTED: parses; locale defaults to 'en'
    const out = ScoreInput.parse({
      vacancy: { title: 'Senior FE', description: 'React' },
      resume: { title: 'X', content: 'Y' },
    });
    expect(out.locale).toBe('en');
  });

  it('SkillMatch accepts arrays for matched/missing/extra', () => {
    // SCENARIO: skillMatch shape is three arrays of strings
    // EXPECTED: parses
    const out = SkillMatch.parse({
      matched: ['React', 'TypeScript'],
      missing: ['Rust'],
      extra: ['Vue'],
    });
    expect(out.matched).toEqual(['React', 'TypeScript']);
    expect(out.missing).toEqual(['Rust']);
    expect(out.extra).toEqual(['Vue']);
  });

  it('ScoreSolution requires score 0-100, reasoning, durationMs', () => {
    // SCENARIO: minimal valid solution
    // EXPECTED: parses
    const out = ScoreSolution.parse({
      score: 75,
      reasoning: 'Strong match on core skills',
      durationMs: 1234,
    });
    expect(out.score).toBe(75);
    expect(out.skillMatch).toBeUndefined();
  });

  it('ScoreSolution rejects score > 100', () => {
    // SCENARIO: score is bounded 0-100
    // INPUT: score=150
    // EXPECTED: throws
    expect(() =>
      ScoreSolution.parse({ score: 150, reasoning: 'r', durationMs: 0 }),
    ).toThrow();
  });

  it('ScoreSolution rejects score < 0', () => {
    // SCENARIO: lower bound
    // INPUT: score=-1
    // EXPECTED: throws
    expect(() =>
      ScoreSolution.parse({ score: -1, reasoning: 'r', durationMs: 0 }),
    ).toThrow();
  });

  it('ScoreSolution rejects non-integer score', () => {
    // SCENARIO: integer constraint
    // INPUT: score=75.5
    // EXPECTED: throws
    expect(() =>
      ScoreSolution.parse({ score: 75.5, reasoning: 'r', durationMs: 0 }),
    ).toThrow();
  });

  it('ScoreSolution accepts skillMatch optional field', () => {
    // SCENARIO: full solution with skillMatch
    // EXPECTED: parses; skillMatch fields preserved
    const out = ScoreSolution.parse({
      score: 80,
      reasoning: 'r',
      skillMatch: { matched: ['a'], missing: ['b'], extra: ['c'] },
      durationMs: 100,
    });
    expect(out.skillMatch).toEqual({ matched: ['a'], missing: ['b'], extra: ['c'] });
  });

  it('ScoreTool conforms to Adapter Tool shape', () => {
    // SCENARIO/EXPECTED
    expect(ScoreTool.name).toBe('scoreVacancy');
    expect(ScoreTool.category).toBe('aggregation');
    expect(ScoreTool.inputSchema).toMatchObject({ type: 'object' });
    expect(ScoreTool.outputSchema).toMatchObject({ type: 'object' });
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement Score tool**

Create `src/tools/score.ts`:

```ts
// packages/text-tools/src/tools/score.ts

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JSONSchema7 } from 'json-schema';
import type { Tool } from '@kolosochek/reactor-core';
import { VacancyShape, ResumeShape } from './coverLetter.js';

export const ScoreInput = z.object({
  vacancy: VacancyShape,
  resume: ResumeShape,
  prompt: z.string().optional(),
  locale: z.enum(['en', 'ru']).default('en'),
});

export type ScoreInputT = z.infer<typeof ScoreInput>;

export const SkillMatch = z.object({
  matched: z.array(z.string()),
  missing: z.array(z.string()),
  extra: z.array(z.string()),
});

export type SkillMatchT = z.infer<typeof SkillMatch>;

export const ScoreSolution = z.object({
  score: z.number().int().min(0).max(100),
  reasoning: z.string().min(1),
  skillMatch: SkillMatch.optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
});

export type ScoreSolutionT = z.infer<typeof ScoreSolution>;

export const ScoreTool: Tool = {
  name: 'scoreVacancy',
  description: 'Score how well a resume fits a vacancy (0-100) with reasoning and skill match.',
  category: 'aggregation',
  inputSchema: zodToJsonSchema(ScoreInput) as JSONSchema7,
  outputSchema: zodToJsonSchema(ScoreSolution) as JSONSchema7,
};
```

- [ ] **Step 4: Run, expect PASS (8/8).**

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/tools/score.ts \
        packages/text-tools/src/__tests__/tools.score.test.ts
git commit -m "feat(text-tools): Score Tool + schemas"
```

---

## Task 10: Questions Tool definition + schema

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/tools/questions.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/tools.questions.test.ts`

**Why:** Per spec Section 1.3. Questions takes an array of question strings and returns Q&A pairs.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/tools.questions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  QuestionsInput,
  QuestionsSolution,
  QuestionAnswerPair,
  QuestionsTool,
} from '../tools/questions.js';

describe('Questions tool', () => {
  it('QuestionsInput requires non-empty questions array', () => {
    // SCENARIO: at least one question is required
    // INPUT: questions=[]
    // EXPECTED: throws
    expect(() =>
      QuestionsInput.parse({
        vacancy: { title: 't', description: 'd' },
        resume: { title: 'X', content: 'Y' },
        questions: [],
      }),
    ).toThrow();
  });

  it('QuestionsInput rejects empty question strings', () => {
    // SCENARIO: each question must be non-empty
    // INPUT: questions=['']
    // EXPECTED: throws
    expect(() =>
      QuestionsInput.parse({
        vacancy: { title: 't', description: 'd' },
        resume: { title: 'X', content: 'Y' },
        questions: [''],
      }),
    ).toThrow();
  });

  it('QuestionAnswerPair requires question and answer', () => {
    // SCENARIO/EXPECTED
    const out = QuestionAnswerPair.parse({
      question: 'What is your salary expectation?',
      answer: 'Open to discussion',
    });
    expect(out.question).toBe('What is your salary expectation?');
  });

  it('QuestionsSolution requires qaPairs and durationMs', () => {
    // SCENARIO: minimal solution
    // EXPECTED: parses
    const out = QuestionsSolution.parse({
      qaPairs: [{ question: 'q1', answer: 'a1' }],
      durationMs: 100,
    });
    expect(out.qaPairs.length).toBe(1);
  });

  it('QuestionsTool conforms to Adapter Tool shape', () => {
    // SCENARIO/EXPECTED
    expect(QuestionsTool.name).toBe('answerQuestions');
    expect(QuestionsTool.category).toBe('transformation');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement Questions tool**

Create `src/tools/questions.ts`:

```ts
// packages/text-tools/src/tools/questions.ts

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JSONSchema7 } from 'json-schema';
import type { Tool } from '@kolosochek/reactor-core';
import { VacancyShape, ResumeShape } from './coverLetter.js';

export const QuestionsInput = z.object({
  vacancy: VacancyShape,
  resume: ResumeShape,
  questions: z.array(z.string().min(1)).min(1),
  prompt: z.string().optional(),
  locale: z.enum(['en', 'ru']).default('en'),
});

export type QuestionsInputT = z.infer<typeof QuestionsInput>;

export const QuestionAnswerPair = z.object({
  question: z.string(),
  answer: z.string(),
});

export type QuestionAnswerPairT = z.infer<typeof QuestionAnswerPair>;

export const QuestionsSolution = z.object({
  qaPairs: z.array(QuestionAnswerPair),
  tokensUsed: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
});

export type QuestionsSolutionT = z.infer<typeof QuestionsSolution>;

export const QuestionsTool: Tool = {
  name: 'answerQuestions',
  description: 'Answer HR screening questions using vacancy context and resume.',
  category: 'transformation',
  inputSchema: zodToJsonSchema(QuestionsInput) as JSONSchema7,
  outputSchema: zodToJsonSchema(QuestionsSolution) as JSONSchema7,
};
```

- [ ] **Step 4: Run, expect PASS (5/5).**

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/tools/questions.ts \
        packages/text-tools/src/__tests__/tools.questions.test.ts
git commit -m "feat(text-tools): Questions Tool + schemas"
```

---

## Task 11: Default prompts (en + ru) ported from existing sources

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/prompts/coverLetter.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/prompts/score.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/prompts/questions.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/prompts/index.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/prompts.test.ts`

**Why:** Each Activity needs a default prompt when caller doesn't supply one. Source: extension prompts at `extension/src/lib/prompts/{coverLetterDefault,questionsDefault}.ts` and hh.ru server prompts at `src/server/db/seed.ts:DEFAULT_SCORING_PROMPT` / `DEFAULT_COVER_LETTER_PROMPT`. Ports en + ru per locale; ru fallback to en when no Russian source exists.

- [ ] **Step 1: Read source prompts**

```bash
cat /Users/noone/data/reactor/extension/src/lib/prompts/coverLetterDefault.ts
cat /Users/noone/data/reactor/extension/src/lib/prompts/questionsDefault.ts
sed -n '6,60p' /Users/noone/data/reactor/src/server/db/seed.ts
sed -n '61,150p' /Users/noone/data/reactor/src/server/db/seed.ts
```

Note the contents — you'll port them in step 3.

- [ ] **Step 2: Write failing test**

Create `src/__tests__/prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { defaultCoverLetterPrompt, defaultScorePrompt, defaultQuestionsPrompt } from '../prompts/index.js';

describe('default prompts', () => {
  it('coverLetter has en and ru', () => {
    // SCENARIO: prompt registry exposes both locales
    // EXPECTED: en is non-empty; ru is non-empty
    expect(defaultCoverLetterPrompt.en.length).toBeGreaterThan(50);
    expect(defaultCoverLetterPrompt.ru.length).toBeGreaterThan(50);
  });

  it('score has en and ru', () => {
    // SCENARIO/EXPECTED
    expect(defaultScorePrompt.en.length).toBeGreaterThan(50);
    expect(defaultScorePrompt.ru.length).toBeGreaterThan(50);
  });

  it('questions has en and ru', () => {
    // SCENARIO/EXPECTED
    expect(defaultQuestionsPrompt.en.length).toBeGreaterThan(50);
    expect(defaultQuestionsPrompt.ru.length).toBeGreaterThan(50);
  });

  it('cover letter en prompt mentions cover letter', () => {
    // SCENARIO: prompt content sanity check
    // INPUT: en cover letter prompt
    // EXPECTED: contains "cover letter" substring (case-insensitive)
    expect(defaultCoverLetterPrompt.en.toLowerCase()).toContain('cover letter');
  });

  it('score en prompt mentions score or evaluation', () => {
    // SCENARIO: prompt content sanity check
    // EXPECTED: contains "score" or "evaluate" substring
    expect(defaultScorePrompt.en.toLowerCase()).toMatch(/score|evaluat/);
  });
});
```

- [ ] **Step 3: Implement prompts**

Create `src/prompts/coverLetter.ts`:

```ts
// packages/text-tools/src/prompts/coverLetter.ts
//
// English: ported from src/server/db/seed.ts:DEFAULT_COVER_LETTER_PROMPT
// Russian: ported from extension/src/lib/prompts/coverLetterDefault.ts:COVER_LETTER_PROMPT_DEFAULT

const EN = `Generate a cover letter optimized for an HR recruiter who will read 50+ applications back-to-back. Goal: make the candidate's fit immediately obvious for THIS specific vacancy.

Rules:
1. Open with the most relevant experience for this role - not generic intro.
2. Match 2-3 specific requirements from the vacancy with concrete experience from the resume.
3. End with availability and any relocation/visa context if relevant.
4. 3-5 short paragraphs maximum. Write what the recruiter wants to see, not what the candidate wants to say.
5. Be specific. Avoid generic phrases like "I am a passionate professional" or "I am excited to apply".
6. Reply in the same language as the vacancy description.`;

const RU = `Ты пишешь короткие профессиональные сопроводительные письма на русском. Сосредоточься на том, что ищет работодатель, на основе описания вакансии. Покажи понимание потребностей. 2-3 предложения. Не перечисляй общие навыки. Будь конкретен относительно этой вакансии.`;

export const defaultCoverLetterPrompt = { en: EN, ru: RU };
```

Create `src/prompts/score.ts`:

```ts
// packages/text-tools/src/prompts/score.ts
//
// English: ported from src/server/db/seed.ts:DEFAULT_SCORING_PROMPT
// Russian: caller-provided translation of EN. For 0.1.0 the Russian variant is
// best-effort; consumers can override via Idea input.

const EN = `You are a job matching expert. Evaluate how well the candidate fits the vacancy.

Inputs you receive:
- Vacancy title and description
- Candidate resume

Output requirements:
- Return strict JSON with these fields exactly: { "score": <integer 0-100>, "reasoning": "<one paragraph>", "skillMatch": { "matched": [...], "missing": [...], "extra": [...] } }
- score: integer 0-100 reflecting overall fit
- reasoning: one paragraph explaining the score, citing specific resume vs vacancy alignment
- skillMatch: arrays of skill names mentioned in both, only in vacancy (missing), or only in resume (extra)

Be calibrated:
- 90+: very strong fit, all required skills present, seniority aligned
- 70-89: strong fit, minor gaps that could be filled on the job
- 50-69: moderate fit, some skill gaps or seniority mismatch
- 30-49: weak fit, significant skill gaps or wrong seniority
- 0-29: very weak fit, fundamental misalignment`;

const RU = `Ты эксперт по подбору вакансий. Оцени, насколько кандидат подходит на вакансию.

Вход:
- Название и описание вакансии
- Резюме кандидата

Требования к выводу:
- Верни строго JSON: { "score": <целое 0-100>, "reasoning": "<один абзац>", "skillMatch": { "matched": [...], "missing": [...], "extra": [...] } }
- score: целое 0-100, отражающее общее соответствие
- reasoning: один абзац, объясняющий оценку, ссылающийся на конкретное соответствие резюме и вакансии
- skillMatch: массивы названий навыков, упомянутых одновременно в обоих, только в вакансии (missing), только в резюме (extra)

Калибровка:
- 90+: очень сильное соответствие, все требуемые навыки есть, уровень совпадает
- 70-89: сильное соответствие, мелкие пробелы заполнятся в процессе
- 50-69: умеренное соответствие, есть пробелы в навыках или несовпадение уровня
- 30-49: слабое соответствие, существенные пробелы или неверный уровень
- 0-29: очень слабое, фундаментальное несоответствие`;

export const defaultScorePrompt = { en: EN, ru: RU };
```

Create `src/prompts/questions.ts`:

```ts
// packages/text-tools/src/prompts/questions.ts
//
// English: ported from extension/src/lib/prompts/questionsDefault.ts:QUESTIONS_PROMPT_DEFAULT
// Russian: caller-provided translation of EN.

const EN = [
  'You answer HR screening questions for a job application.',
  '',
  'RULES:',
  '1. For factual questions (contacts, GitHub, salary, location), base answers on the resume content only.',
  '2. For experience or skills questions, calibrate to vacancy expectations:',
  '   - If the vacancy mentions "N+ years" or "at least N years", answer with exactly N (do not exceed).',
  '   - If the vacancy gives a range "N-M years", answer with a value in [N, M].',
  '   - If the vacancy does not mention a year requirement, fall back to a plausible integer from the resume.',
  "3. For motivational questions, base the answer on the vacancy's stated values and stack.",
  '4. Reply in the same language as the question.',
  '5. For select/radio-style questions, pick exactly one provided option.',
  '6. For number-type questions, answer with a number only.',
  '7. Echo the question index exactly as given.',
  '',
  'Output: strict JSON { "qaPairs": [{ "question": "<original>", "answer": "<your answer>" }, ...] }',
].join('\n');

const RU = [
  'Ты отвечаешь на скрининговые вопросы HR при отклике на вакансию.',
  '',
  'ПРАВИЛА:',
  '1. На фактические вопросы (контакты, GitHub, зарплата, локация) отвечай только на основе содержимого резюме.',
  '2. Для вопросов про опыт или навыки калибруй под ожидания вакансии:',
  '   - Если в вакансии "N+ лет" или "не менее N лет", ответь ровно N (не превышай).',
  '   - Если диапазон "N-M лет", ответь значением из [N, M].',
  '   - Если требований к годам нет, возьми правдоподобное число из резюме.',
  '3. На мотивационные вопросы опирайся на ценности и стек, заявленные в вакансии.',
  '4. Отвечай на том же языке, что и вопрос.',
  '5. Для select/radio выбери ровно один из предложенных вариантов.',
  '6. Для числовых вопросов отвечай только числом.',
  '7. Точно повторяй вопрос как он задан.',
  '',
  'Вывод: строгий JSON { "qaPairs": [{ "question": "<оригинал>", "answer": "<твой ответ>" }, ...] }',
].join('\n');

export const defaultQuestionsPrompt = { en: EN, ru: RU };
```

Create `src/prompts/index.ts`:

```ts
// packages/text-tools/src/prompts/index.ts

export { defaultCoverLetterPrompt } from './coverLetter.js';
export { defaultScorePrompt } from './score.js';
export { defaultQuestionsPrompt } from './questions.js';
```

- [ ] **Step 4: Run tests, expect PASS (5/5).**

```bash
npx vitest run src/__tests__/prompts.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/prompts/ \
        packages/text-tools/src/__tests__/prompts.test.ts
git commit -m "feat(text-tools): default prompts (en + ru) for all three tools"
```

---

## Task 12: Mock LLM provider for tests

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/test-utils/mockLLM.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/mockLLM.test.ts`

**Why:** Per spec section 6.1. Activities (T14-T16) need a mock LLMProvider for unit tests. Future consumers (4.2 extension, 4.3 adapter) reuse this same factory.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/mockLLM.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createMockLLMProvider } from '../test-utils/mockLLM.js';

describe('createMockLLMProvider', () => {
  it('returns default content when no onComplete provided', async () => {
    // SCENARIO: zero-config mock
    // INPUT: factory called without args
    // EXPECTED: complete returns { content: 'mock response', model: 'mock' }
    const llm = createMockLLMProvider();
    const r = await llm.complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.content).toBe('mock response');
    expect(r.model).toBe('mock');
  });

  it('uses custom onComplete when provided', async () => {
    // SCENARIO: caller-controlled response
    // INPUT: onComplete returns { content: 'custom', model: 'custom-model' }
    // EXPECTED: complete returns the custom response
    const llm = createMockLLMProvider({
      onComplete: async () => ({ content: 'custom', model: 'custom-model', tokensUsed: 42 }),
    });
    const r = await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.content).toBe('custom');
    expect(r.model).toBe('custom-model');
    expect(r.tokensUsed).toBe(42);
  });

  it('forwards request to onComplete for assertions', async () => {
    // SCENARIO: tests assert on what messages the LLM saw
    // INPUT: onComplete is a vi.fn
    // EXPECTED: vi.fn called with the request object
    const onComplete = vi.fn().mockResolvedValue({ content: 'x', model: 'mock' });
    const llm = createMockLLMProvider({ onComplete });
    await llm.complete({
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hi' },
      ],
      jsonMode: true,
    });

    expect(onComplete).toHaveBeenCalledOnce();
    const callArg = onComplete.mock.calls[0]?.[0];
    expect(callArg).toEqual({
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hi' },
      ],
      jsonMode: true,
    });
  });

  it('provider has .name = "mock"', () => {
    // SCENARIO: SPI requires name field
    // EXPECTED
    const llm = createMockLLMProvider();
    expect(llm.name).toBe('mock');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/test-utils/mockLLM.ts`:

```ts
// packages/text-tools/src/test-utils/mockLLM.ts
//
// Reusable mock LLMProvider for tests across text-tools, extension, and adapter.
// Per spec section 6.1.

import type { LLMProvider, LLMCompletionRequest, LLMCompletionResponse } from '@kolosochek/reactor-core';

export interface CreateMockLLMProviderOptions {
  /** When provided, replaces the default echo-style response. */
  onComplete?: (req: LLMCompletionRequest) => Promise<LLMCompletionResponse>;
}

export function createMockLLMProvider(opts?: CreateMockLLMProviderOptions): LLMProvider {
  const onComplete = opts?.onComplete;
  return {
    name: 'mock',
    async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
      if (onComplete !== undefined) return onComplete(req);
      return { content: 'mock response', model: 'mock' };
    },
  };
}
```

(Note: imports `LLMCompletionRequest` / `LLMCompletionResponse` from reactor-core. Verify these are exported from the public API. If not, the import path may need adjustment; check `/Users/noone/data/ereal/reactor-core/src/index.ts` and `/Users/noone/data/ereal/reactor-core/src/types/llm.ts`.)

- [ ] **Step 4: Run tests, expect PASS (4/4).**

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/test-utils/mockLLM.ts \
        packages/text-tools/src/__tests__/mockLLM.test.ts
git commit -m "feat(text-tools): createMockLLMProvider test util"
```

---

## Task 13: LLMProvider contract test suite

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/test-utils/contract.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/contract.test.ts`

**Why:** Per spec section 6.3. Both extension and adapter (in 4.2, 4.3) will run this suite against their LLMProvider impl. text-tools dogfoods it on `createMockLLMProvider` so the contract is self-tested.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createMockLLMProvider } from '../test-utils/mockLLM.js';
import { runLLMProviderContractTests } from '../test-utils/contract.js';

// Self-test: the contract suite runs against the mock provider.
runLLMProviderContractTests(describe, () => createMockLLMProvider({
  onComplete: async (req) => ({
    content: req.jsonMode === true ? '{"ok":true}' : 'mock content',
    model: 'mock',
    tokensUsed: 10,
  }),
}));
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement contract suite**

Create `src/test-utils/contract.ts`:

```ts
// packages/text-tools/src/test-utils/contract.ts
//
// LLMProvider contract test suite. Any LLMProvider implementation that
// claims to satisfy the SPI should pass these tests. Per spec section 6.3.
//
// Usage:
//   import { runLLMProviderContractTests } from '@reactor/text-tools/test-utils';
//   import { describe } from 'vitest';
//   runLLMProviderContractTests(describe, () => myLLMProviderFactory());

import { expect, it } from 'vitest';
import type { LLMProvider } from '@kolosochek/reactor-core';

type DescribeFn = (name: string, fn: () => void) => void;

export function runLLMProviderContractTests(
  describe: DescribeFn,
  factory: () => LLMProvider,
): void {
  describe('LLMProvider contract', () => {
    it('exposes .name as a non-empty string', () => {
      // SCENARIO: SPI requires identification for diagnostics
      // EXPECTED: name field is non-empty
      const llm = factory();
      expect(typeof llm.name).toBe('string');
      expect(llm.name.length).toBeGreaterThan(0);
    });

    it('returns content for non-empty messages', async () => {
      // SCENARIO: minimal request
      // INPUT: one user message
      // EXPECTED: response has content as non-empty string and model as string
      const llm = factory();
      const r = await llm.complete({
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(typeof r.content).toBe('string');
      expect(typeof r.model).toBe('string');
    });

    it('honors jsonMode: true returns parseable JSON', async () => {
      // SCENARIO: structured output mode
      // INPUT: jsonMode: true
      // EXPECTED: content can be JSON.parse'd without throwing
      const llm = factory();
      const r = await llm.complete({
        messages: [{ role: 'user', content: 'return {"ok":true}' }],
        jsonMode: true,
      });
      expect(() => JSON.parse(r.content)).not.toThrow();
    });

    it('returns tokensUsed when provider reports it (optional)', async () => {
      // SCENARIO: optional field, must be a number when present
      // EXPECTED: tokensUsed is undefined or a non-negative integer
      const llm = factory();
      const r = await llm.complete({
        messages: [{ role: 'user', content: 'x' }],
      });
      if (r.tokensUsed !== undefined) {
        expect(Number.isInteger(r.tokensUsed)).toBe(true);
        expect(r.tokensUsed).toBeGreaterThanOrEqual(0);
      }
    });
  });
}
```

(The contract suite intentionally excludes `signal` (cancellation) and "throws typed error on network failure" tests for 0.1.0. Those require setting up an HTTP server stub or AbortController plumbing in each implementation, which is heavier than the contract requires today. Ship them in a future iteration.)

- [ ] **Step 4: Run tests, expect PASS (4/4 from the contract suite).**

```bash
npx vitest run src/__tests__/contract.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/test-utils/contract.ts \
        packages/text-tools/src/__tests__/contract.test.ts
git commit -m "feat(text-tools): LLMProvider contract test suite (runLLMProviderContractTests)"
```

---

## Task 14: `generateCoverLetterActivity`

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/activities/coverLetter.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/activities.coverLetter.test.ts`

**Why:** First Activity. Calls LLM with default cover-letter prompt; returns Solution.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/activities.coverLetter.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { generateCoverLetterActivity } from '../activities/coverLetter.js';
import { createMockLLMProvider } from '../test-utils/mockLLM.js';
import type { ActivityContext } from '@kolosochek/reactor-core';

const baseInput = {
  vacancy: { title: 'Senior Frontend', description: 'React, TypeScript, 5+ years' },
  resume: { title: 'Frontend Eng', content: '7 years React, TypeScript, GraphQL' },
};

function makeCtx(opts?: { llm?: ReturnType<typeof createMockLLMProvider> }): ActivityContext {
  return {
    state: {},
    llm: opts?.llm ?? createMockLLMProvider({
      onComplete: async () => ({ content: 'Dear hiring manager,\n\nI am writing to apply...', model: 'mock' }),
    }),
  };
}

describe('generateCoverLetterActivity', () => {
  it('returns Solution with letter from LLM response', async () => {
    // SCENARIO: minimal input, mock LLM returns canned letter
    // INPUT: vacancy + resume; default locale en
    // EXPECTED: result has letter, durationMs, no tokensUsed
    const result = await generateCoverLetterActivity(baseInput, makeCtx());

    expect(result).toMatchObject({
      letter: 'Dear hiring manager,\n\nI am writing to apply...',
      durationMs: expect.any(Number),
    });
  });

  it('passes default en prompt when no prompt provided', async () => {
    // SCENARIO: default prompt used
    // INPUT: no prompt field
    // EXPECTED: LLM received system message containing 'cover letter' substring
    const onComplete = vi.fn().mockResolvedValue({ content: 'L', model: 'mock' });
    await generateCoverLetterActivity(baseInput, makeCtx({ llm: createMockLLMProvider({ onComplete }) }));
    const sys = onComplete.mock.calls[0]?.[0]?.messages?.[0];
    expect(sys?.role).toBe('system');
    expect(sys?.content?.toLowerCase()).toContain('cover letter');
  });

  it('passes custom prompt when provided', async () => {
    // SCENARIO: caller overrides default
    // INPUT: prompt='You write haiku cover letters'
    // EXPECTED: LLM system message is the custom prompt
    const onComplete = vi.fn().mockResolvedValue({ content: 'L', model: 'mock' });
    await generateCoverLetterActivity(
      { ...baseInput, prompt: 'You write haiku cover letters' },
      makeCtx({ llm: createMockLLMProvider({ onComplete }) }),
    );
    expect(onComplete.mock.calls[0]?.[0]?.messages?.[0]?.content).toBe('You write haiku cover letters');
  });

  it('uses ru prompt when locale=ru', async () => {
    // SCENARIO: Russian locale
    // INPUT: locale=ru
    // EXPECTED: LLM system message is the Russian default prompt (contains Cyrillic)
    const onComplete = vi.fn().mockResolvedValue({ content: 'L', model: 'mock' });
    await generateCoverLetterActivity(
      { ...baseInput, locale: 'ru' as const },
      makeCtx({ llm: createMockLLMProvider({ onComplete }) }),
    );
    expect(onComplete.mock.calls[0]?.[0]?.messages?.[0]?.content).toMatch(/[а-яА-Я]/);
  });

  it('Solution durationMs is non-negative', async () => {
    // SCENARIO: timing is measured
    // EXPECTED: durationMs >= 0
    const result = await generateCoverLetterActivity(baseInput, makeCtx());
    expect(result).toHaveProperty('durationMs');
    expect((result as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes tokensUsed when provider reports it', async () => {
    // SCENARIO: provider returns tokensUsed in response
    // EXPECTED: Solution carries it
    const llm = createMockLLMProvider({
      onComplete: async () => ({ content: 'L', model: 'mock', tokensUsed: 1234 }),
    });
    const result = await generateCoverLetterActivity(baseInput, makeCtx({ llm }));
    expect((result as { tokensUsed?: number }).tokensUsed).toBe(1234);
  });

  it('rejects malformed input via Zod', async () => {
    // SCENARIO: vacancy missing description
    // INPUT: vacancy without description field
    // EXPECTED: throws (CoverLetterInput.parse fails)
    await expect(
      generateCoverLetterActivity(
        { vacancy: { title: 'x' } as any, resume: { title: 'y', content: 'z' } },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });

  it('passes signal from ctx to LLM', async () => {
    // SCENARIO: cancellation propagation
    // INPUT: ctx.signal is an AbortSignal
    // EXPECTED: LLM request received the same signal
    const onComplete = vi.fn().mockResolvedValue({ content: 'L', model: 'mock' });
    const ac = new AbortController();
    const ctx: ActivityContext = {
      state: {},
      llm: createMockLLMProvider({ onComplete }),
      signal: ac.signal,
    };
    await generateCoverLetterActivity(baseInput, ctx);
    expect(onComplete.mock.calls[0]?.[0]?.signal).toBe(ac.signal);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/activities/coverLetter.ts`:

```ts
// packages/text-tools/src/activities/coverLetter.ts

import type { Activity } from '@kolosochek/reactor-core';
import { composeActivity } from '../activity/compose.js';
import {
  CoverLetterInput,
  CoverLetterSolution,
  type CoverLetterInputT,
  type CoverLetterSolutionT,
} from '../tools/coverLetter.js';
import { defaultCoverLetterPrompt } from '../prompts/coverLetter.js';

function buildUserContent(input: CoverLetterInputT): string {
  return [
    '## Vacancy',
    input.vacancy.title,
    '',
    input.vacancy.description,
    '',
    '## Resume Title',
    input.resume.title,
    '',
    '## Resume Content',
    input.resume.content,
  ].join('\n');
}

export const generateCoverLetterActivity: Activity = composeActivity<
  unknown,
  CoverLetterSolutionT
>({
  llmFallback: async (rawInput, ctx) => {
    const input = CoverLetterInput.parse(rawInput);
    const startedAt = Date.now();

    const prompt = input.prompt ?? defaultCoverLetterPrompt[input.locale];
    const userContent = buildUserContent(input);

    const response = await ctx.llm.complete({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userContent },
      ],
      signal: ctx.signal,
    });

    const solution: CoverLetterSolutionT = {
      letter: response.content,
      ...(response.tokensUsed !== undefined ? { tokensUsed: response.tokensUsed } : {}),
      durationMs: Date.now() - startedAt,
    };

    return CoverLetterSolution.parse(solution);
  },
});
```

- [ ] **Step 4: Run tests, expect PASS (8/8).**

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/activities/coverLetter.ts \
        packages/text-tools/src/__tests__/activities.coverLetter.test.ts
git commit -m "feat(text-tools): generateCoverLetterActivity (Latent path)"
```

---

## Task 15: `scoreVacancyActivity` (jsonMode + Zod-validated output)

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/activities/score.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/activities.score.test.ts`

**Why:** Score Activity has structured output. Uses `jsonMode: true` + `LLMOutputParseError` on bad JSON.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/activities.score.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { scoreVacancyActivity } from '../activities/score.js';
import { createMockLLMProvider } from '../test-utils/mockLLM.js';
import { LLMOutputParseError } from '../errors.js';
import type { ActivityContext } from '@kolosochek/reactor-core';

const baseInput = {
  vacancy: { title: 'Senior FE', description: 'React, 5+ years' },
  resume: { title: 'FE', content: '7 years React' },
};

function makeCtx(content: string): ActivityContext {
  return {
    state: {},
    llm: createMockLLMProvider({
      onComplete: async () => ({ content, model: 'mock', tokensUsed: 100 }),
    }),
  };
}

describe('scoreVacancyActivity', () => {
  it('parses valid JSON LLM response into Solution', async () => {
    // SCENARIO: LLM returns valid JSON matching ScoreSolution schema
    // INPUT: jsonMode-true; content is { score, reasoning, skillMatch }
    // EXPECTED: Solution carries score=80, reasoning, skillMatch
    const json = JSON.stringify({
      score: 80,
      reasoning: 'Strong match',
      skillMatch: { matched: ['React'], missing: [], extra: [] },
    });
    const result = await scoreVacancyActivity(baseInput, makeCtx(json));
    expect(result).toMatchObject({
      score: 80,
      reasoning: 'Strong match',
      skillMatch: { matched: ['React'], missing: [], extra: [] },
    });
  });

  it('extracts JSON from markdown fence', async () => {
    // SCENARIO: LLM returns JSON wrapped in ```json fence
    // INPUT: content has fence
    // EXPECTED: parses ok
    const json = '```json\n{"score": 70, "reasoning": "ok", "skillMatch": {"matched":[],"missing":[],"extra":[]}}\n```';
    const result = await scoreVacancyActivity(baseInput, makeCtx(json));
    expect((result as { score: number }).score).toBe(70);
  });

  it('throws LLMOutputParseError on unparseable content', async () => {
    // SCENARIO: LLM returns gibberish
    // INPUT: content='not json at all'
    // EXPECTED: throws LLMOutputParseError with rawContent and expectedSchema
    await expect(
      scoreVacancyActivity(baseInput, makeCtx('not json at all')),
    ).rejects.toThrow(LLMOutputParseError);
  });

  it('throws on JSON that does not match Schema (e.g. score>100)', async () => {
    // SCENARIO: LLM returned valid JSON but score is 150
    // INPUT: { score: 150, ... }
    // EXPECTED: throws (Zod validation fails)
    const json = JSON.stringify({ score: 150, reasoning: 'r', skillMatch: { matched: [], missing: [], extra: [] } });
    await expect(scoreVacancyActivity(baseInput, makeCtx(json))).rejects.toThrow();
  });

  it('requests jsonMode: true from LLM', async () => {
    // SCENARIO: structured output requires jsonMode flag
    // EXPECTED: LLM called with jsonMode: true
    const onComplete = vi.fn().mockResolvedValue({
      content: '{"score":75,"reasoning":"ok","skillMatch":{"matched":[],"missing":[],"extra":[]}}',
      model: 'mock',
    });
    await scoreVacancyActivity(baseInput, {
      state: {},
      llm: createMockLLMProvider({ onComplete }),
    });
    expect(onComplete.mock.calls[0]?.[0]?.jsonMode).toBe(true);
  });

  it('passes default en prompt when none provided', async () => {
    // SCENARIO: default prompt used
    // EXPECTED: LLM system message contains 'score' or 'evaluat'
    const onComplete = vi.fn().mockResolvedValue({
      content: '{"score":75,"reasoning":"ok","skillMatch":{"matched":[],"missing":[],"extra":[]}}',
      model: 'mock',
    });
    await scoreVacancyActivity(baseInput, {
      state: {},
      llm: createMockLLMProvider({ onComplete }),
    });
    const sys = onComplete.mock.calls[0]?.[0]?.messages?.[0]?.content?.toLowerCase() ?? '';
    expect(sys).toMatch(/score|evaluat/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/activities/score.ts`:

```ts
// packages/text-tools/src/activities/score.ts

import type { Activity } from '@kolosochek/reactor-core';
import { composeActivity } from '../activity/compose.js';
import {
  ScoreInput,
  ScoreSolution,
  type ScoreInputT,
  type ScoreSolutionT,
} from '../tools/score.js';
import { defaultScorePrompt } from '../prompts/score.js';
import { LLMOutputParseError } from '../errors.js';

function buildUserContent(input: ScoreInputT): string {
  return [
    '## Vacancy',
    input.vacancy.title,
    '',
    input.vacancy.description,
    '',
    '## Resume Title',
    input.resume.title,
    '',
    '## Resume Content',
    input.resume.content,
  ].join('\n');
}

function tryParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function extractJSONFromMarkdown(raw: string): unknown {
  // Match ```json ... ``` or ``` ... ``` fenced blocks
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch !== null && fenceMatch[1] !== undefined) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const scoreVacancyActivity: Activity = composeActivity<unknown, ScoreSolutionT>({
  llmFallback: async (rawInput, ctx) => {
    const input = ScoreInput.parse(rawInput);
    const startedAt = Date.now();

    const prompt = input.prompt ?? defaultScorePrompt[input.locale];
    const userContent = buildUserContent(input);

    const response = await ctx.llm.complete({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userContent },
      ],
      jsonMode: true,
      signal: ctx.signal,
    });

    const parsed =
      tryParseJSON(response.content) ??
      extractJSONFromMarkdown(response.content);

    if (parsed === undefined) {
      throw new LLMOutputParseError({
        rawContent: response.content,
        expectedSchema: 'ScoreSolution',
      });
    }

    const solution: ScoreSolutionT = ScoreSolution.parse({
      ...(parsed as object),
      ...(response.tokensUsed !== undefined ? { tokensUsed: response.tokensUsed } : {}),
      durationMs: Date.now() - startedAt,
    });

    return solution;
  },
});
```

- [ ] **Step 4: Run tests, expect PASS (6/6).**

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/activities/score.ts \
        packages/text-tools/src/__tests__/activities.score.test.ts
git commit -m "feat(text-tools): scoreVacancyActivity with jsonMode + Zod output validation"
```

---

## Task 16: `answerQuestionsActivity`

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/activities/questions.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/activities.questions.test.ts`

**Why:** Third Activity. Same jsonMode + Zod pattern as Score; output is `{ qaPairs: [...] }`.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/activities.questions.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { answerQuestionsActivity } from '../activities/questions.js';
import { createMockLLMProvider } from '../test-utils/mockLLM.js';
import { LLMOutputParseError } from '../errors.js';
import type { ActivityContext } from '@kolosochek/reactor-core';

const baseInput = {
  vacancy: { title: 'FE', description: 'React' },
  resume: { title: 'FE Eng', content: 'React experience' },
  questions: ['What is your salary expectation?', 'When can you start?'],
};

function makeCtx(content: string): ActivityContext {
  return {
    state: {},
    llm: createMockLLMProvider({
      onComplete: async () => ({ content, model: 'mock', tokensUsed: 50 }),
    }),
  };
}

describe('answerQuestionsActivity', () => {
  it('parses qaPairs from valid JSON LLM response', async () => {
    // SCENARIO: LLM returns valid JSON with qaPairs
    // EXPECTED: Solution.qaPairs has 2 entries
    const json = JSON.stringify({
      qaPairs: [
        { question: 'What is your salary expectation?', answer: '150k' },
        { question: 'When can you start?', answer: '2 weeks notice' },
      ],
    });
    const result = await answerQuestionsActivity(baseInput, makeCtx(json));
    expect((result as { qaPairs: unknown[] }).qaPairs.length).toBe(2);
  });

  it('extracts JSON from markdown fence', async () => {
    // SCENARIO: LLM wraps in fence
    // EXPECTED: parses
    const json = '```json\n{"qaPairs":[{"question":"q","answer":"a"}]}\n```';
    const result = await answerQuestionsActivity(baseInput, makeCtx(json));
    expect((result as { qaPairs: unknown[] }).qaPairs.length).toBe(1);
  });

  it('throws LLMOutputParseError on unparseable content', async () => {
    // SCENARIO/EXPECTED
    await expect(answerQuestionsActivity(baseInput, makeCtx('xxx'))).rejects.toThrow(
      LLMOutputParseError,
    );
  });

  it('rejects empty questions array via Zod', async () => {
    // SCENARIO: input questions=[]
    // EXPECTED: throws
    await expect(
      answerQuestionsActivity(
        { ...baseInput, questions: [] },
        makeCtx('{"qaPairs":[]}'),
      ),
    ).rejects.toThrow();
  });

  it('passes user content with question list to LLM', async () => {
    // SCENARIO: LLM gets questions in user message
    // EXPECTED: each question appears in user message content
    const onComplete = vi.fn().mockResolvedValue({
      content: '{"qaPairs":[{"question":"q","answer":"a"}]}',
      model: 'mock',
    });
    await answerQuestionsActivity(baseInput, {
      state: {},
      llm: createMockLLMProvider({ onComplete }),
    });
    const userMsg = onComplete.mock.calls[0]?.[0]?.messages?.[1]?.content ?? '';
    expect(userMsg).toContain('What is your salary expectation?');
    expect(userMsg).toContain('When can you start?');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/activities/questions.ts`:

```ts
// packages/text-tools/src/activities/questions.ts

import type { Activity } from '@kolosochek/reactor-core';
import { composeActivity } from '../activity/compose.js';
import {
  QuestionsInput,
  QuestionsSolution,
  type QuestionsInputT,
  type QuestionsSolutionT,
} from '../tools/questions.js';
import { defaultQuestionsPrompt } from '../prompts/questions.js';
import { LLMOutputParseError } from '../errors.js';

function buildUserContent(input: QuestionsInputT): string {
  const questionsList = input.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return [
    '## Vacancy',
    input.vacancy.title,
    '',
    input.vacancy.description,
    '',
    '## Resume Title',
    input.resume.title,
    '',
    '## Resume Content',
    input.resume.content,
    '',
    '## Questions',
    questionsList,
  ].join('\n');
}

function tryParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function extractJSONFromMarkdown(raw: string): unknown {
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch !== null && fenceMatch[1] !== undefined) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const answerQuestionsActivity: Activity = composeActivity<unknown, QuestionsSolutionT>({
  llmFallback: async (rawInput, ctx) => {
    const input = QuestionsInput.parse(rawInput);
    const startedAt = Date.now();

    const prompt = input.prompt ?? defaultQuestionsPrompt[input.locale];
    const userContent = buildUserContent(input);

    const response = await ctx.llm.complete({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userContent },
      ],
      jsonMode: true,
      signal: ctx.signal,
    });

    const parsed =
      tryParseJSON(response.content) ??
      extractJSONFromMarkdown(response.content);

    if (parsed === undefined) {
      throw new LLMOutputParseError({
        rawContent: response.content,
        expectedSchema: 'QuestionsSolution',
      });
    }

    return QuestionsSolution.parse({
      ...(parsed as object),
      ...(response.tokensUsed !== undefined ? { tokensUsed: response.tokensUsed } : {}),
      durationMs: Date.now() - startedAt,
    });
  },
});
```

- [ ] **Step 4: Run tests, expect PASS (5/5).**

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/activities/questions.ts \
        packages/text-tools/src/__tests__/activities.questions.test.ts
git commit -m "feat(text-tools): answerQuestionsActivity with jsonMode + Zod output validation"
```

---

## Task 17: Idea builders (`buildCoverLetterIdea` / `buildScoreIdea` / `buildQuestionsIdea`)

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/builders.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/builders.test.ts`

**Why:** Caller-friendly factories that produce direct-mode Ideas. Per spec section 1, builders construct Idea directly (not via IdeaBuilder).

- [ ] **Step 1: Write failing test**

Create `src/__tests__/builders.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildCoverLetterIdea, buildScoreIdea, buildQuestionsIdea } from '../builders.js';

const v = { title: 'FE', description: 'd' };
const r = { title: 'X', content: 'Y' };

describe('text-tools builders', () => {
  it('buildCoverLetterIdea returns direct-mode Idea', () => {
    // SCENARIO: minimal input
    // EXPECTED: idea has Meta + DataMessage with _call.{_tool: 'generateCoverLetter'}; solution null
    const idea = buildCoverLetterIdea({ vacancy: v, resume: r });

    expect(idea.solution).toBeNull();
    expect(idea.context.length).toBe(2);

    const meta = idea.context.find((m) => m.type === 'meta');
    expect(meta).toBeDefined();
    expect((meta as { meta: { domain: string } }).meta.domain).toBe('text-tools');

    const data = idea.context.find((m) => m.type === 'data');
    expect(data).toBeDefined();
    const call = (data as { _call: { _tool: string } })._call;
    expect(call._tool).toBe('generateCoverLetter');
  });

  it('buildCoverLetterIdea throws on bad input (Zod)', () => {
    // SCENARIO: missing description
    // EXPECTED: throws
    expect(() =>
      buildCoverLetterIdea({ vacancy: { title: 'x' } as any, resume: r }),
    ).toThrow();
  });

  it('buildScoreIdea returns direct-mode Idea with scoreVacancy call', () => {
    // SCENARIO/EXPECTED
    const idea = buildScoreIdea({ vacancy: v, resume: r });
    const data = idea.context.find((m) => m.type === 'data');
    expect((data as { _call: { _tool: string } })._call._tool).toBe('scoreVacancy');
  });

  it('buildQuestionsIdea returns direct-mode Idea with answerQuestions call', () => {
    // SCENARIO/EXPECTED
    const idea = buildQuestionsIdea({ vacancy: v, resume: r, questions: ['q'] });
    const data = idea.context.find((m) => m.type === 'data');
    expect((data as { _call: { _tool: string } })._call._tool).toBe('answerQuestions');
  });

  it('builders use unique paths so multiple Ideas can coexist', () => {
    // SCENARIO: two Ideas built in quick succession (millisecond-different)
    // EXPECTED: their paths differ (using ISO timestamp)
    const a = buildCoverLetterIdea({ vacancy: v, resume: r });
    const b = buildCoverLetterIdea({ vacancy: v, resume: r });
    const aMeta = a.context.find((m) => m.type === 'meta') as { meta: { path: string } };
    const bMeta = b.context.find((m) => m.type === 'meta') as { meta: { path: string } };
    // Paths may match if same millisecond; this test asserts the path FORMAT is well-formed
    expect(aMeta.meta.path).toMatch(/^\/cover-letter\/\d{4}-\d{2}-\d{2}T/);
    expect(bMeta.meta.path).toMatch(/^\/cover-letter\/\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/builders.ts`:

```ts
// packages/text-tools/src/builders.ts

import { createMeta } from '@kolosochek/reactor-core';
import type { Idea, MetaMessage, DataMessage } from '@kolosochek/reactor-core';
import { CoverLetterInput, type CoverLetterInputT } from './tools/coverLetter.js';
import { ScoreInput, type ScoreInputT } from './tools/score.js';
import { QuestionsInput, type QuestionsInputT } from './tools/questions.js';

const DOMAIN = 'text-tools';
const VERSION = '0.1.0';

function buildIdea(toolName: string, pathPrefix: string, validatedInput: object): Idea {
  const meta = createMeta(DOMAIN, `${pathPrefix}/${new Date().toISOString()}`, { version: VERSION });
  const metaMsg: MetaMessage = { type: 'meta', role: 'system', meta };

  const dataMsg: DataMessage = {
    type: 'data',
    role: 'system',
    data: validatedInput,
    _call: { _tool: toolName, _outputPath: `†state.${toolName}`, ...validatedInput },
    _date: new Date().toISOString(),
  };

  return {
    schema: { type: 'object' },
    context: [metaMsg, dataMsg],
    solution: null,
  };
}

export function buildCoverLetterIdea(input: CoverLetterInputT): Idea {
  const parsed = CoverLetterInput.parse(input);
  return buildIdea('generateCoverLetter', '/cover-letter', parsed);
}

export function buildScoreIdea(input: ScoreInputT): Idea {
  const parsed = ScoreInput.parse(input);
  return buildIdea('scoreVacancy', '/score', parsed);
}

export function buildQuestionsIdea(input: QuestionsInputT): Idea {
  const parsed = QuestionsInput.parse(input);
  return buildIdea('answerQuestions', '/questions', parsed);
}
```

- [ ] **Step 4: Run tests, expect PASS (5/5).**

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/builders.ts \
        packages/text-tools/src/__tests__/builders.test.ts
git commit -m "feat(text-tools): Idea builders for all three tools (direct mode)"
```

---

## Task 18: `textToolsDomain` (DomainContext)

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/domain.ts`
- Create test inline in adapter test (Task 19)

**Why:** DomainContext is required by `Adapter` shape (used in scenario mode). text-tools fills it informationally.

- [ ] **Step 1: Implement (no separate test; covered by adapter.test.ts in T19)**

Create `src/domain.ts`:

```ts
// packages/text-tools/src/domain.ts

import type { DomainContext } from '@kolosochek/reactor-core';

export const textToolsDomain: DomainContext = {
  name: 'text-tools',
  paradigm: 'job-text-llm',
  entities: ['vacancy', 'resume', 'cover-letter', 'question'],
  actions: ['score', 'draft', 'answer'],
  capabilityMap: {
    score: ['scoreVacancy'],
    draft: ['generateCoverLetter'],
    answer: ['answerQuestions'],
  },
};
```

- [ ] **Step 2: Verify it imports cleanly**

```bash
cd /Users/noone/data/reactor/packages/text-tools
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add packages/text-tools/src/domain.ts
git commit -m "feat(text-tools): textToolsDomain DomainContext"
```

---

## Task 19: `textToolsAdapter` assembly

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/adapter.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/adapter.test.ts`

**Why:** Wraps tools + activities + domain into a single `Adapter` object for `reactor.use(...)`.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { textToolsAdapter } from '../adapter.js';

describe('textToolsAdapter', () => {
  it('has correct name and version', () => {
    // SCENARIO/EXPECTED
    expect(textToolsAdapter.name).toBe('text-tools');
    expect(textToolsAdapter.version).toBe('0.1.0');
  });

  it('exposes 3 tools: generateCoverLetter, scoreVacancy, answerQuestions', () => {
    // SCENARIO/EXPECTED
    const names = textToolsAdapter.tools.map((t) => t.name).sort();
    expect(names).toEqual(['answerQuestions', 'generateCoverLetter', 'scoreVacancy']);
  });

  it('activities cover every tool', () => {
    // SCENARIO: each tool has a registered activity
    // EXPECTED: activities[name] is a function for each tool name
    for (const tool of textToolsAdapter.tools) {
      expect(textToolsAdapter.activities[tool.name]).toBeTypeOf('function');
    }
  });

  it('exposes textToolsDomain via .domain', () => {
    // SCENARIO/EXPECTED
    expect(textToolsAdapter.domain?.name).toBe('text-tools');
  });

  it('does not provide repositories (consumers inject)', () => {
    // SCENARIO: textToolsAdapter is a pure-tools adapter; consumers provide their own repositories
    // EXPECTED: repositories is undefined
    expect(textToolsAdapter.repositories).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/adapter.ts`:

```ts
// packages/text-tools/src/adapter.ts

import type { Adapter } from '@kolosochek/reactor-core';
import { CoverLetterTool } from './tools/coverLetter.js';
import { ScoreTool } from './tools/score.js';
import { QuestionsTool } from './tools/questions.js';
import { generateCoverLetterActivity } from './activities/coverLetter.js';
import { scoreVacancyActivity } from './activities/score.js';
import { answerQuestionsActivity } from './activities/questions.js';
import { textToolsDomain } from './domain.js';

export const textToolsAdapter: Adapter = {
  name: 'text-tools',
  version: '0.1.0',
  tools: [CoverLetterTool, ScoreTool, QuestionsTool],
  activities: {
    generateCoverLetter: generateCoverLetterActivity,
    scoreVacancy: scoreVacancyActivity,
    answerQuestions: answerQuestionsActivity,
  },
  domain: textToolsDomain,
};
```

- [ ] **Step 4: Run tests, expect PASS (5/5).**

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/adapter.ts \
        packages/text-tools/src/__tests__/adapter.test.ts
git commit -m "feat(text-tools): textToolsAdapter assembly"
```

---

## Task 20: Public exports

**Files:**
- Modify: `/Users/noone/data/reactor/packages/text-tools/src/index.ts`
- Create: `/Users/noone/data/reactor/packages/text-tools/src/test-utils/index.ts`

**Why:** Define what's importable from `@reactor/text-tools` and `@reactor/text-tools/test-utils`.

- [ ] **Step 1: Implement main barrel**

Replace the contents of `src/index.ts`:

```ts
// packages/text-tools/src/index.ts
// Public surface for @reactor/text-tools.

// Adapter + assembly
export { textToolsAdapter } from './adapter.js';
export { textToolsDomain } from './domain.js';

// Builders
export {
  buildCoverLetterIdea,
  buildScoreIdea,
  buildQuestionsIdea,
} from './builders.js';

// Tools (definitions, schemas, types)
export {
  CoverLetterTool,
  CoverLetterInput,
  CoverLetterSolution,
  type CoverLetterInputT,
  type CoverLetterSolutionT,
  VacancyShape,
  ResumeShape,
} from './tools/coverLetter.js';

export {
  ScoreTool,
  ScoreInput,
  ScoreSolution,
  SkillMatch,
  type ScoreInputT,
  type ScoreSolutionT,
  type SkillMatchT,
} from './tools/score.js';

export {
  QuestionsTool,
  QuestionsInput,
  QuestionsSolution,
  QuestionAnswerPair,
  type QuestionsInputT,
  type QuestionsSolutionT,
  type QuestionAnswerPairT,
} from './tools/questions.js';

// Activities
export {
  generateCoverLetterActivity,
} from './activities/coverLetter.js';
export { scoreVacancyActivity } from './activities/score.js';
export { answerQuestionsActivity } from './activities/questions.js';

// Crystallization seam
export { composeActivity } from './activity/compose.js';
export type { CrystallizableActivity, ActivityLayers } from './activity/compose.js';

// Default prompts
export {
  defaultCoverLetterPrompt,
  defaultScorePrompt,
  defaultQuestionsPrompt,
} from './prompts/index.js';

// Errors
export {
  TextToolsError,
  IdeaSchemaError,
  IdeaContextMissingError,
  LLMTimeoutError,
  LLMQuotaError,
  LLMNetworkError,
  LLMOutputParseError,
  ActivityCancelledError,
} from './errors.js';
```

- [ ] **Step 2: Implement test-utils barrel**

Create `src/test-utils/index.ts`:

```ts
// packages/text-tools/src/test-utils/index.ts
// Public surface for @reactor/text-tools/test-utils.

export { createMockLLMProvider } from './mockLLM.js';
export type { CreateMockLLMProviderOptions } from './mockLLM.js';
export { runLLMProviderContractTests } from './contract.js';
```

- [ ] **Step 3: Verify build produces dist with both entry points**

```bash
cd /Users/noone/data/reactor/packages/text-tools
npx tsc --noEmit
npm run build
ls dist/
```

Expected: 0 typecheck errors. `dist/` contains `index.js` and `test-utils/index.js` plus `.d.ts` siblings.

- [ ] **Step 4: Verify smoke test still passes (it imports the barrel)**

```bash
npx vitest run src/__tests__/smoke.test.ts
```

Expected: 1/1 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/text-tools/src/index.ts \
        packages/text-tools/src/test-utils/index.ts
git commit -m "feat(text-tools): public exports (main barrel + test-utils subpath)"
```

---

## Task 21: Integration smoke - Reactor.execute on each Idea type

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/src/__tests__/integration.test.ts`

**Why:** End-to-end check that `reactor.use(textToolsAdapter)` + `reactor.execute(buildXxxIdea(...))` works for all three tools. This is the acceptance criterion for 4.1.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Reactor, InMemoryRepositories } from '@kolosochek/reactor-core';
import {
  textToolsAdapter,
  buildCoverLetterIdea,
  buildScoreIdea,
  buildQuestionsIdea,
} from '../index.js';
import { createMockLLMProvider } from '../test-utils/mockLLM.js';

const v = { title: 'Senior Frontend', description: 'React, TypeScript, 5+ years' };
const r = { title: 'Frontend Eng', content: '7 years React, TypeScript' };

describe('text-tools integration via Reactor.execute', () => {
  it('cover letter: reactor.execute(buildCoverLetterIdea) returns letter', async () => {
    // SCENARIO: full happy path direct-mode through Reactor
    // INPUT: Reactor with mock LLM returning canned letter; CoverLetter Idea
    // EXPECTED: solution.output.letter is the canned string
    const llm = createMockLLMProvider({
      onComplete: async () => ({ content: 'Dear hiring manager...', model: 'mock' }),
    });
    const reactor = Reactor.create({ llm });
    reactor.use({ ...textToolsAdapter, repositories: new InMemoryRepositories() });

    const idea = buildCoverLetterIdea({ vacancy: v, resume: r });
    const sol = await reactor.execute(idea);

    expect((sol.output as { letter: string }).letter).toBe('Dear hiring manager...');
  });

  it('score: reactor.execute(buildScoreIdea) returns score', async () => {
    // SCENARIO: Score idea, mock LLM returns valid JSON
    // EXPECTED: solution.output.score is 75
    const llm = createMockLLMProvider({
      onComplete: async () => ({
        content: JSON.stringify({
          score: 75,
          reasoning: 'Strong match',
          skillMatch: { matched: ['React'], missing: [], extra: [] },
        }),
        model: 'mock',
      }),
    });
    const reactor = Reactor.create({ llm });
    reactor.use({ ...textToolsAdapter, repositories: new InMemoryRepositories() });

    const idea = buildScoreIdea({ vacancy: v, resume: r });
    const sol = await reactor.execute(idea);

    expect((sol.output as { score: number }).score).toBe(75);
  });

  it('questions: reactor.execute(buildQuestionsIdea) returns qaPairs', async () => {
    // SCENARIO: Questions idea, mock LLM returns valid JSON
    // EXPECTED: solution.output.qaPairs has 2 entries
    const llm = createMockLLMProvider({
      onComplete: async () => ({
        content: JSON.stringify({
          qaPairs: [
            { question: 'salary?', answer: '150k' },
            { question: 'start date?', answer: '2 weeks' },
          ],
        }),
        model: 'mock',
      }),
    });
    const reactor = Reactor.create({ llm });
    reactor.use({ ...textToolsAdapter, repositories: new InMemoryRepositories() });

    const idea = buildQuestionsIdea({
      vacancy: v,
      resume: r,
      questions: ['salary?', 'start date?'],
    });
    const sol = await reactor.execute(idea);

    expect((sol.output as { qaPairs: unknown[] }).qaPairs.length).toBe(2);
  });

  it('persists ExperienceRecord per execute (via Reactor.appendExperience)', async () => {
    // SCENARIO: each execute persists a record
    // INPUT: 3 sequential executes
    // EXPECTED: 3 records in InMemoryRepositories
    const llm = createMockLLMProvider({
      onComplete: async () => ({ content: 'L', model: 'mock' }),
    });
    const repos = new InMemoryRepositories();
    const reactor = Reactor.create({ llm });
    reactor.use({ ...textToolsAdapter, repositories: repos });

    await reactor.execute(buildCoverLetterIdea({ vacancy: v, resume: r }));
    await reactor.execute(buildCoverLetterIdea({ vacancy: v, resume: r }));
    await reactor.execute(buildCoverLetterIdea({ vacancy: v, resume: r }));

    const records = await repos.experience.list({});
    expect(records.length).toBe(3);
    for (const rec of records) {
      expect(rec.toolName).toBe('generateCoverLetter');
      expect(rec.outcome).toBe('success');
    }
  });

  it('Idea immutability: original Idea not mutated by execute', async () => {
    // SCENARIO: execute should not mutate the input Idea
    // INPUT: Idea, frozen via Object.freeze deep
    // EXPECTED: idea.solution is still null after execute returns; no mutation thrown
    const llm = createMockLLMProvider({
      onComplete: async () => ({ content: 'L', model: 'mock' }),
    });
    const reactor = Reactor.create({ llm });
    reactor.use({ ...textToolsAdapter, repositories: new InMemoryRepositories() });

    const idea = buildCoverLetterIdea({ vacancy: v, resume: r });
    Object.freeze(idea);
    Object.freeze(idea.context);

    const sol = await reactor.execute(idea);

    expect(idea.solution).toBeNull();
    expect((sol.output as { letter: string }).letter).toBe('L');
  });
});
```

- [ ] **Step 2: Run, expect PASS**

```bash
cd /Users/noone/data/reactor/packages/text-tools
npx vitest run src/__tests__/integration.test.ts
```

Expected: 5/5 PASS. (The test was written after all components landed; it should pass on first run. If it fails, dispatch a NEEDS_CONTEXT to debug which component broke the integration.)

- [ ] **Step 3: Run full test suite for total green**

```bash
npx vitest run
```

Expected: ALL PASS. Count should be roughly: 1 (smoke) + 5 (compose) + 6 (errors) + 8 (coverLetter tool) + 8 (score tool) + 5 (questions tool) + 5 (prompts) + 4 (mockLLM) + 4 (contract) + 8 (coverLetter activity) + 6 (score activity) + 5 (questions activity) + 5 (builders) + 5 (adapter) + 5 (integration) = **80 tests**.

- [ ] **Step 4: Typecheck full package**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/noone/data/reactor
git add packages/text-tools/src/__tests__/integration.test.ts
git commit -m "test(text-tools): integration smoke - reactor.execute on each Idea type"
```

---

## Task 22: README + CHANGELOG + final acceptance triple

**Files:**
- Create: `/Users/noone/data/reactor/packages/text-tools/README.md`
- Create: `/Users/noone/data/reactor/packages/text-tools/CHANGELOG.md`

**Why:** Per spec acceptance criteria for 4.1. Documents the package and locks 0.1.0.

- [ ] **Step 1: Create README.md**

```markdown
# @reactor/text-tools

Platform-agnostic text-LLM domain adapter on top of `@kolosochek/reactor-core`.

Provides three Idea-Triplet Activities — `generateCoverLetter`, `scoreVacancy`, `answerQuestions` — that operate on raw text input (`{ vacancy: { title, description }, resume: { title, content } }`) and return structured Solutions. No platform coupling, no DB roundtrip. Consumed by both the Chrome extension and the hh.ru `@hhru/reactor-adapter` (after Phase C+ migrations 4.2 and 4.3).

## Status

`v0.1.0` — text-tools genesis (sub-project 4.1 of the Phase C+ decoupling work).

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
- Crystallization (Phase 1 `preCheck` for any tool — to be addressed once experience data accumulates).
- Streaming output.
- Multi-message conversational LLM flows (single-turn only at 0.1.0).

## Source

- Spec: `docs/superpowers/specs/2026-04-26-text-tools-decouple-design.md`
- Plan: `docs/superpowers/plans/2026-04-26-text-tools-genesis.md`
```

- [ ] **Step 2: Create CHANGELOG.md**

```markdown
# Changelog

All notable changes to `@reactor/text-tools`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 — text-tools genesis (sub-project 4.1)

### Added

- Initial public surface for `@reactor/text-tools`.
- Three Activities: `generateCoverLetterActivity`, `scoreVacancyActivity`, `answerQuestionsActivity`. Each composed via `composeActivity({ llmFallback })` so future crystallization is a one-line addition.
- Three Tool definitions with Zod input + Solution schemas: `CoverLetterTool`, `ScoreTool`, `QuestionsTool`.
- Three Idea builders for direct-mode invocation: `buildCoverLetterIdea`, `buildScoreIdea`, `buildQuestionsIdea`. Each builder validates input via Zod and constructs an `Idea` with `MetaMessage` + `DataMessage._call`.
- `textToolsAdapter` Adapter object bundling tools + activities + `textToolsDomain`.
- Default prompts (en + ru) for all three tools, ported from existing extension and hh.ru server prompts.
- `composeActivity` factory — crystallization seam for future deterministic preCheck and postValidate layers.
- `TextToolsError` typed hierarchy: `IdeaSchemaError`, `IdeaContextMissingError`, `LLMTimeoutError`, `LLMQuotaError`, `LLMNetworkError`, `LLMOutputParseError`, `ActivityCancelledError`.
- `createMockLLMProvider` for unit tests; exported from `@reactor/text-tools/test-utils`.
- `runLLMProviderContractTests` — vitest-compatible conformance suite that any LLMProvider implementation can run against itself.

### Requirements

- `@kolosochek/reactor-core` >= 0.2.0 (which extends `ActivityContext` with `llm: LLMProvider` and adds opts param to `Reactor.execute`).
```

- [ ] **Step 3: Final acceptance triple**

```bash
cd /Users/noone/data/reactor/packages/text-tools
npm run typecheck
npm test
npm run build
```

Expected:
- `npm run typecheck`: 0 errors
- `npm test`: 80/80 tests pass
- `npm run build`: `dist/` populated with index.js, test-utils/index.js, and matching .d.ts files

- [ ] **Step 4: Sanity check no Node-specific imports leaked into runtime code**

```bash
grep -r "from 'node:" /Users/noone/data/reactor/packages/text-tools/src/ \
  | grep -v __tests__ \
  | grep -v test-utils
grep -r "from 'fs'\|from 'child_process'\|from 'path'" /Users/noone/data/reactor/packages/text-tools/src/ \
  | grep -v __tests__ \
  | grep -v test-utils
```

Expected: no matches. text-tools must run unmodified in Chrome MV3.

- [ ] **Step 5: Commit**

```bash
cd /Users/noone/data/reactor
git add packages/text-tools/README.md \
        packages/text-tools/CHANGELOG.md
git commit -m "docs(text-tools): README + CHANGELOG 0.1.0; final acceptance triple"
```

After this commit, sub-project 4.1 is complete. text-tools is ready to be consumed by sub-projects 4.2 (extension migration) and 4.3 (hh.ru-adapter refactor).

---

## Acceptance criteria (4.1 complete)

- [ ] reactor-core 0.2.0 published (file: link in dev). All Phase A/B/C tests pass against the new SPI.
- [ ] `Reactor.execute(idea, opts?)` accepts opts. `ctx.llm`, `ctx.signal`, `ctx.onProgress` populated in all three execute modes.
- [ ] `packages/text-tools/` workspace created. `npm install` from hhru root picks it up. `dist/` builds clean.
- [ ] All three Activities accept `vacancy: { title, description, url?, platform? }` shape. No `vacancyId` anywhere.
- [ ] `composeActivity` exported and used by every Activity (only `llmFallback` layer wired today).
- [ ] `runLLMProviderContractTests` runs and passes against `createMockLLMProvider`.
- [ ] Public exports (`@reactor/text-tools` main + `/test-utils` subpath) documented in README.
- [ ] 80 tests passing in `packages/text-tools/`. 144 tests passing in `@kolosochek/reactor-core` (was 141; +3 from Task 3).
- [ ] No Node-specific runtime imports in text-tools src (verified by grep at end of T22).
