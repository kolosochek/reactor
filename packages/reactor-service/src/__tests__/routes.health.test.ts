import { describe, it, expect } from 'vitest';
import { buildServer } from '../server.js';
import type { RepositoriesProvider } from '@kolosochek/reactor-core';

const stubRepos: RepositoriesProvider = {
  experience: { append: async () => {}, list: async () => [] },
  lessons: { list: async () => [], upsert: async () => {}, remove: async () => {} },
  ideas: { save: async () => 'stub', load: async () => null, list: async () => [] },
  predictions: { save: async () => {}, list: async () => [] },
  tools: { list: async () => [], get: async () => null, upsert: async () => {} },
};

describe('GET /reactor/health', () => {
  it('returns 200 with { ok: true } when service is up', async () => {
    // SCENARIO: liveness probe used by Docker / consumer 'is service alive?' check
    // INPUT: GET /reactor/health
    // EXPECTED: status 200, body === { ok: true } (no DB hit required for v0.1.0)
    const app = await buildServer({ repositories: stubRepos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/reactor/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await app.close();
  });
});
