import { describe, it, expect } from 'vitest';
import {
  TextToolsError,
  IdeaSchemaError,
  IdeaContextMissingError,
  LLMTimeoutError,
  LLMQuotaError,
  LLMNetworkError,
  LLMOutputParseError,
  ActivityCancelledError,
} from '../errors.js';

describe('TextToolsError hierarchy', () => {
  it('all subclasses extend TextToolsError', () => {
    // SCENARIO: each subclass should inherit from TextToolsError
    // INPUT: instance of each
    // EXPECTED: instanceof TextToolsError is true
    expect(new IdeaSchemaError('x')).toBeInstanceOf(TextToolsError);
    expect(new IdeaContextMissingError('x')).toBeInstanceOf(TextToolsError);
    expect(new LLMTimeoutError('x')).toBeInstanceOf(TextToolsError);
    expect(new LLMQuotaError('x')).toBeInstanceOf(TextToolsError);
    expect(new LLMNetworkError('x', new Error('cause'))).toBeInstanceOf(TextToolsError);
    expect(new LLMOutputParseError({ rawContent: 'x', expectedSchema: 's' })).toBeInstanceOf(TextToolsError);
    expect(new ActivityCancelledError('x')).toBeInstanceOf(TextToolsError);
  });

  it('all subclasses also extend Error', () => {
    // SCENARIO: needed for try/catch interop
    // INPUT/EXPECTED: same instances are Error
    expect(new IdeaSchemaError('x')).toBeInstanceOf(Error);
    expect(new ActivityCancelledError('x')).toBeInstanceOf(Error);
  });

  it('LLMOutputParseError carries rawContent and expectedSchema', () => {
    // SCENARIO: structured fields for debugging
    // INPUT: error constructed with { rawContent, expectedSchema }
    // EXPECTED: fields readable; message includes the schema name
    const err = new LLMOutputParseError({
      rawContent: 'not json',
      expectedSchema: 'ScoreSolution',
    });
    expect(err.rawContent).toBe('not json');
    expect(err.expectedSchema).toBe('ScoreSolution');
    expect(err.message).toMatch(/ScoreSolution/);
  });

  it('LLMQuotaError accepts retryAfterMs', () => {
    // SCENARIO: 429 response returns Retry-After header
    // INPUT: error constructed with retryAfterMs
    // EXPECTED: field is readable
    const err = new LLMQuotaError('quota exceeded', { retryAfterMs: 30000 });
    expect(err.retryAfterMs).toBe(30000);
  });

  it('LLMNetworkError preserves cause', () => {
    // SCENARIO: wrap underlying network error for diagnostics
    // INPUT: cause = original Error
    // EXPECTED: err.cause references the original
    const cause = new Error('ECONNREFUSED');
    const err = new LLMNetworkError('network failure', cause);
    expect(err.cause).toBe(cause);
  });

  it('error class names are stable for downstream classification', () => {
    // SCENARIO: ExperienceRecord persists errorClass for analysis; class names must be stable
    // INPUT: each error
    // EXPECTED: name field equals the literal class name
    expect(new IdeaSchemaError('x').name).toBe('IdeaSchemaError');
    expect(new IdeaContextMissingError('x').name).toBe('IdeaContextMissingError');
    expect(new LLMTimeoutError('x').name).toBe('LLMTimeoutError');
    expect(new LLMQuotaError('x').name).toBe('LLMQuotaError');
    expect(new LLMNetworkError('x', new Error('c')).name).toBe('LLMNetworkError');
    expect(new LLMOutputParseError({ rawContent: 'x', expectedSchema: 's' }).name).toBe('LLMOutputParseError');
    expect(new ActivityCancelledError('x').name).toBe('ActivityCancelledError');
  });
});
