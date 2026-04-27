import { describe, it, expect } from 'vitest';
import { buildLLMProvider, ProviderNotImplementedError } from '../reactor/llmFromConfig.js';

describe('buildLLMProvider', () => {
  it('builds an openrouter LLMProvider from valid config', () => {
    // SCENARIO: openrouter is the only provider implemented in v0.1.0
    // INPUT: ProviderConfig { provider: 'openrouter', model, apiKey }
    // EXPECTED: returns LLMProvider with name matching /openrouter/i and a complete() function
    const llm = buildLLMProvider({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      apiKey: 'sk-test',
    });
    expect(llm.name.toLowerCase()).toContain('openrouter');
    expect(typeof llm.complete).toBe('function');
  });

  it('throws ProviderNotImplementedError for unsupported provider', () => {
    // SCENARIO: cerebras is not implemented in @kolosochek/reactor-core 0.2.0
    // INPUT: ProviderConfig with provider: 'cerebras'
    // EXPECTED: throw of ProviderNotImplementedError
    expect(() =>
      buildLLMProvider({
        provider: 'cerebras' as 'openrouter',
        model: 'x',
        apiKey: 'k',
      }),
    ).toThrow(ProviderNotImplementedError);
  });

  it('ProviderNotImplementedError carries provider name', () => {
    // SCENARIO: error must surface which provider was requested for actionable diagnostics
    // INPUT: ProviderConfig with provider: 'groq'
    // EXPECTED: thrown error is ProviderNotImplementedError with provider === 'groq'
    let captured: unknown = null;
    try {
      buildLLMProvider({
        provider: 'groq' as 'openrouter',
        model: 'x',
        apiKey: 'k',
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderNotImplementedError);
    expect((captured as ProviderNotImplementedError).provider).toBe('groq');
  });
});
