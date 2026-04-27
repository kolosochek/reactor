import { describe, it, expect } from 'vitest';
import { textToolsAdapter } from '../adapter.js';

describe('textToolsAdapter', () => {
  it('has correct name and version', () => {
    // SCENARIO/EXPECTED
    expect(textToolsAdapter.name).toBe('text-tools');
    expect(textToolsAdapter.version).toBe('0.1.0');
  });

  it('exposes 3 tools: generateCoverLetter, scoreVacancy, answerQuestions', () => {
    const names = textToolsAdapter.tools.map((t) => t.name).sort();
    expect(names).toEqual(['answerQuestions', 'generateCoverLetter', 'scoreVacancy']);
  });

  it('activities cover every tool', () => {
    // SCENARIO: each tool has a registered activity
    // EXPECTED: activities[name] is a function for each tool name
    for (const tool of textToolsAdapter.tools) {
      expect(textToolsAdapter.activities[tool.name]).toBeTypeOf('function');
    }
  });

  it('exposes textToolsDomain via .domain', () => {
    // PLAN CORRECTION: DomainContext.domain (not .name)
    expect(textToolsAdapter.domain?.domain).toBe('text-tools');
  });

  it('does not provide repositories (consumers inject)', () => {
    // SCENARIO: textToolsAdapter is a pure-tools adapter; consumers provide their own repositories
    // EXPECTED: repositories is undefined
    expect(textToolsAdapter.repositories).toBeUndefined();
  });
});
