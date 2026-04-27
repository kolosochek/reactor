// packages/text-tools/src/tools/score.ts

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JSONSchema7 } from 'json-schema';
import type { Tool } from '@kolosochek/reactor-core';
import { VacancyShape, ResumeShape } from './coverLetter.js';

export const ScoreInput = z.object({
  vacancy: VacancyShape,
  resume: ResumeShape,
  prompt: z.string().optional(),
  locale: z.enum(['en', 'ru']).default('en'),
});

export type ScoreInputT = z.infer<typeof ScoreInput>;

export const SkillMatch = z.object({
  matched: z.array(z.string()),
  missing: z.array(z.string()),
  extra: z.array(z.string()),
});

export type SkillMatchT = z.infer<typeof SkillMatch>;

export const ScoreSolution = z.object({
  score: z.number().int().min(0).max(100),
  reasoning: z.string().min(1),
  skillMatch: SkillMatch.optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
});

export type ScoreSolutionT = z.infer<typeof ScoreSolution>;

export const ScoreTool: Tool = {
  name: 'scoreVacancy',
  description: 'Score how well a resume fits a vacancy (0-100) with reasoning and skill match.',
  category: 'aggregation',
  inputSchema: zodToJsonSchema(ScoreInput) as JSONSchema7,
  outputSchema: zodToJsonSchema(ScoreSolution) as JSONSchema7,
};
