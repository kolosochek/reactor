// packages/text-tools/src/test-utils/mockLLM.ts
//
// Reusable mock LLMProvider for tests across text-tools, extension, and adapter.
// Per spec section 6.1.

import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
} from '@kolosochek/reactor-core';

export interface CreateMockLLMProviderOptions {
  /** When provided, replaces the default echo-style response. */
  onComplete?: (req: LLMCompletionRequest) => Promise<LLMCompletionResponse>;
}

export function createMockLLMProvider(opts?: CreateMockLLMProviderOptions): LLMProvider {
  const onComplete = opts?.onComplete;
  return {
    name: 'mock',
    async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
      if (onComplete !== undefined) return onComplete(req);
      return { content: 'mock response', model: 'mock' };
    },
  };
}
