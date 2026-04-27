// packages/reactor-client/src/ReactorClient.ts
//
// HTTP client for @dkolosovsky/reactor-service. Pure fetch-based; works in both browser
// (Chrome MV3 service worker) and Node. Reconstructs typed TextToolsError
// subclasses from { error: { class, ... } } bodies so consumer try/catch
// behaves the same as if Reactor were embedded.

import {
  IdeaSchemaError,
  IdeaContextMissingError,
  LLMTimeoutError,
  LLMQuotaError,
  LLMNetworkError,
  LLMOutputParseError,
  ActivityCancelledError,
} from '@dkolosovsky/reactor-text-tools';
import type { Idea, Solution } from '@kolosochek/reactor-core';
import { ReactorClientError } from './errors.js';

export interface ReactorClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface ProviderConfig {
  provider: 'openrouter' | 'cerebras' | 'openai' | 'groq' | 'deepseek' | 'xai';
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
}

export interface ExecuteOptions {
  providerConfig: ProviderConfig;
  signal?: AbortSignal;
}

interface ServiceErrorBody {
  error: { class: string; message: string; retryAfterMs?: number };
}

export class ReactorClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ReactorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async execute(idea: Idea, opts: ExecuteOptions): Promise<Solution> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/reactor/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea, providerConfig: opts.providerConfig }),
        signal: opts.signal,
      });
    } catch (err) {
      throw new ReactorClientError(
        `Network error contacting reactor service: ${(err as Error).message}`,
        err as Error,
      );
    }

    if (res.ok) {
      const body = (await res.json()) as { solution: Solution };
      return body.solution;
    }

    let errorBody: ServiceErrorBody;
    try {
      errorBody = (await res.json()) as ServiceErrorBody;
    } catch {
      throw new ReactorClientError(`Service responded ${res.status} with non-JSON body`);
    }
    throw reconstructError(errorBody.error);
  }
}

function reconstructError(e: ServiceErrorBody['error']): Error {
  switch (e.class) {
    case 'IdeaSchemaError':
      return new IdeaSchemaError(e.message);
    case 'IdeaContextMissingError':
      return new IdeaContextMissingError(e.message);
    case 'LLMTimeoutError':
      return new LLMTimeoutError(e.message);
    case 'LLMQuotaError':
      return new LLMQuotaError(e.message, { retryAfterMs: e.retryAfterMs });
    case 'LLMNetworkError':
      return new LLMNetworkError(e.message, new Error('reconstructed from service response'));
    case 'LLMOutputParseError':
      return new LLMOutputParseError({ rawContent: '', expectedSchema: e.message });
    case 'ActivityCancelledError':
      return new ActivityCancelledError(e.message);
    default:
      return new ReactorClientError(`Unknown error class "${e.class}": ${e.message}`);
  }
}
