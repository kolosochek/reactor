import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestPostgres, truncateAll, type TestContainerHandle } from './_helpers/testcontainerSetup.js';
import { PostgresExperienceRepository } from '../db/repositories/PostgresExperienceRepository.js';
import type { ExperienceRecord } from '@kolosochek/reactor-core';

let h: TestContainerHandle;
let repo: PostgresExperienceRepository;

beforeAll(async () => {
  h = await startTestPostgres();
  repo = new PostgresExperienceRepository(h.db);
}, 60_000);

afterAll(async () => {
  if (h) {
    await h.stop();
  }
});

beforeEach(async () => {
  await truncateAll(h.db);
});

describe('PostgresExperienceRepository', () => {
  it('append + list round-trip', async () => {
    // SCENARIO: write a record, read it back via list({})
    // INPUT: one ExperienceRecord with required SPI fields + extension in metadata
    // EXPECTED: list({}) returns it; SPI fields preserved exactly; metadata.domain preserved
    const rec: ExperienceRecord = {
      id: 'exp-001',
      toolName: 'generateCoverLetter',
      input: { vacancy: { title: 'x', description: 'y' } },
      output: { letter: 'L' },
      outcome: 'success',
      durationMs: 100,
      createdAt: '2026-04-26T00:00:00.000Z',
      metadata: { domain: 'text-tools', ideaMeta: { path: '/cover-letter/2026' } },
    };

    await repo.append(rec);
    const all = await repo.list({});

    expect(all).toHaveLength(1);
    const [got] = all;
    expect(got).toBeDefined();
    expect(got?.id).toBe('exp-001');
    expect(got?.toolName).toBe('generateCoverLetter');
    expect(got?.outcome).toBe('success');
    expect(got?.durationMs).toBe(100);
    const output = got?.output as { letter: string } | undefined;
    expect(output?.letter).toBe('L');
    expect(got?.metadata?.domain).toBe('text-tools');
  });

  it('filters by toolName', async () => {
    // SCENARIO: 2 records with different toolNames are stored
    // INPUT: append both; query list({ toolName: 'scoreVacancy' })
    // EXPECTED: only the matching record returned
    await repo.append({
      id: 'exp-001',
      toolName: 'generateCoverLetter',
      input: {},
      output: {},
      outcome: 'success',
      durationMs: 10,
      createdAt: '2026-04-26T00:00:00.000Z',
    });
    await repo.append({
      id: 'exp-002',
      toolName: 'scoreVacancy',
      input: {},
      output: {},
      outcome: 'success',
      durationMs: 20,
      createdAt: '2026-04-26T00:01:00.000Z',
    });

    const filtered = await repo.list({ toolName: 'scoreVacancy' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.toolName).toBe('scoreVacancy');
    expect(filtered[0]?.id).toBe('exp-002');
  });

  it('persists failure outcomes with errorMessage + errorClass via metadata', async () => {
    // SCENARIO: failure record carries error fields in metadata (Decision #10: extensions in metadata)
    // INPUT: append failure record with metadata.errorMessage and metadata.errorClass
    // EXPECTED: round-trip preserves outcome=failure plus both extension fields
    await repo.append({
      id: 'exp-fail-001',
      toolName: 'scoreVacancy',
      input: {},
      output: { error: 'parse failed' },
      outcome: 'failure',
      durationMs: 50,
      createdAt: '2026-04-26T00:02:00.000Z',
      metadata: { errorMessage: 'parse failed', errorClass: 'LLMOutputParseError' },
    });

    const all = await repo.list({});
    expect(all).toHaveLength(1);
    expect(all[0]?.outcome).toBe('failure');
    expect(all[0]?.metadata?.errorMessage).toBe('parse failed');
    expect(all[0]?.metadata?.errorClass).toBe('LLMOutputParseError');
  });
});
