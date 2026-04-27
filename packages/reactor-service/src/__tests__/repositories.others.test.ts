import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestPostgres, truncateAll, type TestContainerHandle } from './_helpers/testcontainerSetup.js';
import { createRepositoriesProvider } from '../db/repositories/index.js';
import type { Lesson, Idea, Prediction, ToolMetrics, Solution } from '@kolosochek/reactor-core';

let h: TestContainerHandle;
let repos: ReturnType<typeof createRepositoriesProvider>;

beforeAll(async () => {
  h = await startTestPostgres();
  repos = createRepositoriesProvider(h.db);
}, 60_000);

afterAll(async () => {
  if (h) {
    await h.stop();
  }
});

beforeEach(async () => {
  await truncateAll(h.db);
});

describe('PostgresLessonsRepository', () => {
  it('upsert + list round-trip', async () => {
    // SCENARIO: write a lesson via upsert, read it back via list
    // INPUT: minimal Lesson with topic + description + rich domain field
    // EXPECTED: list returns one record; topic and description preserved
    const lesson: Lesson = {
      id: 'lesson-001',
      topic: 'Senior + senior aligns',
      description: 'When vacancy says senior and resume says senior, score >70',
      createdAt: '2026-04-26T00:00:00.000Z',
      domain: 'text-tools',
      type: 'sequence',
    };
    await repos.lessons.upsert(lesson);
    const all = await repos.lessons.list({});
    expect(all).toHaveLength(1);
    expect(all[0]?.topic).toBe('Senior + senior aligns');
    expect(all[0]?.description).toContain('senior');
  });

  it('upsert is idempotent on id (second write overwrites)', async () => {
    // SCENARIO: same id, different description
    // INPUT: upsert twice
    // EXPECTED: list returns 1 record with updated description
    await repos.lessons.upsert({
      id: 'lesson-002',
      topic: 'topic',
      description: 'first',
      createdAt: '2026-04-26T00:00:00.000Z',
    });
    await repos.lessons.upsert({
      id: 'lesson-002',
      topic: 'topic',
      description: 'second',
      createdAt: '2026-04-26T00:01:00.000Z',
    });
    const all = await repos.lessons.list({});
    expect(all).toHaveLength(1);
    expect(all[0]?.description).toBe('second');
  });

  it('remove by id deletes the record', async () => {
    // SCENARIO: upsert then remove
    // EXPECTED: list returns empty
    await repos.lessons.upsert({
      id: 'lesson-003',
      topic: 'topic',
      description: 'description',
      createdAt: '2026-04-26T00:00:00.000Z',
    });
    await repos.lessons.remove('lesson-003');
    const all = await repos.lessons.list({});
    expect(all).toHaveLength(0);
  });
});

describe('PostgresIdeasRepository', () => {
  it('save returns id; load round-trips Idea', async () => {
    // SCENARIO: persist Idea triplet via save, retrieve via load
    // INPUT: Idea with schema, context (one MetaMessage), null solution
    // EXPECTED: save returns non-empty string id; load returns same idea + null solution
    const idea: Idea = {
      schema: { type: 'object' },
      context: [
        {
          type: 'meta',
          meta: {
            domain: 'text-tools',
            path: '/cover-letter/2026',
            version: '0.1.0',
            branches: ['main'],
            createdAt: '2026-04-26T00:00:00.000Z',
          },
        },
      ],
      solution: null,
    };
    const id = await repos.ideas.save(idea, null);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const loaded = await repos.ideas.load(id);
    expect(loaded).not.toBeNull();
    expect(loaded?.idea.schema).toEqual({ type: 'object' });
    expect(loaded?.solution).toBeNull();
  });

  it('list filters by domain via metadata path', async () => {
    // SCENARIO: 2 ideas with different domains in MetaMessage
    // INPUT: save both, query list({ domain: 'text-tools' })
    // EXPECTED: list returns only the matching record with correct meta.domain
    const ideaA: Idea = {
      schema: { type: 'object' },
      context: [
        {
          type: 'meta',
          meta: {
            domain: 'text-tools',
            path: '/a',
            version: '0',
            branches: [],
            createdAt: '2026-04-26T00:00:00.000Z',
          },
        },
      ],
      solution: null,
    };
    const ideaB: Idea = {
      schema: { type: 'object' },
      context: [
        {
          type: 'meta',
          meta: {
            domain: 'hhru',
            path: '/b',
            version: '0',
            branches: [],
            createdAt: '2026-04-26T00:01:00.000Z',
          },
        },
      ],
      solution: null,
    };
    await repos.ideas.save(ideaA, null);
    await repos.ideas.save(ideaB, null);

    const filtered = await repos.ideas.list({ domain: 'text-tools' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.meta.domain).toBe('text-tools');
  });

  it('list({ hasSolution: true }) filters out unsolved ideas', async () => {
    // SCENARIO: 2 ideas, only one with non-null solution
    // INPUT: save one with null solution, save one with non-null solution
    // EXPECTED: list({ hasSolution: true }) returns only the solved one
    const idea: Idea = {
      schema: { type: 'object' },
      context: [
        {
          type: 'meta',
          meta: {
            domain: 'text-tools',
            path: '/a',
            version: '0',
            branches: [],
            createdAt: '2026-04-26T00:00:00.000Z',
          },
        },
      ],
      solution: null,
    };
    const solution: Solution = {
      meta: {
        domain: 'text-tools',
        path: '/a',
        version: '0',
        branches: [],
        createdAt: '2026-04-26T00:00:00.000Z',
      },
      calls: [],
      output: 'done',
    };
    await repos.ideas.save(idea, null);
    await repos.ideas.save(idea, solution);

    const solved = await repos.ideas.list({ hasSolution: true });
    expect(solved).toHaveLength(1);
  });
});

describe('PostgresPredictionsRepository', () => {
  it('save + list round-trip', async () => {
    // SCENARIO: persist a prediction, retrieve via list
    // INPUT: Prediction with required SPI fields including confidence 0.7
    // EXPECTED: list returns one record; toolName/confidence/expectedOutcome preserved
    const prediction: Prediction = {
      id: 'pred-001',
      ideaId: 'idea-001',
      toolName: 'scoreVacancy',
      expectedOutcome: 'success',
      confidence: 0.7,
      rationale: 'high alignment between vacancy and resume',
      createdAt: '2026-04-26T00:00:00.000Z',
    };
    await repos.predictions.save(prediction);

    const all = await repos.predictions.list({});
    expect(all).toHaveLength(1);
    expect(all[0]?.toolName).toBe('scoreVacancy');
    expect(all[0]?.confidence).toBeCloseTo(0.7, 5);
    expect(all[0]?.expectedOutcome).toBe('success');
  });

  it('filters by toolName', async () => {
    // SCENARIO: 2 predictions with different toolNames
    // INPUT: save both, query list({ toolName: 'scoreVacancy' })
    // EXPECTED: only matching record returned
    await repos.predictions.save({
      id: 'pred-001',
      toolName: 'scoreVacancy',
      expectedOutcome: 'success',
      confidence: 0.7,
      rationale: 'a',
      createdAt: '2026-04-26T00:00:00.000Z',
    });
    await repos.predictions.save({
      id: 'pred-002',
      toolName: 'generateCoverLetter',
      expectedOutcome: 'failure',
      confidence: 0.3,
      rationale: 'b',
      createdAt: '2026-04-26T00:01:00.000Z',
    });

    const filtered = await repos.predictions.list({ toolName: 'scoreVacancy' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.toolName).toBe('scoreVacancy');
  });
});

describe('PostgresToolsRepository', () => {
  it('upsert + get round-trip', async () => {
    // SCENARIO: upsert ToolMetrics, fetch via get(toolRef)
    // INPUT: ToolMetrics with all flat SPI fields
    // EXPECTED: get returns same record; toolRef and totalExecutions preserved
    const metric: ToolMetrics = {
      toolRef: 'text-tools:generateCoverLetter:0.1.0',
      capabilityName: 'generateCoverLetter',
      classification: 'stable',
      successRate: 0.85,
      totalExecutions: 42,
      avgDuration: 1500,
      crystallizationScore: 0.7,
    };
    await repos.tools.upsert(metric);

    const got = await repos.tools.get('text-tools:generateCoverLetter:0.1.0');
    expect(got).not.toBeNull();
    expect(got?.toolRef).toBe('text-tools:generateCoverLetter:0.1.0');
    expect(got?.totalExecutions).toBe(42);
    expect(got?.classification).toBe('stable');
  });

  it('upsert is idempotent on toolRef (second overwrites)', async () => {
    // SCENARIO: same toolRef, updated metrics
    // INPUT: upsert twice with different totalExecutions/successRate
    // EXPECTED: list returns 1 record with updated values
    const metric: ToolMetrics = {
      toolRef: 'text-tools:scoreVacancy:0.1.0',
      capabilityName: 'scoreVacancy',
      classification: 'stable',
      successRate: 0.7,
      totalExecutions: 10,
      avgDuration: 1000,
      crystallizationScore: 0.5,
    };
    await repos.tools.upsert(metric);
    await repos.tools.upsert({ ...metric, totalExecutions: 25, successRate: 0.9 });

    const all = await repos.tools.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.totalExecutions).toBe(25);
    expect(all[0]?.successRate).toBeCloseTo(0.9, 5);
  });

  it('get returns null for unknown toolRef', async () => {
    // SCENARIO: query for non-existent toolRef
    // EXPECTED: get returns null
    const got = await repos.tools.get('does-not-exist:0.0.0');
    expect(got).toBeNull();
  });
});

describe('createRepositoriesProvider', () => {
  it('exposes all 5 SPI repos', () => {
    // SCENARIO: factory wires all 5 repositories per RepositoriesProvider SPI
    // EXPECTED: all 5 fields are defined
    expect(repos.experience).toBeDefined();
    expect(repos.lessons).toBeDefined();
    expect(repos.ideas).toBeDefined();
    expect(repos.predictions).toBeDefined();
    expect(repos.tools).toBeDefined();
  });
});
