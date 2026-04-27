import { describe, it, expect, vi } from 'vitest';
import { createMockLLMProvider } from '../test-utils/mockLLM.js';

describe('createMockLLMProvider', () => {
  it('returns default content when no onComplete provided', async () => {
    // SCENARIO: zero-config mock
    // INPUT: factory called without args
    // EXPECTED: complete returns { content: 'mock response', model: 'mock' }
    const llm = createMockLLMProvider();
    const r = await llm.complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.content).toBe('mock response');
    expect(r.model).toBe('mock');
  });

  it('uses custom onComplete when provided', async () => {
    // SCENARIO: caller-controlled response
    // INPUT: onComplete returns { content: 'custom', model: 'custom-model', usage.totalTokens=42 }
    // EXPECTED: complete returns the custom response with usage forwarded
    const llm = createMockLLMProvider({
      onComplete: async () => ({
        content: 'custom',
        model: 'custom-model',
        usage: { totalTokens: 42 },
      }),
    });
    const r = await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.content).toBe('custom');
    expect(r.model).toBe('custom-model');
    expect(r.usage?.totalTokens).toBe(42);
  });

  it('forwards request to onComplete for assertions', async () => {
    // SCENARIO: tests assert on what messages the LLM saw
    // INPUT: onComplete is a vi.fn
    // EXPECTED: vi.fn called with the request object
    const onComplete = vi.fn().mockResolvedValue({ content: 'x', model: 'mock' });
    const llm = createMockLLMProvider({ onComplete });
    await llm.complete({
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hi' },
      ],
      jsonMode: true,
    });

    expect(onComplete).toHaveBeenCalledOnce();
    const callArg = onComplete.mock.calls[0]?.[0];
    expect(callArg).toEqual({
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hi' },
      ],
      jsonMode: true,
    });
  });

  it('provider has .name = "mock"', () => {
    // SCENARIO: SPI requires name field
    // EXPECTED
    const llm = createMockLLMProvider();
    expect(llm.name).toBe('mock');
  });
});
