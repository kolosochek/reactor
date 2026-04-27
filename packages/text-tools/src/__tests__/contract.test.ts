import { describe } from 'vitest';
import { createMockLLMProvider } from '../test-utils/mockLLM.js';
import { runLLMProviderContractTests } from '../test-utils/contract.js';

// Self-test: the contract suite runs against the mock provider.
runLLMProviderContractTests(describe, () =>
  createMockLLMProvider({
    onComplete: async (req) => ({
      content: req.jsonMode === true ? '{"ok":true}' : 'mock content',
      model: 'mock',
      usage: { totalTokens: 10 },
    }),
  }),
);
