// packages/text-tools/src/tools/questions.ts

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JSONSchema7 } from 'json-schema';
import type { Tool } from '@kolosochek/reactor-core';
import { VacancyShape, ResumeShape } from './coverLetter.js';

export const QuestionsInput = z.object({
  vacancy: VacancyShape,
  resume: ResumeShape,
  questions: z.array(z.string().min(1)).min(1),
  prompt: z.string().optional(),
  locale: z.enum(['en', 'ru']).default('en'),
});

export type QuestionsInputT = z.infer<typeof QuestionsInput>;

export const QuestionAnswerPair = z.object({
  question: z.string(),
  answer: z.string(),
});

export type QuestionAnswerPairT = z.infer<typeof QuestionAnswerPair>;

export const QuestionsSolution = z.object({
  qaPairs: z.array(QuestionAnswerPair),
  tokensUsed: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
});

export type QuestionsSolutionT = z.infer<typeof QuestionsSolution>;

export const QuestionsTool: Tool = {
  name: 'answerQuestions',
  description: 'Answer HR screening questions using vacancy context and resume.',
  category: 'transformation',
  inputSchema: zodToJsonSchema(QuestionsInput) as JSONSchema7,
  outputSchema: zodToJsonSchema(QuestionsSolution) as JSONSchema7,
};
