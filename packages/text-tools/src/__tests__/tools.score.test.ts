import { describe, it, expect } from 'vitest';
import { ScoreInput, ScoreSolution, SkillMatch, ScoreTool } from '../tools/score.js';

describe('Score tool', () => {
  it('ScoreInput accepts minimal valid input', () => {
    // SCENARIO: vacancy + resume
    // INPUT: vacancy + resume only
    // EXPECTED: parses; locale defaults to 'en'
    const out = ScoreInput.parse({
      vacancy: { title: 'Senior FE', description: 'React' },
      resume: { title: 'X', content: 'Y' },
    });
    expect(out.locale).toBe('en');
  });

  it('SkillMatch accepts arrays for matched/missing/extra', () => {
    // SCENARIO: skillMatch shape is three arrays of strings
    // INPUT: matched/missing/extra each non-empty
    // EXPECTED: parses
    const out = SkillMatch.parse({
      matched: ['React', 'TypeScript'],
      missing: ['Rust'],
      extra: ['Vue'],
    });
    expect(out.matched).toEqual(['React', 'TypeScript']);
    expect(out.missing).toEqual(['Rust']);
    expect(out.extra).toEqual(['Vue']);
  });

  it('ScoreSolution requires score 0-100, reasoning, durationMs', () => {
    // SCENARIO: minimal valid solution
    // INPUT: score=75, reasoning, durationMs
    // EXPECTED: parses; skillMatch undefined
    const out = ScoreSolution.parse({
      score: 75,
      reasoning: 'Strong match on core skills',
      durationMs: 1234,
    });
    expect(out.score).toBe(75);
    expect(out.skillMatch).toBeUndefined();
  });

  it('ScoreSolution rejects score > 100', () => {
    // SCENARIO: score is bounded 0..100
    // INPUT: score=150
    // EXPECTED: throws
    expect(() =>
      ScoreSolution.parse({ score: 150, reasoning: 'r', durationMs: 0 }),
    ).toThrow();
  });

  it('ScoreSolution rejects score < 0', () => {
    // SCENARIO: score lower bound
    // INPUT: score=-1
    // EXPECTED: throws
    expect(() =>
      ScoreSolution.parse({ score: -1, reasoning: 'r', durationMs: 0 }),
    ).toThrow();
  });

  it('ScoreSolution rejects non-integer score', () => {
    // SCENARIO: score must be integer
    // INPUT: score=75.5
    // EXPECTED: throws
    expect(() =>
      ScoreSolution.parse({ score: 75.5, reasoning: 'r', durationMs: 0 }),
    ).toThrow();
  });

  it('ScoreSolution accepts skillMatch optional field', () => {
    // SCENARIO: skillMatch is optional but valid when present
    // INPUT: skillMatch with all three arrays
    // EXPECTED: passes through
    const out = ScoreSolution.parse({
      score: 80,
      reasoning: 'r',
      skillMatch: { matched: ['a'], missing: ['b'], extra: ['c'] },
      durationMs: 100,
    });
    expect(out.skillMatch).toEqual({ matched: ['a'], missing: ['b'], extra: ['c'] });
  });

  it('ScoreTool conforms to Adapter Tool shape', () => {
    // SCENARIO: tool def has name + category + schemas
    // EXPECTED: name='scoreVacancy'; category='aggregation'
    expect(ScoreTool.name).toBe('scoreVacancy');
    expect(ScoreTool.category).toBe('aggregation');
    expect(ScoreTool.inputSchema).toMatchObject({ type: 'object' });
    expect(ScoreTool.outputSchema).toMatchObject({ type: 'object' });
  });
});
