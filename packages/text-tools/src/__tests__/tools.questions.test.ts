import { describe, it, expect } from 'vitest';
import {
  QuestionsInput,
  QuestionsSolution,
  QuestionAnswerPair,
  QuestionsTool,
} from '../tools/questions.js';

describe('Questions tool', () => {
  it('QuestionsInput requires non-empty questions array', () => {
    // SCENARIO: questions array must have at least one item
    // INPUT: questions=[]
    // EXPECTED: throws
    expect(() =>
      QuestionsInput.parse({
        vacancy: { title: 't', description: 'd' },
        resume: { title: 'X', content: 'Y' },
        questions: [],
      }),
    ).toThrow();
  });

  it('QuestionsInput rejects empty question strings', () => {
    // SCENARIO: each question must be non-empty string
    // INPUT: questions=['']
    // EXPECTED: throws
    expect(() =>
      QuestionsInput.parse({
        vacancy: { title: 't', description: 'd' },
        resume: { title: 'X', content: 'Y' },
        questions: [''],
      }),
    ).toThrow();
  });

  it('QuestionAnswerPair requires question and answer', () => {
    // SCENARIO: pair shape requires both fields
    // INPUT: question + answer
    // EXPECTED: parses
    const out = QuestionAnswerPair.parse({
      question: 'What is your salary expectation?',
      answer: 'Open to discussion',
    });
    expect(out.question).toBe('What is your salary expectation?');
  });

  it('QuestionsSolution requires qaPairs and durationMs', () => {
    // SCENARIO: solution shape is qaPairs + durationMs
    // INPUT: one pair, durationMs=100
    // EXPECTED: parses; qaPairs.length=1
    const out = QuestionsSolution.parse({
      qaPairs: [{ question: 'q1', answer: 'a1' }],
      durationMs: 100,
    });
    expect(out.qaPairs.length).toBe(1);
  });

  it('QuestionsTool conforms to Adapter Tool shape', () => {
    // SCENARIO: tool def has name + category
    // EXPECTED: name='answerQuestions'; category='transformation'
    expect(QuestionsTool.name).toBe('answerQuestions');
    expect(QuestionsTool.category).toBe('transformation');
  });
});
