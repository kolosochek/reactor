import { describe, it, expect } from 'vitest';
import { mapErrorToResponse } from '../routes/errorMapper.js';
import {
  IdeaSchemaError,
  IdeaContextMissingError,
  LLMTimeoutError,
  LLMQuotaError,
  LLMNetworkError,
  LLMOutputParseError,
  ActivityCancelledError,
} from '@dkolosovsky/reactor-text-tools';

describe('mapErrorToResponse', () => {
  it('IdeaSchemaError -> 400', () => {
    // SCENARIO: input validation failure surfaced as a typed error
    // INPUT: new IdeaSchemaError('bad input')
    // EXPECTED: status 400, body.error.class === 'IdeaSchemaError', message preserved
    const r = mapErrorToResponse(new IdeaSchemaError('bad input'));
    expect(r.status).toBe(400);
    expect(r.body.error.class).toBe('IdeaSchemaError');
    expect(r.body.error.message).toBe('bad input');
  });

  it('IdeaContextMissingError -> 400', () => {
    // SCENARIO: triplet context message is missing
    // INPUT: new IdeaContextMissingError('no input message')
    // EXPECTED: status 400, body.error.class === 'IdeaContextMissingError'
    const r = mapErrorToResponse(new IdeaContextMissingError('no input message'));
    expect(r.status).toBe(400);
    expect(r.body.error.class).toBe('IdeaContextMissingError');
  });

  it('LLMTimeoutError -> 504', () => {
    // SCENARIO: upstream LLM exceeded the timeout
    // EXPECTED: 504 Gateway Timeout class
    const r = mapErrorToResponse(new LLMTimeoutError('timed out'));
    expect(r.status).toBe(504);
    expect(r.body.error.class).toBe('LLMTimeoutError');
  });

  it('LLMQuotaError -> 429 with retryAfterMs surfaced', () => {
    // SCENARIO: provider rate-limit hit; client should know when to retry
    // INPUT: LLMQuotaError with retryAfterMs: 30000
    // EXPECTED: status 429, body.error.retryAfterMs === 30000
    const r = mapErrorToResponse(new LLMQuotaError('quota exceeded', { retryAfterMs: 30000 }));
    expect(r.status).toBe(429);
    expect(r.body.error.class).toBe('LLMQuotaError');
    expect(r.body.error.retryAfterMs).toBe(30000);
  });

  it('LLMNetworkError -> 502', () => {
    // SCENARIO: network failure reaching the LLM provider
    // EXPECTED: 502 Bad Gateway class
    const r = mapErrorToResponse(new LLMNetworkError('net fail', new Error('cause')));
    expect(r.status).toBe(502);
    expect(r.body.error.class).toBe('LLMNetworkError');
  });

  it('LLMOutputParseError -> 502', () => {
    // SCENARIO: LLM responded but the body did not match the expected schema
    // EXPECTED: 502 Bad Gateway class (upstream produced unparsable output)
    const r = mapErrorToResponse(
      new LLMOutputParseError({ rawContent: 'x', expectedSchema: 'ScoreSolution' }),
    );
    expect(r.status).toBe(502);
    expect(r.body.error.class).toBe('LLMOutputParseError');
  });

  it('ActivityCancelledError -> 499', () => {
    // SCENARIO: client closed the connection / aborted mid-execution
    // EXPECTED: 499 Client Closed Request (nginx convention)
    const r = mapErrorToResponse(new ActivityCancelledError('cancelled'));
    expect(r.status).toBe(499);
    expect(r.body.error.class).toBe('ActivityCancelledError');
  });

  it('unknown Error -> 500 ServiceError', () => {
    // SCENARIO: a generic Error escaped the typed hierarchy
    // EXPECTED: 500 with class 'ServiceError', message preserved
    const r = mapErrorToResponse(new Error('generic'));
    expect(r.status).toBe(500);
    expect(r.body.error.class).toBe('ServiceError');
    expect(r.body.error.message).toBe('generic');
  });

  it('non-Error thrown value -> 500 ServiceError', () => {
    // SCENARIO: someone threw a string
    // EXPECTED: 500 with class 'ServiceError', message stringified
    const r = mapErrorToResponse('string thrown');
    expect(r.status).toBe(500);
    expect(r.body.error.class).toBe('ServiceError');
    expect(r.body.error.message).toBe('string thrown');
  });
});
