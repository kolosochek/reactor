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
    // INPUT: Idea, frozen via Object.freeze
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
