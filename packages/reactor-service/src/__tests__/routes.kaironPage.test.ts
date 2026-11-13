import { describe, it, expect } from 'vitest';
import { buildServer } from '../server.js';
import { DEMO_PHRASES } from '../kairon/sampleLlm.js';
import type { RepositoriesProvider } from '@kolosochek/reactor-core';

const stubRepos: RepositoriesProvider = {
  experience: { append: async () => {}, list: async () => [] },
  lessons: { list: async () => [], upsert: async () => {}, remove: async () => {} },
  ideas: { save: async () => 'stub', load: async () => null, list: async () => [] },
  predictions: { save: async () => {}, list: async () => [] },
  tools: { list: async () => [], get: async () => null, upsert: async () => {} },
};

describe('GET /kairon', () => {
  it('serves the forecast prototype chat page from the service origin', async () => {
    // SCENARIO: DEV-1364 page is served next to /reactor/execute, so the page posts same-origin
    // INPUT: GET /kairon
    // EXPECTED: status 200, text/html, the page title "Kairon forecast agent"
    const app = await buildServer({ repositories: stubRepos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/kairon' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<title>Kairon forecast agent</title>');

    await app.close();
  });

  it('serves the demo phrases the sample model answers', async () => {
    // SCENARIO: the page offers the demo phrases as chips and checks a typed phrase before a sample run (Task 16 ruling)
    // INPUT: GET /kairon/demo-phrases
    // EXPECTED: status 200, { phrases: DEMO_PHRASES }
    const app = await buildServer({ repositories: stubRepos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/kairon/demo-phrases' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ phrases: [...DEMO_PHRASES] });

    await app.close();
  });

  it('serves the card renderer module next to the page', async () => {
    // SCENARIO: DEV-1376, the page imports its renderers as an ES module from the service origin
    // INPUT: GET /kairon/assets/kairon-render.mjs
    // EXPECTED: status 200, text/javascript, the module exports renderVerdict
    const app = await buildServer({ repositories: stubRepos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/kairon/assets/kairon-render.mjs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.body).toContain('export function renderVerdict(');

    await app.close();
  });
});
