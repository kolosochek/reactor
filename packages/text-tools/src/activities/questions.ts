// packages/text-tools/src/activities/questions.ts
//
// Questions Activity (Latent path with structured output). Renders the HR
// question list into the user message, asks the LLM for JSON via jsonMode,
// falls back to extracting JSON from a markdown fence, and validates the
// parsed object via Zod's QuestionsSolution. Tokens map from the response
// usage.totalTokens onto the flat Solution tokensUsed field.

import type { Activity } from '@kolosochek/reactor-core';
import { composeActivity } from '../activity/compose.js';
import {
  QuestionsInput,
  QuestionsSolution,
  type QuestionsInputT,
  type QuestionsSolutionT,
} from '../tools/questions.js';
import { defaultQuestionsPrompt } from '../prompts/questions.js';
import { LLMOutputParseError } from '../errors.js';

function buildUserContent(input: QuestionsInputT): string {
  const questionsList = input.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
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
    '',
    '## Questions',
    questionsList,
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

export const answerQuestionsActivity: Activity = composeActivity<unknown, QuestionsSolutionT>({
  llmFallback: async (rawInput, ctx) => {
    const input = QuestionsInput.parse(rawInput);
    const startedAt = Date.now();

    const prompt = input.prompt ?? defaultQuestionsPrompt[input.locale];
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
        expectedSchema: 'QuestionsSolution',
      });
    }

    const tokensUsed = response.usage?.totalTokens;

    return QuestionsSolution.parse({
      ...(parsed as object),
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      durationMs: Date.now() - startedAt,
    });
  },
});
