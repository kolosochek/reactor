import { describe, it, expect, vi } from 'vitest';
import { answerQuestionsActivity } from '../activities/questions.js';
import { createMockLLMProvider } from '../test-utils/mockLLM.js';
import { LLMOutputParseError } from '../errors.js';
import type { ActivityContext } from '@kolosochek/reactor-core';

const baseInput = {
  vacancy: { title: 'FE', description: 'React' },
  resume: { title: 'FE Eng', content: 'React experience' },
  questions: ['What is your salary expectation?', 'When can you start?'],
};

function makeCtx(content: string): ActivityContext {
  return {
    state: {},
    llm: createMockLLMProvider({
      onComplete: async () => ({ content, model: 'mock', usage: { totalTokens: 50 } }),
    }),
  };
}

describe('answerQuestionsActivity', () => {
  it('parses qaPairs from valid JSON LLM response', async () => {
    // SCENARIO: well-formed JSON output with two qa pairs
    // INPUT: JSON with two qaPairs covering both questions
    // EXPECTED: result.qaPairs.length === 2
    const json = JSON.stringify({
      qaPairs: [
        { question: 'What is your salary expectation?', answer: '150k' },
        { question: 'When can you start?', answer: '2 weeks notice' },
      ],
    });
    const result = await answerQuestionsActivity(baseInput, makeCtx(json));
    expect((result as { qaPairs: unknown[] }).qaPairs.length).toBe(2);
  });

  it('extracts JSON from markdown fence', async () => {
    // SCENARIO: LLM wraps JSON in a ```json fence
    // INPUT: fenced JSON with a single qa pair
    // EXPECTED: result.qaPairs.length === 1
    const json = '```json\n{"qaPairs":[{"question":"q","answer":"a"}]}\n```';
    const result = await answerQuestionsActivity(baseInput, makeCtx(json));
    expect((result as { qaPairs: unknown[] }).qaPairs.length).toBe(1);
  });

  it('throws LLMOutputParseError on unparseable content', async () => {
    // SCENARIO: LLM returns nonsense
    // INPUT: 'xxx'
    // EXPECTED: rejection with LLMOutputParseError
    await expect(answerQuestionsActivity(baseInput, makeCtx('xxx'))).rejects.toThrow(
      LLMOutputParseError,
    );
  });

  it('rejects empty questions array via Zod', async () => {
    // SCENARIO: caller passes [] which violates QuestionsInput.questions.min(1)
    // INPUT: questions: []
    // EXPECTED: rejection from Zod input parse
    await expect(
      answerQuestionsActivity(
        { ...baseInput, questions: [] },
        makeCtx('{"qaPairs":[]}'),
      ),
    ).rejects.toThrow();
  });

  it('passes user content with question list to LLM', async () => {
    // SCENARIO: question list is rendered into the user message
    // INPUT: baseInput with two questions
    // EXPECTED: user message contains both question texts
    const onComplete = vi.fn().mockResolvedValue({
      content: '{"qaPairs":[{"question":"q","answer":"a"}]}',
      model: 'mock',
    });
    await answerQuestionsActivity(baseInput, {
      state: {},
      llm: createMockLLMProvider({ onComplete }),
    });
    const userMsg = onComplete.mock.calls[0]?.[0]?.messages?.[1]?.content ?? '';
    expect(userMsg).toContain('What is your salary expectation?');
    expect(userMsg).toContain('When can you start?');
  });
});
