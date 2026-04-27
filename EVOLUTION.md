# Evolution: known future-triggers for the Reactor surface

## Purpose

This document captures architectural shifts we **know are coming** but are deliberately deferred. Each entry follows the Pokeroid pattern (`pokeroid/runtime/EVOLUTION.md`):

> **We thought** X, **but learned** Y, **so we will do** Z

Entries are not TODOs. They are landmines flagged for future readers so that when a triggering event happens, the response is informed, not improvised.

---

## E1. Region concept (universal UI ↔ game-state language)

### Status

🟡 **Deferred.** Not needed for v0.1.0 of `@reactor/service` (text-only Idea transformers: score / cover-letter / questions). Will become required when the Reactor service receives a Tool whose Idea includes structured visual/spatial data.

### Pokeroid canon

Source: `pokeroid/runtime/ARCHITECTURE.md:192-264` ("Регионы и виртуальная навигация").

> Регионы - универсальный язык общения между всеми компонентами. [...] Нет разделения на "интерфейсное" и "игровое" состояние - есть только регионы разных типов.

A `Region` is a typed object with normalized 0-1000 coordinates and a kind discriminator (`text` / `flag` / `card` / `button` / `input` / `group` / ...). Pokeroid uses Regions as the sole representation of:
- UI controls a bot can press (Navigate workflow inputs).
- Game data extracted from screen / DOM (Play/Observe workflow inputs).
- Virtual UIs synthesized from external services (Pokeroid bridges non-UI services as virtual Regions for navigation uniformity).

### We thought

The hhru text tools (`scoreVacancyActivity`, `generateCoverLetterActivity`, `answerQuestionsActivity`) operate on **structured text inputs** only - vacancy JSON, resume JSON, question lists. No visual layer. The Idea triplet's Schema describes these as plain JSON shapes. No need for spatial/visual primitives.

### But learned (anticipated)

When the Chrome extension's resume editor (or any consumer that touches a rendered page / DOM / screen) flows through the Reactor, the Idea triplet will need to carry **visual context** to let the LLM reason about layout, button affordances, and "what's clickable next." At that point, ad-hoc per-tool spatial schemas would re-create exactly the inconsistency Pokeroid's Region concept was designed to eliminate.

### So we will do (when triggered)

Adopt Pokeroid's `Region[]` shape verbatim as the canonical visual-context envelope:

```ts
interface Box {
  y_min: number;  // top edge, normalized 0-1000
  x_min: number;  // left edge
  y_max: number;  // bottom edge
  x_max: number;  // right edge
}

type Region =
  | { type: 'text'; value: string; label?: string; box_2d: Box }
  | { type: 'flag'; value: boolean; box_2d: Box }
  | { type: 'card'; value: Card; box_2d: Box }       // poker-specific; drop or generalize for hhru
  | { type: 'button'; label: string; action?: string; box_2d: Box }
  | { type: 'input'; label: string; box_2d: Box }
  | { type: 'group'; label: string; box_2d: Box };
```

Integration shape:
- Add a `RegionsMessage` type to `@reactor/text-tools` (or a new `@reactor/visual-tools` package if scope grows).
- Idea Context can carry `RegionsMessage` alongside existing `DataMessage` / `InputMessage` / `PlanMessage`.
- Activities that consume Regions accept `regions: Region[]` as a tool parameter; LLM sees them rendered in a stable normalized form.
- `box_2d` math (normalized → absolute pixels) is consumer-side, not service-side.

### Triggering events (any of these flips this from "deferred" to "active")

1. Chrome extension introduces a "review my resume layout" or "fill this dropdown" Tool whose execution depends on rendered-page understanding.
2. Job-board automation expands beyond hh.ru to platforms whose only API is the rendered DOM (LinkedIn Easy Apply already smells like this).
3. A non-text Idea-Transformer microservice (e.g. screenshot-analyzer, OCR) is added to the ecosystem and would feed the Reactor.
4. A Pokeroid integration lands and Reactor needs to speak Pokeroid's native language.

### Cost of deferral

🟢 **Low.** Regions are an additive Message type; the existing 5 SPI tables already store JSON snapshots of the full triplet, so historical experience records won't lose structure when Regions land. Activities that don't consume Regions ignore them. The only retrofit when the trigger fires is on the LLM-prompt assembly path inside individual Activities.

### Cost of premature adoption

🔴 **Real.** Adding Regions now would force every existing builder (`buildScoreIdea`, `buildCoverLetterIdea`, `buildQuestionsIdea`) to either:
- Carry an empty `regions: []` (noise on every request), or
- Branch internally, fragmenting the "one shape, one envelope" Idea Triplet invariant (#2).

Neither is worth it for text tools that have no spatial input.

### When to revisit

Each time a new Tool is added to the Reactor ecosystem, ask: "does the LLM need to reason about layout / position / affordance to do this?" If yes, this E1 fires.

---

## How to add new entries to this document

1. Pick a stable ID (`E2`, `E3`, ...).
2. Lead with **Status** (🟢 active / 🟡 deferred / 🔴 blocked / ✅ landed).
3. **Pokeroid canon** - cite the source file and lines.
4. **We thought / But learned / So we will do** - the evolution narrative.
5. **Triggering events** - concrete events that move status from deferred to active.
6. **Cost of deferral** vs **cost of premature adoption**.
7. **When to revisit** - what regular checkpoint surfaces this entry.

Entries graduate to ✅ when the work lands as a separate spec/plan (link from here).
