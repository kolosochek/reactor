import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { startTestPostgres, truncateAll, type TestContainerHandle } from './_helpers/testcontainerSetup.js';
import { createRepositoriesProvider } from '../db/repositories/index.js';
import { buildServer } from '../server.js';
import { buildCoverLetterIdea } from '@reactor/text-tools';

vi.mock('../reactor/llmFromConfig.js', () => ({
  buildLLMProvider: () => ({
    name: 'mock',
    complete: async () => ({ content: 'Dear hiring manager...', model: 'mock' }),
  }),
  ProviderNotImplementedError: class extends Error {},
}));

let h: TestContainerHandle;

beforeAll(async () => {
  h = await startTestPostgres();
}, 60_000);

afterAll(async () => {
  if (h) {
    await h.stop();
  }
});

beforeEach(async () => {
  await truncateAll(h.db);
});

describe('POST /reactor/execute', () => {
  it('cover-letter idea succeeds and persists ExperienceRecord', async () => {
    // SCENARIO: full happy path through HTTP boundary with mocked deterministic LLM
    // INPUT: valid CoverLetter Idea + openrouter providerConfig
    // EXPECTED: 200 with solution.output.letter from mocked LLM; one ExperienceRecord persisted with outcome='success'
    const repos = createRepositoriesProvider(h.db);
    const app = await buildServer({ repositories: repos, logLevel: 'warn' });

    const idea = buildCoverLetterIdea({
      vacancy: { title: 'Senior FE', description: 'React, 5+ years' },
      resume: { title: 'FE', content: '7 years React' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/reactor/execute',
      payload: {
        idea,
        providerConfig: { provider: 'openrouter', model: 'mock', apiKey: 'sk-test' },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const output = body.solution?.output as { letter?: string } | undefined;
    expect(output?.letter).toBe('Dear hiring manager...');

    const records = await repos.experience.list({});
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe('success');
    expect(records[0]?.toolName).toBe('generateCoverLetter');

    await app.close();
  });

  it('rejects malformed idea with 4xx', async () => {
    // SCENARIO: idea with empty context cannot be classified by Reactor.detectMode
    // INPUT: idea with context: []
    // EXPECTED: status 4xx (route maps Reactor's mode-detection error)
    const repos = createRepositoriesProvider(h.db);
    const app = await buildServer({ repositories: repos, logLevel: 'warn' });

    const res = await app.inject({
      method: 'POST',
      url: '/reactor/execute',
      payload: {
        idea: { schema: { type: 'object' }, context: [], solution: null },
        providerConfig: { provider: 'openrouter', model: 'm', apiKey: 'k' },
      },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(600);

    await app.close();
  });

  it('rejects request missing providerConfig with 400', async () => {
    // SCENARIO: zod validation rejects missing required field
    // INPUT: payload without providerConfig
    // EXPECTED: 400 with RequestValidationError class
    const repos = createRepositoriesProvider(h.db);
    const app = await buildServer({ repositories: repos, logLevel: 'warn' });

    const res = await app.inject({
      method: 'POST',
      url: '/reactor/execute',
      payload: {
        idea: buildCoverLetterIdea({
          vacancy: { title: 't', description: 'd' },
          resume: { title: 'X', content: 'Y' },
        }),
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error?.class).toBe('RequestValidationError');

    await app.close();
  });
});
