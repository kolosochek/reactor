# Reactor

An ecosystem of Idea-Transformer microservices, built around the Idea-Triplet protocol (`{Schema, Context, Solution}`).

## Packages

| Package | Description | Status |
|---|---|---|
| [`@reactor/service`](./packages/reactor-service) | PostgreSQL-backed Idea-Transformer microservice | scaffolding |
| [`@reactor/text-tools`](./packages/text-tools) | Universal text Idea-Transformers (score / cover-letter / questions) | 0.1.0 |
| [`@reactor/docs`](./packages/docs) | Documentation site (Vike + vite-plugin-markdown) | not yet |

## Concept

The Reactor accepts an immutable `Idea = { schema, context, solution }`, executes a domain Activity (or runs latent LLM interpretation), persists an `ExperienceRecord`, and returns a new `Idea` with the populated `solution`.

Three execution modes:
- **batch** — walks `PlanMessage.calls` in array order with `†state.X` ref resolution
- **direct** — runs a single registered Activity for a `DataMessage._call._tool`
- **scenario** — asks the LLM to pick one Tool and run it (Latent Execution by default)

## Architecture documents

- `docs/specs/2026-04-26-reactor-service-design.md` — service architecture, 9 invariants, Acts mapping
- `docs/plans/2026-04-26-reactor-service-genesis.md` — 17-task TDD plan
- `EVOLUTION.md` — known future architectural shifts (deferred decisions)

## Development

```bash
npm install
npm run db:up       # start PostgreSQL via Docker
npm test            # run all workspace tests
```

See per-package READMEs for package-specific commands.

## License

MIT.
