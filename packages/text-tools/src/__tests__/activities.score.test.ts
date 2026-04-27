import { describe, it, expect, vi } from 'vitest';
import { scoreVacancyActivity } from '../activities/score.js';
import { createMockLLMProvider } from '../test-utils/mockLLM.js';
import { LLMOutputParseError } from '../errors.js';
import type { ActivityContext } from '@kolosochek/reactor-core';

const baseInput = {
  vacancy: { title: 'Senior FE', description: 'React, 5+ years' },
  resume: { title: 'FE', content: '7 years React' },
};

function makeCtx(content: string): ActivityContext {
  return {
    state: {},
    llm: createMockLLMProvider({
      onComplete: async () => ({ content, model: 'mock', usage: { totalTokens: 100 } }),
    }),
  };
}

describe('scoreVacancyActivity', () => {
  it('parses valid JSON LLM response into Solution', async () => {
    // SCENARIO: well-formed JSON output from LLM
    // INPUT: JSON with score, reasoning, skillMatch
    // EXPECTED: Solution mirrors the parsed fields
    const json = JSON.stringify({
      score: 80,
      reasoning: 'Strong match',
      skillMatch: { matched: ['React'], missing: [], extra: [] },
    });
    const result = await scoreVacancyActivity(baseInput, makeCtx(json));
    expect(result).toMatchObject({
      score: 80,
      reasoning: 'Strong match',
      skillMatch: { matched: ['React'], missing: [], extra: [] },
    });
  });

  it('extracts JSON from markdown fence', async () => {
    // SCENARIO: LLM wraps JSON in a ```json fence (common LLM behavior)
    // INPUT: fenced JSON content
    // EXPECTED: parsed score is 70
    const json =
      '```json\n{"score": 70, "reasoning": "ok", "skillMatch": {"matched":[],"missing":[],"extra":[]}}\n```';
    const result = await scoreVacancyActivity(baseInput, makeCtx(json));
    expect((result as { score: number }).score).toBe(70);
  });

  it('throws LLMOutputParseError on unparseable content', async () => {
    // SCENARIO: LLM returns prose, not JSON
    // INPUT: 'not json at all'
    // EXPECTED: rejected with LLMOutputParseError
    await expect(scoreVacancyActivity(baseInput, makeCtx('not json at all'))).rejects.toThrow(
      LLMOutputParseError,
    );
  });

  it('throws on JSON that does not match Schema (score>100)', async () => {
    // SCENARIO: parseable JSON but violates Solution constraints
    // INPUT: { score: 150, ... }
    // EXPECTED: rejection (Zod error from ScoreSolution.parse)
    const json = JSON.stringify({
      score: 150,
      reasoning: 'r',
      skillMatch: { matched: [], missing: [], extra: [] },
    });
    await expect(scoreVacancyActivity(baseInput, makeCtx(json))).rejects.toThrow();
  });

  it('requests jsonMode: true from LLM', async () => {
    // SCENARIO: scoring requires structured output
    // INPUT: any valid score Solution shape
    // EXPECTED: outgoing LLM request has jsonMode === true
    const onComplete = vi.fn().mockResolvedValue({
      content: '{"score":75,"reasoning":"ok","skillMatch":{"matched":[],"missing":[],"extra":[]}}',
      model: 'mock',
    });
    await scoreVacancyActivity(baseInput, {
      state: {},
      llm: createMockLLMProvider({ onComplete }),
    });
    expect(onComplete.mock.calls[0]?.[0]?.jsonMode).toBe(true);
  });

  it('passes default en prompt when none provided', async () => {
    // SCENARIO: locale defaults to en when omitted
    // INPUT: baseInput without prompt
    // EXPECTED: system message references scoring/evaluation
    const onComplete = vi.fn().mockResolvedValue({
      content: '{"score":75,"reasoning":"ok","skillMatch":{"matched":[],"missing":[],"extra":[]}}',
      model: 'mock',
    });
    await scoreVacancyActivity(baseInput, {
      state: {},
      llm: createMockLLMProvider({ onComplete }),
    });
    const sys = onComplete.mock.calls[0]?.[0]?.messages?.[0]?.content?.toLowerCase() ?? '';
    expect(sys).toMatch(/score|evaluat/);
  });
});
