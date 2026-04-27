// packages/text-tools/src/adapter.ts

import type { Adapter } from '@kolosochek/reactor-core';
import { CoverLetterTool } from './tools/coverLetter.js';
import { ScoreTool } from './tools/score.js';
import { QuestionsTool } from './tools/questions.js';
import { generateCoverLetterActivity } from './activities/coverLetter.js';
import { scoreVacancyActivity } from './activities/score.js';
import { answerQuestionsActivity } from './activities/questions.js';
import { textToolsDomain } from './domain.js';

export const textToolsAdapter: Adapter = {
  name: 'text-tools',
  version: '0.1.0',
  tools: [CoverLetterTool, ScoreTool, QuestionsTool],
  activities: {
    generateCoverLetter: generateCoverLetterActivity,
    scoreVacancy: scoreVacancyActivity,
    answerQuestions: answerQuestionsActivity,
  },
  domain: textToolsDomain,
};
