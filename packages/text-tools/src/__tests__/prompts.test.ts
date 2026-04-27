import { describe, it, expect } from 'vitest';
import { defaultCoverLetterPrompt, defaultScorePrompt, defaultQuestionsPrompt } from '../prompts/index.js';

describe('default prompts', () => {
  it('coverLetter has en and ru', () => {
    // SCENARIO: prompt registry exposes both locales
    // EXPECTED: en is non-empty; ru is non-empty
    expect(defaultCoverLetterPrompt.en.length).toBeGreaterThan(50);
    expect(defaultCoverLetterPrompt.ru.length).toBeGreaterThan(50);
  });

  it('score has en and ru', () => {
    expect(defaultScorePrompt.en.length).toBeGreaterThan(50);
    expect(defaultScorePrompt.ru.length).toBeGreaterThan(50);
  });

  it('questions has en and ru', () => {
    expect(defaultQuestionsPrompt.en.length).toBeGreaterThan(50);
    expect(defaultQuestionsPrompt.ru.length).toBeGreaterThan(50);
  });

  it('cover letter en prompt mentions cover letter', () => {
    // SCENARIO: prompt content sanity check
    // INPUT: en cover letter prompt
    // EXPECTED: contains "cover letter" substring (case-insensitive)
    expect(defaultCoverLetterPrompt.en.toLowerCase()).toContain('cover letter');
  });

  it('score en prompt mentions score or evaluation', () => {
    // SCENARIO: prompt content sanity check
    // EXPECTED: contains "score" or "evaluate" substring
    expect(defaultScorePrompt.en.toLowerCase()).toMatch(/score|evaluat/);
  });
});
