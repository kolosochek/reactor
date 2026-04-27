// packages/reactor-client/src/index.ts
//
// Public exports for @reactor/client.

export { ReactorClient } from './ReactorClient.js';
export type { ReactorClientOptions, ProviderConfig, ExecuteOptions } from './ReactorClient.js';
export {
  ReactorClientError,
  TextToolsError,
  IdeaSchemaError,
  IdeaContextMissingError,
  LLMTimeoutError,
  LLMQuotaError,
  LLMNetworkError,
  LLMOutputParseError,
  ActivityCancelledError,
} from './errors.js';

export {
  buildCoverLetterIdea,
  buildScoreIdea,
  buildQuestionsIdea,
  CoverLetterInput,
  ScoreInput,
  QuestionsInput,
} from '@reactor/text-tools';
export type {
  CoverLetterInputT,
  CoverLetterSolutionT,
  ScoreInputT,
  ScoreSolutionT,
  QuestionsInputT,
  QuestionsSolutionT,
} from '@reactor/text-tools';
