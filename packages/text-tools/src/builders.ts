// packages/text-tools/src/builders.ts

import { z } from 'zod';
import { createMeta } from './lib/createMeta.js';
import type { Idea, MetaMessage, DataMessage } from '@kolosochek/reactor-core';
import { CoverLetterInput } from './tools/coverLetter.js';
import { ScoreInput } from './tools/score.js';
import { QuestionsInput } from './tools/questions.js';

const DOMAIN = 'text-tools';
const VERSION = '0.1.0';

// Use z.input<> for builder parameters: callers may omit fields that have
// Zod defaults (e.g. locale='en'), and the parsed value supplies them.
export type CoverLetterIdeaInput = z.input<typeof CoverLetterInput>;
export type ScoreIdeaInput = z.input<typeof ScoreInput>;
export type QuestionsIdeaInput = z.input<typeof QuestionsInput>;

function buildIdea(toolName: string, pathPrefix: string, validatedInput: object): Idea {
  const meta = createMeta(DOMAIN, `${pathPrefix}/${new Date().toISOString()}`, { version: VERSION });
  const metaMsg: MetaMessage = { type: 'meta', role: 'system', meta };

  const dataMsg: DataMessage = {
    type: 'data',
    role: 'system',
    data: validatedInput,
    _call: { _tool: toolName, _outputPath: `†state.${toolName}`, ...validatedInput },
    _date: new Date().toISOString(),
  };

  return {
    schema: { type: 'object' },
    context: [metaMsg, dataMsg],
    solution: null,
  };
}

export function buildCoverLetterIdea(input: CoverLetterIdeaInput): Idea {
  const parsed = CoverLetterInput.parse(input);
  return buildIdea('generateCoverLetter', '/cover-letter', parsed);
}

export function buildScoreIdea(input: ScoreIdeaInput): Idea {
  const parsed = ScoreInput.parse(input);
  return buildIdea('scoreVacancy', '/score', parsed);
}

export function buildQuestionsIdea(input: QuestionsIdeaInput): Idea {
  const parsed = QuestionsInput.parse(input);
  return buildIdea('answerQuestions', '/questions', parsed);
}
