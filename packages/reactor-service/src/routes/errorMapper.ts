// packages/reactor-service/src/routes/errorMapper.ts
//
// Centralized mapping from TextToolsError hierarchy and unknown throws into
// HTTP status + structured response body. Used by every route that may
// surface activity / reactor errors.

import {
  TextToolsError,
  IdeaSchemaError,
  IdeaContextMissingError,
  LLMTimeoutError,
  LLMQuotaError,
  LLMNetworkError,
  LLMOutputParseError,
  ActivityCancelledError,
} from '@reactor/text-tools';

export interface ErrorResponseBody {
  error: {
    class: string;
    message: string;
    retryAfterMs?: number;
  };
}

export interface MappedResponse {
  status: number;
  body: ErrorResponseBody;
}

export function mapErrorToResponse(err: unknown): MappedResponse {
  if (err instanceof IdeaSchemaError) {
    return mk(400, 'IdeaSchemaError', err.message);
  }
  if (err instanceof IdeaContextMissingError) {
    return mk(400, 'IdeaContextMissingError', err.message);
  }
  if (err instanceof LLMTimeoutError) {
    return mk(504, 'LLMTimeoutError', err.message);
  }
  if (err instanceof LLMQuotaError) {
    return mk(429, 'LLMQuotaError', err.message, err.retryAfterMs);
  }
  if (err instanceof LLMNetworkError) {
    return mk(502, 'LLMNetworkError', err.message);
  }
  if (err instanceof LLMOutputParseError) {
    return mk(502, 'LLMOutputParseError', err.message);
  }
  if (err instanceof ActivityCancelledError) {
    return mk(499, 'ActivityCancelledError', err.message);
  }
  if (err instanceof TextToolsError) {
    return mk(500, err.name, err.message);
  }
  if (err instanceof Error) {
    return mk(500, 'ServiceError', err.message);
  }
  return mk(500, 'ServiceError', String(err));
}

function mk(
  status: number,
  className: string,
  message: string,
  retryAfterMs?: number,
): MappedResponse {
  return {
    status,
    body: {
      error: {
        class: className,
        message,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    },
  };
}
