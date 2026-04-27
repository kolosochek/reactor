// packages/text-tools/src/activities/coverLetter.ts
//
// Cover-letter Activity (Latent path). Builds a system+user message pair from
// the validated input, calls the LLM, and maps usage.totalTokens onto the
// flat Solution tokensUsed field.

import type { Activity } from '@kolosochek/reactor-core';
import { composeActivity } from '../activity/compose.js';
import {
  CoverLetterInput,
  CoverLetterSolution,
  type CoverLetterInputT,
  type CoverLetterSolutionT,
} from '../tools/coverLetter.js';
import { defaultCoverLetterPrompt } from '../prompts/coverLetter.js';

function buildUserContent(input: CoverLetterInputT): string {
  return [
    '## Vacancy',
    input.vacancy.title,
    '',
    input.vacancy.description,
    '',
    '## Resume Title',
    input.resume.title,
    '',
    '## Resume Content',
    input.resume.content,
  ].join('\n');
}

export const generateCoverLetterActivity: Activity = composeActivity<unknown, CoverLetterSolutionT>({
  llmFallback: async (rawInput, ctx) => {
    const input = CoverLetterInput.parse(rawInput);
    const startedAt = Date.now();

    const prompt = input.prompt ?? defaultCoverLetterPrompt[input.locale];
    const userContent = buildUserContent(input);

    const response = await ctx.llm.complete({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userContent },
      ],
      signal: ctx.signal,
    });

    const tokensUsed = response.usage?.totalTokens;

    const solution: CoverLetterSolutionT = {
      letter: response.content,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      durationMs: Date.now() - startedAt,
    };

    return CoverLetterSolution.parse(solution);
  },
});
