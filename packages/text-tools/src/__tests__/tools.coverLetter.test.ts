import { describe, it, expect } from 'vitest';
import {
  CoverLetterInput,
  CoverLetterSolution,
  CoverLetterTool,
} from '../tools/coverLetter.js';

describe('CoverLetter tool', () => {
  it('CoverLetterInput accepts minimal valid input', () => {
    // SCENARIO: vacancy + resume (defaults applied)
    // INPUT: vacancy + resume only
    // EXPECTED: parses; locale defaults to 'en'; prompt undefined
    const out = CoverLetterInput.parse({
      vacancy: { title: 'Senior Frontend', description: 'React, TypeScript' },
      resume: { title: 'Frontend Eng', content: 'Years of React experience' },
    });
    expect(out.locale).toBe('en');
    expect(out.prompt).toBeUndefined();
  });

  it('CoverLetterInput accepts vacancy.url and platform optional fields', () => {
    // SCENARIO: full vacancy metadata
    // INPUT: vacancy with all four fields
    // EXPECTED: passes through unchanged
    const out = CoverLetterInput.parse({
      vacancy: {
        title: 'Senior Frontend',
        description: 'React',
        url: 'https://hh.ru/vacancy/42',
        platform: 'hh.ru',
      },
      resume: { title: 'X', content: 'Y' },
    });
    expect(out.vacancy.url).toBe('https://hh.ru/vacancy/42');
    expect(out.vacancy.platform).toBe('hh.ru');
  });

  it('CoverLetterInput accepts empty vacancy.title', () => {
    // SCENARIO: title is required string but z.string() allows ''
    // INPUT: title=''
    // EXPECTED: parses; matches the lenient 0.1.0 contract
    const out = CoverLetterInput.parse({
      vacancy: { title: '', description: 'desc' },
      resume: { title: 'X', content: 'Y' },
    });
    expect(out.vacancy.title).toBe('');
  });

  it('CoverLetterInput rejects bad URL format', () => {
    // SCENARIO: url field uses Zod url validator
    // INPUT: url='not-a-url'
    // EXPECTED: throws
    expect(() =>
      CoverLetterInput.parse({
        vacancy: { title: 't', description: 'd', url: 'not-a-url' },
        resume: { title: 'X', content: 'Y' },
      }),
    ).toThrow();
  });

  it('CoverLetterInput rejects locale outside enum', () => {
    // SCENARIO: locale must be 'en' or 'ru'
    // INPUT: locale='fr'
    // EXPECTED: throws
    expect(() =>
      CoverLetterInput.parse({
        vacancy: { title: 't', description: 'd' },
        resume: { title: 'X', content: 'Y' },
        locale: 'fr',
      }),
    ).toThrow();
  });

  it('CoverLetterSolution requires letter and durationMs; tokensUsed optional', () => {
    // SCENARIO: solution shape is letter + durationMs always; tokensUsed optional
    // INPUT: minimal solution
    // EXPECTED: parses; letter min length 1
    const out = CoverLetterSolution.parse({
      letter: 'Dear hiring manager...',
      durationMs: 1234,
    });
    expect(out.letter).toBe('Dear hiring manager...');
    expect(out.tokensUsed).toBeUndefined();
  });

  it('CoverLetterSolution rejects empty letter', () => {
    // SCENARIO: empty letter is meaningless
    // INPUT: letter='', durationMs=0
    // EXPECTED: throws
    expect(() => CoverLetterSolution.parse({ letter: '', durationMs: 0 })).toThrow();
  });

  it('CoverLetterTool conforms to Adapter Tool shape', () => {
    // SCENARIO: tool def has name + description + category + inputSchema + outputSchema
    // EXPECTED: all fields present; category is 'transformation'
    expect(CoverLetterTool.name).toBe('generateCoverLetter');
    expect(CoverLetterTool.description).toBeTruthy();
    expect(CoverLetterTool.category).toBe('transformation');
    expect(CoverLetterTool.inputSchema).toMatchObject({ type: 'object' });
    expect(CoverLetterTool.outputSchema).toMatchObject({ type: 'object' });
  });
});
