// packages/text-tools/src/index.ts
// Public surface for @dkolosovsky/reactor-text-tools.

// Adapter + assembly
export { textToolsAdapter } from './adapter.js';
export { textToolsDomain } from './domain.js';

// Builders
export {
  buildCoverLetterIdea,
  buildScoreIdea,
  buildQuestionsIdea,
} from './builders.js';

// Tools (definitions, schemas, types)
export {
  CoverLetterTool,
  CoverLetterInput,
  CoverLetterSolution,
  type CoverLetterInputT,
  type CoverLetterSolutionT,
  VacancyShape,
  ResumeShape,
} from './tools/coverLetter.js';

export {
  ScoreTool,
  ScoreInput,
  ScoreSolution,
  SkillMatch,
  type ScoreInputT,
  type ScoreSolutionT,
  type SkillMatchT,
} from './tools/score.js';

export {
  QuestionsTool,
  QuestionsInput,
  QuestionsSolution,
  QuestionAnswerPair,
  type QuestionsInputT,
  type QuestionsSolutionT,
  type QuestionAnswerPairT,
} from './tools/questions.js';

// Activities
export { generateCoverLetterActivity } from './activities/coverLetter.js';
export { scoreVacancyActivity } from './activities/score.js';
export { answerQuestionsActivity } from './activities/questions.js';

// Crystallization seam
export { composeActivity } from './activity/compose.js';
export type { CrystallizableActivity, ActivityLayers } from './activity/compose.js';

// Default prompts
export {
  defaultCoverLetterPrompt,
  defaultScorePrompt,
  defaultQuestionsPrompt,
} from './prompts/index.js';

// Errors
export {
  TextToolsError,
  IdeaSchemaError,
  IdeaContextMissingError,
  LLMTimeoutError,
  LLMQuotaError,
  LLMNetworkError,
  LLMOutputParseError,
  ActivityCancelledError,
} from './errors.js';
