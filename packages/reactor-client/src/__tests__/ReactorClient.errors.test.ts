import { describe, it, expect, vi } from 'vitest';
import type { Idea } from '@kolosochek/reactor-core';
import { ReactorClient } from '../ReactorClient.js';
import { ReactorClientError } from '../errors.js';
import { LLMQuotaError, LLMTimeoutError, IdeaSchemaError } from '@dkolosovsky/reactor-text-tools';

const idea = { schema: { type: 'object' }, context: [], solution: null } satisfies Idea;
const providerConfig = { provider: 'openrouter' as const, model: 'm', apiKey: 'k' };

describe('ReactorClient error reconstruction', () => {
  it('reconstructs LLMQuotaError from 429 response with retryAfterMs', async () => {
    // SCENARIO: service responded 429 with { error.class: 'LLMQuotaError', retryAfterMs }
    // EXPECTED: client throws LLMQuotaError instance carrying retryAfterMs
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { class: 'LLMQuotaError', message: 'quota exceeded', retryAfterMs: 30000 } }),
        { status: 429 },
      ),
    );
    const client = new ReactorClient({ baseUrl: 'http://localhost:3030', fetchImpl: fetchSpy });

    let captured: unknown = null;
    try {
      await client.execute(idea, { providerConfig });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(LLMQuotaError);
    expect((captured as LLMQuotaError).retryAfterMs).toBe(30000);
  });

  it('reconstructs LLMTimeoutError from 504 response', async () => {
    // SCENARIO: upstream LLM timed out; service mapped to 504
    // EXPECTED: client throws LLMTimeoutError
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { class: 'LLMTimeoutError', message: 'timed out' } }),
        { status: 504 },
      ),
    );
    const client = new ReactorClient({ baseUrl: 'http://localhost:3030', fetchImpl: fetchSpy });
    await expect(client.execute(idea, { providerConfig })).rejects.toThrow(LLMTimeoutError);
  });

  it('reconstructs IdeaSchemaError from 400 response', async () => {
    // SCENARIO: service rejected the input as invalid
    // EXPECTED: client throws IdeaSchemaError
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { class: 'IdeaSchemaError', message: 'bad input' } }),
        { status: 400 },
      ),
    );
    const client = new ReactorClient({ baseUrl: 'http://localhost:3030', fetchImpl: fetchSpy });
    await expect(client.execute(idea, { providerConfig })).rejects.toThrow(IdeaSchemaError);
  });

  it('throws ReactorClientError on network failure', async () => {
    // SCENARIO: fetch itself rejects (DNS / connection refused)
    // EXPECTED: client wraps the underlying error in ReactorClientError
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new ReactorClient({ baseUrl: 'http://localhost:3030', fetchImpl: fetchSpy });
    await expect(client.execute(idea, { providerConfig })).rejects.toThrow(ReactorClientError);
  });

  it('throws ReactorClientError on unknown error class from service', async () => {
    // SCENARIO: service returned an error.class the client does not recognize
    // EXPECTED: client falls back to ReactorClientError surface
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { class: 'NeverHeardOfThis', message: 'mystery' } }),
        { status: 500 },
      ),
    );
    const client = new ReactorClient({ baseUrl: 'http://localhost:3030', fetchImpl: fetchSpy });
    await expect(client.execute(idea, { providerConfig })).rejects.toThrow(ReactorClientError);
  });

  it('throws ReactorClientError when error response is not JSON', async () => {
    // SCENARIO: 500 with plain-text body (e.g., proxy error page)
    // EXPECTED: ReactorClientError with non-JSON message
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('<html>500</html>', { status: 500, headers: { 'Content-Type': 'text/html' } }),
    );
    const client = new ReactorClient({ baseUrl: 'http://localhost:3030', fetchImpl: fetchSpy });
    await expect(client.execute(idea, { providerConfig })).rejects.toThrow(ReactorClientError);
  });
});
