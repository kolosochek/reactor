// packages/text-tools/src/activities/score.ts
//
// Score Activity (Latent path with structured output). Asks the LLM for
// JSON via jsonMode, falls back to extracting JSON from a markdown fence,
// and validates the parsed object via Zod's ScoreSolution. Tokens map from
// the response usage.totalTokens onto the flat Solution tokensUsed field.

import type { Activity } from '@kolosochek/reactor-core';
import { composeActivity } from '../activity/compose.js';
import {
  ScoreInput,
  ScoreSolution,
  type ScoreInputT,
  type ScoreSolutionT,
} from '../tools/score.js';
import { defaultScorePrompt } from '../prompts/score.js';
import { LLMOutputParseError } from '../errors.js';

function buildUserContent(input: ScoreInputT): string {
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

function tryParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function extractJSONFromMarkdown(raw: string): unknown {
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch !== null && fenceMatch[1] !== undefined) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const scoreVacancyActivity: Activity = composeActivity<unknown, ScoreSolutionT>({
  llmFallback: async (rawInput, ctx) => {
    const input = ScoreInput.parse(rawInput);
    const startedAt = Date.now();

    const prompt = input.prompt ?? defaultScorePrompt[input.locale];
    const userContent = buildUserContent(input);

    const response = await ctx.llm.complete({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userContent },
      ],
      jsonMode: true,
      signal: ctx.signal,
    });

    const parsed = tryParseJSON(response.content) ?? extractJSONFromMarkdown(response.content);

    if (parsed === undefined) {
      throw new LLMOutputParseError({
        rawContent: response.content,
        expectedSchema: 'ScoreSolution',
      });
    }

    const tokensUsed = response.usage?.totalTokens;

    const solution: ScoreSolutionT = ScoreSolution.parse({
      ...(parsed as object),
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      durationMs: Date.now() - startedAt,
    });

    return solution;
  },
});
