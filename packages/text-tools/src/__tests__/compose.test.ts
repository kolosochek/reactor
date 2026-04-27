import { describe, it, expect, vi } from 'vitest';
import { composeActivity } from '../activity/compose.js';
import type { ActivityContext, LLMProvider } from '@kolosochek/reactor-core';

const stubLLM: LLMProvider = {
  name: 'mock',
  async complete() {
    return { content: '', model: 'mock' };
  },
};

const ctx: ActivityContext = { state: {}, llm: stubLLM };

describe('composeActivity', () => {
  it('uses llmFallback when no preCheck or postValidate provided', async () => {
    // SCENARIO: minimal composition with only llmFallback
    // INPUT: input { x: 1 }; llmFallback returns { y: 2 }
    // EXPECTED: composed activity returns { y: 2 }
    const llmFallback = vi.fn().mockResolvedValue({ y: 2 });
    const activity = composeActivity({ llmFallback });

    const result = await activity({ x: 1 }, ctx);

    expect(result).toEqual({ y: 2 });
    expect(llmFallback).toHaveBeenCalledOnce();
    expect(llmFallback).toHaveBeenCalledWith({ x: 1 }, ctx);
  });

  it('preCheck returns Solution when crystallized; llmFallback skipped', async () => {
    // SCENARIO: preCheck recognizes a deterministic case; llmFallback never invoked
    // INPUT: input { x: 'easy-case' }; preCheck returns { y: 'fast' }
    // EXPECTED: result is preCheck output; llmFallback was not called
    const llmFallback = vi.fn();
    const preCheck = vi.fn().mockReturnValue({ y: 'fast' });
    const activity = composeActivity({ preCheck, llmFallback });

    const result = await activity({ x: 'easy-case' }, ctx);

    expect(result).toEqual({ y: 'fast' });
    expect(preCheck).toHaveBeenCalledOnce();
    expect(llmFallback).not.toHaveBeenCalled();
  });

  it('preCheck returns null falls through to llmFallback', async () => {
    // SCENARIO: preCheck cannot crystallize; llmFallback is invoked
    // INPUT: input { x: 'hard-case' }; preCheck returns null
    // EXPECTED: result is llmFallback output
    const llmFallback = vi.fn().mockResolvedValue({ y: 'llm' });
    const preCheck = vi.fn().mockReturnValue(null);
    const activity = composeActivity({ preCheck, llmFallback });

    const result = await activity({ x: 'hard-case' }, ctx);

    expect(result).toEqual({ y: 'llm' });
    expect(preCheck).toHaveBeenCalledOnce();
    expect(llmFallback).toHaveBeenCalledOnce();
  });

  it('postValidate wraps llmFallback output', async () => {
    // SCENARIO: postValidate enforces a structural check on LLM output
    // INPUT: input {}; llmFallback returns { letter: 'short' }; postValidate appends a sig
    // EXPECTED: result is the postValidate output
    const llmFallback = vi.fn().mockResolvedValue({ letter: 'short' });
    const postValidate = vi.fn().mockImplementation(
      (_input: unknown, output: { letter: string }) => ({ letter: `${output.letter} - sig` }),
    );
    const activity = composeActivity({ llmFallback, postValidate });

    const result = await activity({}, ctx);

    expect(result).toEqual({ letter: 'short - sig' });
  });

  it('postValidate not invoked when preCheck succeeds', async () => {
    // SCENARIO: explicit ruleset wins; postValidate is for LLM output only
    // INPUT: preCheck returns { letter: 'preset-letter' }
    // EXPECTED: result is preCheck output, postValidate not called
    const llmFallback = vi.fn();
    const preCheck = vi.fn().mockReturnValue({ letter: 'preset-letter' });
    const postValidate = vi.fn();
    const activity = composeActivity({ preCheck, llmFallback, postValidate });

    const result = await activity({}, ctx);

    expect(result).toEqual({ letter: 'preset-letter' });
    expect(postValidate).not.toHaveBeenCalled();
  });
});
