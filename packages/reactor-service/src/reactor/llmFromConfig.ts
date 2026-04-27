// packages/reactor-service/src/reactor/llmFromConfig.ts
//
// Per-request LLMProvider construction. v0.1.0 supports openrouter only;
// other providers throw ProviderNotImplementedError. Decision #3: the service
// holds no API keys; each request carries its own providerConfig.

import { createOpenRouter } from '@kolosochek/reactor-core';
import type { LLMProvider } from '@kolosochek/reactor-core';

export type SupportedProvider = 'openrouter';

export interface ProviderConfig {
  provider: SupportedProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export class ProviderNotImplementedError extends Error {
  constructor(public readonly provider: string) {
    super(`Provider "${provider}" is not implemented in @reactor/service 0.1.0`);
    this.name = 'ProviderNotImplementedError';
  }
}

export function buildLLMProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case 'openrouter':
      return createOpenRouter({
        apiKey: config.apiKey,
        defaultModel: config.model,
        baseUrl: config.baseUrl,
      });
    default:
      throw new ProviderNotImplementedError(config.provider);
  }
}
