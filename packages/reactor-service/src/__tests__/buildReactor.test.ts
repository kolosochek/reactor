import { describe, it, expect } from 'vitest';
import { InMemoryRepositories } from '@kolosochek/reactor-core';
import type { LLMProvider } from '@kolosochek/reactor-core';
import { buildReactor } from '../reactor/buildReactor.js';

const mockLLM: LLMProvider = {
  name: 'mock-llm',
  complete: async () => ({ content: '', model: 'mock' }),
};

describe('buildReactor', () => {
  it('mounts text-tools adapter on a fresh Reactor', () => {
    // SCENARIO: factory wires textToolsAdapter into a per-request Reactor
    // INPUT: mock LLMProvider + InMemoryRepositories
    // EXPECTED: all 3 text-tools tools are registered (generateCoverLetter, scoreVacancy, answerQuestions)
    const repos = new InMemoryRepositories();
    const reactor = buildReactor(mockLLM, repos);

    expect(reactor.hasTool('generateCoverLetter')).toBe(true);
    expect(reactor.hasTool('scoreVacancy')).toBe(true);
    expect(reactor.hasTool('answerQuestions')).toBe(true);
  });

  it('uses the provided RepositoriesProvider via adapter.repositories override', () => {
    // SCENARIO: factory passes the supplied repositories through to Reactor.use()
    // INPUT: mock LLM + a specific InMemoryRepositories instance
    // EXPECTED: reactor.getRepositories() returns the very same instance passed in
    const repos = new InMemoryRepositories();
    const reactor = buildReactor(mockLLM, repos);

    expect(reactor.getRepositories()).toBe(repos);
  });

  it('passes the LLMProvider through to ReactorConfig', () => {
    // SCENARIO: per-request LLM ends up in the constructed Reactor's config
    // INPUT: mock LLM with name 'mock-llm'
    // EXPECTED: getConfig().llm.name === 'mock-llm'
    const reactor = buildReactor(mockLLM, new InMemoryRepositories());
    expect(reactor.getConfig().llm.name).toBe('mock-llm');
  });
});
