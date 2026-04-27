import { describe, it, expect } from 'vitest';
import { buildCoverLetterIdea, buildScoreIdea, buildQuestionsIdea } from '../builders.js';

const v = { title: 'FE', description: 'd' };
const r = { title: 'X', content: 'Y' };

describe('text-tools builders', () => {
  it('buildCoverLetterIdea returns direct-mode Idea', () => {
    // SCENARIO: minimal input
    // INPUT: vacancy + resume
    // EXPECTED: idea has Meta + DataMessage with _call._tool='generateCoverLetter'; solution null
    const idea = buildCoverLetterIdea({ vacancy: v, resume: r });

    expect(idea.solution).toBeNull();
    expect(idea.context.length).toBe(2);

    const meta = idea.context.find((m) => m.type === 'meta');
    expect(meta).toBeDefined();
    expect((meta as { meta: { domain: string } }).meta.domain).toBe('text-tools');

    const data = idea.context.find((m) => m.type === 'data');
    expect(data).toBeDefined();
    const call = (data as { _call: { _tool: string } })._call;
    expect(call._tool).toBe('generateCoverLetter');
  });

  it('buildCoverLetterIdea throws on bad input (Zod)', () => {
    // SCENARIO: missing description
    // INPUT: vacancy lacking description
    // EXPECTED: throws
    expect(() =>
      buildCoverLetterIdea({ vacancy: { title: 'x' } as unknown as { title: string; description: string }, resume: r }),
    ).toThrow();
  });

  it('buildScoreIdea returns direct-mode Idea with scoreVacancy call', () => {
    // SCENARIO: minimal input
    // INPUT: vacancy + resume
    // EXPECTED: data message _call._tool='scoreVacancy'
    const idea = buildScoreIdea({ vacancy: v, resume: r });
    const data = idea.context.find((m) => m.type === 'data');
    expect((data as { _call: { _tool: string } })._call._tool).toBe('scoreVacancy');
  });

  it('buildQuestionsIdea returns direct-mode Idea with answerQuestions call', () => {
    // SCENARIO: minimal input with one question
    // INPUT: vacancy + resume + questions array
    // EXPECTED: data message _call._tool='answerQuestions'
    const idea = buildQuestionsIdea({ vacancy: v, resume: r, questions: ['q'] });
    const data = idea.context.find((m) => m.type === 'data');
    expect((data as { _call: { _tool: string } })._call._tool).toBe('answerQuestions');
  });

  it('builders generate well-formed paths', () => {
    // SCENARIO: paths have predictable shape
    // INPUT: cover letter idea
    // EXPECTED: starts with /cover-letter/<ISO>
    const a = buildCoverLetterIdea({ vacancy: v, resume: r });
    const aMeta = a.context.find((m) => m.type === 'meta') as { meta: { path: string } };
    expect(aMeta.meta.path).toMatch(/^\/cover-letter\/\d{4}-\d{2}-\d{2}T/);
  });
});
