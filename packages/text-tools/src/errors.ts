// packages/text-tools/src/errors.ts
//
// Typed error hierarchy. Per spec section 7. Each subclass has a stable
// `name` field used by Reactor.appendExperience to populate
// ExperienceRecord.errorClass for downstream classification.

export class TextToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextToolsError';
  }
}

export class IdeaSchemaError extends TextToolsError {
  constructor(message: string) {
    super(message);
    this.name = 'IdeaSchemaError';
  }
}

export class IdeaContextMissingError extends TextToolsError {
  constructor(message: string) {
    super(message);
    this.name = 'IdeaContextMissingError';
  }
}

export class LLMTimeoutError extends TextToolsError {
  constructor(message: string) {
    super(message);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMQuotaError extends TextToolsError {
  retryAfterMs?: number;
  constructor(message: string, opts?: { retryAfterMs?: number }) {
    super(message);
    this.name = 'LLMQuotaError';
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

export class LLMNetworkError extends TextToolsError {
  cause: Error;
  constructor(message: string, cause: Error) {
    super(message);
    this.name = 'LLMNetworkError';
    this.cause = cause;
  }
}

export class LLMOutputParseError extends TextToolsError {
  rawContent: string;
  expectedSchema: string;
  constructor(opts: { rawContent: string; expectedSchema: string }) {
    super(`LLM output did not match schema "${opts.expectedSchema}"`);
    this.name = 'LLMOutputParseError';
    this.rawContent = opts.rawContent;
    this.expectedSchema = opts.expectedSchema;
  }
}

export class ActivityCancelledError extends TextToolsError {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityCancelledError';
  }
}
