import { describe, it, expect, vi } from 'vitest';
import { generateCoverLetterActivity } from '../activities/coverLetter.js';
import { createMockLLMProvider } from '../test-utils/mockLLM.js';
import type { ActivityContext } from '@kolosochek/reactor-core';

const baseInput = {
  vacancy: { title: 'Senior Frontend', description: 'React, TypeScript, 5+ years' },
  resume: { title: 'Frontend Eng', content: '7 years React, TypeScript, GraphQL' },
};

function makeCtx(opts?: { llm?: ReturnType<typeof createMockLLMProvider> }): ActivityContext {
  return {
    state: {},
    llm:
      opts?.llm ??
      createMockLLMProvider({
        onComplete: async () => ({
          content: 'Dear hiring manager,\n\nI am writing to apply...',
          model: 'mock',
        }),
      }),
  };
}

describe('generateCoverLetterActivity', () => {
  it('returns Solution with letter from LLM response', async () => {
    // SCENARIO: minimal input, mock LLM returns canned letter
    // INPUT: vacancy + resume; default locale en
    // EXPECTED: result has letter, durationMs, no tokensUsed
    const result = await generateCoverLetterActivity(baseInput, makeCtx());

    expect(result).toMatchObject({
      letter: 'Dear hiring manager,\n\nI am writing to apply...',
      durationMs: expect.any(Number),
    });
  });

  it('passes default en prompt when no prompt provided', async () => {
    // SCENARIO: locale defaults to en when omitted
    // INPUT: baseInput without prompt
    // EXPECTED: system message contains the en cover-letter prompt phrasing
    const onComplete = vi.fn().mockResolvedValue({ content: 'L', model: 'mock' });
    await generateCoverLetterActivity(
      baseInput,
      makeCtx({ llm: createMockLLMProvider({ onComplete }) }),
    );
    const sys = onComplete.mock.calls[0]?.[0]?.messages?.[0];
    expect(sys?.role).toBe('system');
    expect(sys?.content?.toLowerCase()).toContain('cover letter');
  });

  it('passes custom prompt when provided', async () => {
    // SCENARIO: caller supplies a custom prompt; default is overridden
    // INPUT: input.prompt = 'You write haiku cover letters'
    // EXPECTED: system message content equals the custom prompt
    const onComplete = vi.fn().mockResolvedValue({ content: 'L', model: 'mock' });
    await generateCoverLetterActivity(
      { ...baseInput, prompt: 'You write haiku cover letters' },
      makeCtx({ llm: createMockLLMProvider({ onComplete }) }),
    );
    expect(onComplete.mock.calls[0]?.[0]?.messages?.[0]?.content).toBe(
      'You write haiku cover letters',
    );
  });

  it('uses ru prompt when locale=ru', async () => {
    // SCENARIO: explicit Russian locale
    // INPUT: locale='ru', no custom prompt
    // EXPECTED: system message contains Cyrillic characters
    const onComplete = vi.fn().mockResolvedValue({ content: 'L', model: 'mock' });
    await generateCoverLetterActivity(
      { ...baseInput, locale: 'ru' as const },
      makeCtx({ llm: createMockLLMProvider({ onComplete }) }),
    );
    expect(onComplete.mock.calls[0]?.[0]?.messages?.[0]?.content).toMatch(/[а-яА-Я]/);
  });

  it('Solution durationMs is non-negative', async () => {
    // SCENARIO: durationMs measured from start to LLM response
    // INPUT: baseInput
    // EXPECTED: durationMs >= 0
    const result = await generateCoverLetterActivity(baseInput, makeCtx());
    expect(result).toHaveProperty('durationMs');
    expect((result as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes tokensUsed when provider reports usage.totalTokens', async () => {
    // SCENARIO: LLM provider reports token usage; activity maps to flat tokensUsed
    // INPUT: mock returns { ..., usage: { totalTokens: 1234 } }
    // EXPECTED: result.tokensUsed === 1234
    const llm = createMockLLMProvider({
      onComplete: async () => ({ content: 'L', model: 'mock', usage: { totalTokens: 1234 } }),
    });
    const result = await generateCoverLetterActivity(baseInput, makeCtx({ llm }));
    expect((result as { tokensUsed?: number }).tokensUsed).toBe(1234);
  });

  it('rejects malformed input via Zod', async () => {
    // SCENARIO: vacancy.description missing - violates VacancyShape
    // INPUT: vacancy without description
    // EXPECTED: rejection with Zod error
    await expect(
      generateCoverLetterActivity(
        {
          vacancy: { title: 'x' } as unknown as { title: string; description: string },
          resume: { title: 'y', content: 'z' },
        },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });

  it('passes signal from ctx to LLM', async () => {
    // SCENARIO: caller provides AbortSignal; activity forwards to LLM
    // INPUT: ctx.signal from new AbortController
    // EXPECTED: LLM request receives the same signal reference
    const onComplete = vi.fn().mockResolvedValue({ content: 'L', model: 'mock' });
    const ac = new AbortController();
    const ctx: ActivityContext = {
      state: {},
      llm: createMockLLMProvider({ onComplete }),
      signal: ac.signal,
    };
    await generateCoverLetterActivity(baseInput, ctx);
    expect(onComplete.mock.calls[0]?.[0]?.signal).toBe(ac.signal);
  });
});
