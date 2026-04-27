// packages/reactor-service/src/reactor/buildReactor.ts
//
// Per-request Reactor factory. Each /reactor/execute call constructs a fresh
// Reactor with a request-scoped LLMProvider and the long-lived shared
// RepositoriesProvider. Reactor construction is cheap; per-request avoids
// changing reactor-core 0.2.0 (Decision #8).

import { Reactor } from '@kolosochek/reactor-core';
import { textToolsAdapter } from '@dkolosovsky/reactor-text-tools';
import type { LLMProvider, RepositoriesProvider } from '@kolosochek/reactor-core';

export function buildReactor(llm: LLMProvider, repositories: RepositoriesProvider): Reactor {
  return Reactor.create({ llm }).use({ ...textToolsAdapter, repositories });
}
