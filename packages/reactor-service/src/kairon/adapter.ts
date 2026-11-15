// packages/reactor-service/src/kairon/adapter.ts
//
// Reactor adapter of the Kairon forecast prototype (DEV-1364). The Kairon
// client is created on first use, so building a Reactor needs no KAIRON_* env.

import type { Adapter, Tool } from '@kolosochek/reactor-core';
import { createKaironActivities, kaironToolInputSchemas } from './activities.js';
import { lazyWidgetCatalog, type WidgetCatalog } from './widgetCatalog.js';
import { sharedKaironClient, type KaironApi } from './client.js';

export const kaironForecastTools: Tool[] = [
  {
    name: 'kairon.baseline',
    inputSchema: kaironToolInputSchemas['kairon.baseline'] as Tool['inputSchema'],
    description:
      'Read the project baseline from Kairon: forecast and approved versions evaluated, closed month, derived lines, milestones, partner IRR, plan digest.',
    category: 'query',
    type: 'explicit',
  },
  {
    name: 'kairon.route',
    inputSchema: kaironToolInputSchemas['kairon.route'] as Tool['inputSchema'],
    description:
      'LLM routes a chat message: generate (a new scenario), goal_change (a goal for existing drafts) or question, and the draft ids it is about.',
    category: 'transformation',
    type: 'latent',
  },
  {
    name: 'kairon.structureScenario',
    inputSchema: kaironToolInputSchemas['kairon.structureScenario'] as Tool['inputSchema'],
    description:
      'LLM structures the stated scenario into a cost change (lines, month, factor) the server applies outside the lever bounds, or free.',
    category: 'transformation',
    type: 'latent',
  },
  {
    name: 'kairon.structureGoal',
    inputSchema: kaironToolInputSchemas['kairon.structureGoal'] as Tool['inputSchema'],
    description: 'LLM structures a goal: funding_cover, irr_floor or net_profit_target, with partner and month enums from the baseline.',
    category: 'transformation',
    type: 'latent',
  },
  {
    name: 'kairon.proposeVariants',
    inputSchema: kaironToolInputSchemas['kairon.proposeVariants'] as Tool['inputSchema'],
    description:
      'LLM proposes forecast patches for a scenario; each patch is checked against the closed month and derived lines and the LLM retries with the errors.',
    category: 'transformation',
    type: 'latent',
  },
  {
    name: 'kairon.buildGoalDrafts',
    inputSchema: kaironToolInputSchemas['kairon.buildGoalDrafts'] as Tool['inputSchema'],
    description:
      'Child drafts for a goal: a cover goal becomes manual draws equal to the parent need (no LLM); an IRR floor or a profit target asks the LLM for one lever draft per parent that misses it.',
    category: 'transformation',
    type: 'latent',
  },
  {
    name: 'kairon.scoreVariants',
    inputSchema: kaironToolInputSchemas['kairon.scoreVariants'] as Tool['inputSchema'],
    description:
      'Apply each patch and score it with Kairon evaluate; a 400/422 is recorded as the variant result. Ranks by IRR shortfall against the approved budget.',
    category: 'aggregation',
    type: 'explicit',
  },
  {
    name: 'kairon.planWidgets',
    inputSchema: kaironToolInputSchemas['kairon.planWidgets'] as Tool['inputSchema'],
    description:
      'LLM picks declarative widget specs per draft from its changed paths; the server keeps the matrix-diff for changed draws and falls back to the defaults.',
    category: 'transformation',
    type: 'latent',
  },
  {
    name: 'kairon.explainVariants',
    inputSchema: kaironToolInputSchemas['kairon.explainVariants'] as Tool['inputSchema'],
    description:
      'LLM explains the scored variants in Russian: verdict, gives, costs, stakeholders, why not the others; figures only as placeholders filled from evaluate.',
    category: 'transformation',
    type: 'latent',
  },
  {
    name: 'kairon.answerQuestion',
    inputSchema: kaironToolInputSchemas['kairon.answerQuestion'] as Tool['inputSchema'],
    description: 'LLM answers a question about the drafts in Russian, citing figures only as placeholders; no drafts means a fixed answer and no call.',
    category: 'transformation',
    type: 'latent',
  },
];

function lazyKaironClient(): KaironApi {
  return {
    get projectId() {
      return sharedKaironClient().projectId;
    },
    get pinnedVersionId() {
      return sharedKaironClient().pinnedVersionId;
    },
    getProject: () => sharedKaironClient().getProject(),
    listVersions: () => sharedKaironClient().listVersions(),
    getMilestones: (versionId) => sharedKaironClient().getMilestones(versionId),
    evaluate: (versionId, body) => sharedKaironClient().evaluate(versionId, body),
    createVersion: (input) => sharedKaironClient().createVersion(input),
    putFunding: (versionId, body) => sharedKaironClient().putFunding(versionId, body),
  };
}

/** `widgets` loads the forecast widgets catalog from KAIRON_WIDGETS_DIST on first use; unset, it loads none (DEV-1380). */
export function createKaironForecastAdapter(
  api: KaironApi = lazyKaironClient(),
  widgets: () => Promise<WidgetCatalog | null> = lazyWidgetCatalog(),
): Adapter {
  return {
    name: 'kairon-forecast',
    version: '0.0.1',
    tools: kaironForecastTools,
    activities: createKaironActivities(api, widgets),
  };
}
