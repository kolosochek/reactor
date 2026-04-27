// packages/reactor-service/src/db/repositories/index.ts
//
// Factory wiring all 5 Postgres repositories into a RepositoriesProvider per
// reactor-core SPI. Service code receives the provider via Decision #8: the
// repos are long-lived (pool-bound singletons) while Reactor instances are
// constructed per request.

import type { ReactorDb } from '../client.js';
import type { RepositoriesProvider } from '@kolosochek/reactor-core';
import { PostgresExperienceRepository } from './PostgresExperienceRepository.js';
import { PostgresLessonsRepository } from './PostgresLessonsRepository.js';
import { PostgresIdeasRepository } from './PostgresIdeasRepository.js';
import { PostgresPredictionsRepository } from './PostgresPredictionsRepository.js';
import { PostgresToolsRepository } from './PostgresToolsRepository.js';

export function createRepositoriesProvider(db: ReactorDb): RepositoriesProvider {
  return {
    experience: new PostgresExperienceRepository(db),
    lessons: new PostgresLessonsRepository(db),
    ideas: new PostgresIdeasRepository(db),
    predictions: new PostgresPredictionsRepository(db),
    tools: new PostgresToolsRepository(db),
  };
}

export {
  PostgresExperienceRepository,
  PostgresLessonsRepository,
  PostgresIdeasRepository,
  PostgresPredictionsRepository,
  PostgresToolsRepository,
};
