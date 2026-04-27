// packages/reactor-client/src/errors.ts
//
// ReactorClientError covers HTTP-level issues (network failure, malformed
// response, unknown service error class). For activity-level errors,
// ReactorClient reconstructs typed TextToolsError subclasses from the
// service response body's error.class - they are re-exported here so
// consumers can do `instanceof LLMQuotaError` from a single import path.

export class ReactorClientError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'ReactorClientError';
  }
}

export {
  TextToolsError,
  IdeaSchemaError,
  IdeaContextMissingError,
  LLMTimeoutError,
  LLMQuotaError,
  LLMNetworkError,
  LLMOutputParseError,
  ActivityCancelledError,
} from '@reactor/text-tools';
