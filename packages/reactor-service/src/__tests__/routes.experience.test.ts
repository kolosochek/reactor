import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestPostgres, truncateAll, type TestContainerHandle } from './_helpers/testcontainerSetup.js';
import { createRepositoriesProvider } from '../db/repositories/index.js';
import { buildServer } from '../server.js';
import type { ExperienceRecord } from '@kolosochek/reactor-core';

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

function rec(over: Partial<ExperienceRecord>): ExperienceRecord {
  return {
    id: 'exp-default',
    toolName: 'generateCoverLetter',
    input: {},
    output: {},
    outcome: 'success',
    durationMs: 0,
    createdAt: '2026-04-26T00:00:00.000Z',
    ...over,
  };
}

describe('GET /reactor/experience', () => {
  it('returns persisted records as records[] array', async () => {
    // SCENARIO: 2 records persisted via repo; GET surfaces both
    // INPUT: append two distinct records, then GET /reactor/experience
    // EXPECTED: 200, body.records.length === 2
    const repos = createRepositoriesProvider(h.db);
    await repos.experience.append(rec({ id: 'exp-001', toolName: 'generateCoverLetter' }));
    await repos.experience.append(
      rec({ id: 'exp-002', toolName: 'scoreVacancy', createdAt: '2026-04-26T00:01:00.000Z' }),
    );

    const app = await buildServer({ repositories: repos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/reactor/experience' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.records).toHaveLength(2);

    await app.close();
  });

  it('filters by toolName via query string', async () => {
    // SCENARIO: 2 records with different toolNames; query restricts to one
    // INPUT: GET /reactor/experience?toolName=scoreVacancy
    // EXPECTED: 200, only the scoreVacancy record returned
    const repos = createRepositoriesProvider(h.db);
    await repos.experience.append(rec({ id: 'exp-001', toolName: 'generateCoverLetter' }));
    await repos.experience.append(
      rec({ id: 'exp-002', toolName: 'scoreVacancy', createdAt: '2026-04-26T00:01:00.000Z' }),
    );

    const app = await buildServer({ repositories: repos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/reactor/experience?toolName=scoreVacancy' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0]?.toolName).toBe('scoreVacancy');

    await app.close();
  });

  it('rejects invalid query param with 400', async () => {
    // SCENARIO: outcome must be one of 'success'|'failure'|'partial'; arbitrary value rejected
    // INPUT: GET /reactor/experience?outcome=banana
    // EXPECTED: 400 with RequestValidationError class
    const repos = createRepositoriesProvider(h.db);
    const app = await buildServer({ repositories: repos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/reactor/experience?outcome=banana' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error?.class).toBe('RequestValidationError');

    await app.close();
  });
});
