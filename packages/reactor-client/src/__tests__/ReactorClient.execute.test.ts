import { describe, it, expect, vi } from 'vitest';
import type { Idea } from '@kolosochek/reactor-core';
import { ReactorClient } from '../ReactorClient.js';

describe('ReactorClient.execute', () => {
  it('POSTs to /reactor/execute with idea + providerConfig', async () => {
    // SCENARIO: client packages the request body and dispatches to the right URL
    // INPUT: idea + providerConfig
    // EXPECTED: fetch called once with POST + JSON body containing both fields; returned solution.output passes through
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ solution: { meta: {}, calls: [], output: { letter: 'L' } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new ReactorClient({ baseUrl: 'http://localhost:3030', fetchImpl: fetchSpy });

    const idea = { schema: { type: 'object' }, context: [], solution: null } satisfies Idea;
    const sol = await client.execute(idea, {
      providerConfig: { provider: 'openrouter', model: 'm', apiKey: 'k' },
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callArg = fetchSpy.mock.calls[0]?.[0];
    expect(callArg).toBe('http://localhost:3030/reactor/execute');
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.idea).toEqual(idea);
    expect(body.providerConfig.provider).toBe('openrouter');

    expect(sol.output).toEqual({ letter: 'L' });
  });

  it('strips trailing slash from baseUrl', async () => {
    // SCENARIO: consumer passes 'http://x/' with trailing slash
    // EXPECTED: client normalizes to 'http://x' before appending /reactor/execute
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ solution: { meta: {}, calls: [], output: {} } }),
        { status: 200 },
      ),
    );
    const client = new ReactorClient({ baseUrl: 'http://localhost:3030/', fetchImpl: fetchSpy });
    await client.execute(
      { schema: { type: 'object' }, context: [], solution: null } satisfies Idea,
      { providerConfig: { provider: 'openrouter', model: 'm', apiKey: 'k' } },
    );
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://localhost:3030/reactor/execute');
  });

  it('forwards AbortSignal to fetch', async () => {
    // SCENARIO: caller provides an AbortController for cancellation
    // EXPECTED: fetch receives the same signal instance
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ solution: { meta: {}, calls: [], output: {} } }), { status: 200 }),
    );
    const client = new ReactorClient({ baseUrl: 'http://localhost:3030', fetchImpl: fetchSpy });
    const ac = new AbortController();
    await client.execute(
      { schema: { type: 'object' }, context: [], solution: null } satisfies Idea,
      { providerConfig: { provider: 'openrouter', model: 'm', apiKey: 'k' }, signal: ac.signal },
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(ac.signal);
  });
});
