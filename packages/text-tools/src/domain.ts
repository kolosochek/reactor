// packages/text-tools/src/domain.ts

import type { DomainContext } from '@kolosochek/reactor-core';

// DomainContext shape (per @kolosochek/reactor-core):
//   { type: 'domain', domain, description, entities, actions, constraints, paradigm? }
// Plan's draft used `name`/`paradigm: string`/`capabilityMap` which do not exist on
// the real type; adjusted below to satisfy the actual contract while preserving the
// intent (entities, actions, paradigm rationale).
export const textToolsDomain: DomainContext = {
  type: 'domain',
  domain: 'text-tools',
  description:
    'Job-text LLM tooling: score a vacancy/resume fit, draft cover letters, and answer HR screening questions.',
  entities: ['vacancy', 'resume', 'cover-letter', 'question'],
  actions: ['score', 'draft', 'answer'],
  constraints: {},
  paradigm: {
    principles: {
      'score-before-draft':
        'Score the vacancy/resume fit before drafting a letter; low fit signals a poor candidate match.',
      'draft-from-context':
        'Cover letters are derived deterministically from vacancy text + resume content; no external lookups.',
      'answer-from-resume':
        'HR screening answers come from the resume and vacancy context, not from invented experience.',
    },
    rationale:
      'Text-tools is a thin LLM layer over (vacancy, resume) inputs. Each tool is a pure transformation: score -> letter -> answers. No state is shared across tools beyond what callers explicitly chain.',
    examples: [
      {
        scenario: 'Caller wants to apply to a vacancy with a tailored letter.',
        analysis: 'scoreVacancy first to gate effort; if score is high enough, generateCoverLetter.',
        guidance: 'Use scoreVacancy then generateCoverLetter; do not skip scoring.',
      },
      {
        scenario: 'Vacancy form includes screening questions.',
        analysis:
          'answerQuestions reads vacancy + resume to produce answers grounded in candidate experience.',
        guidance: 'Use answerQuestions with the full questions list in one call.',
      },
    ],
  },
};
