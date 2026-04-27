// packages/text-tools/src/tools/coverLetter.ts

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JSONSchema7 } from 'json-schema';
import type { Tool } from '@kolosochek/reactor-core';

export const VacancyShape = z.object({
  title: z.string(),
  description: z.string(),
  url: z.string().url().optional(),
  platform: z.string().optional(),
});

export const ResumeShape = z.object({
  title: z.string(),
  content: z.string(),
});

export const CoverLetterInput = z.object({
  vacancy: VacancyShape,
  resume: ResumeShape,
  prompt: z.string().optional(),
  locale: z.enum(['en', 'ru']).default('en'),
});

export type CoverLetterInputT = z.infer<typeof CoverLetterInput>;

export const CoverLetterSolution = z.object({
  letter: z.string().min(1),
  tokensUsed: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
});

export type CoverLetterSolutionT = z.infer<typeof CoverLetterSolution>;

export const CoverLetterTool: Tool = {
  name: 'generateCoverLetter',
  description: 'Generate a cover letter from vacancy text and resume.',
  category: 'transformation',
  inputSchema: zodToJsonSchema(CoverLetterInput) as JSONSchema7,
  outputSchema: zodToJsonSchema(CoverLetterSolution) as JSONSchema7,
};
