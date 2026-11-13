// Fake Kairon API over the recorded Rivergate fixtures (DEV-1364): Forecast v3
// and the approved budget, with the recorded {} evaluations as the baseline.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpResult, KaironApi, KaironVersion } from '../../kairon/client.js';
import type { ForecastDocument } from '../../kairon/patch.js';

export const KAIRON_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kairon');

export function readFixture(path: string): unknown {
  return JSON.parse(readFileSync(join(KAIRON_FIXTURES, path), 'utf8'));
}

export const fixtureDoc = readFixture('forecast-document.active.json') as ForecastDocument;

function version(id: string, name: string, role: string, isActive: boolean): KaironVersion {
  return { id, name, role, isActive, payload: { lines: fixtureDoc.plan.lines, monthRange: fixtureDoc.plan.monthRange } };
}

export function fakeKaironApi(evaluate: (versionId: string, body: unknown) => HttpResult): KaironApi {
  return {
    projectId: 'sol00001-0000-4000-8000-000000000001',
    pinnedVersionId: 'solstice-forecast-3',
    getProject: async () => ({
      id: 'sol00001-0000-4000-8000-000000000001',
      name: 'Rivergate Park',
      currentApprovedVersionId: 'd942a201-5349-46fd-9043-b697288460fe',
      currency: { code: 'CZK', decimals: 2 },
    }),
    listVersions: async () => [
      version('solstice-forecast-3', 'Forecast v3', 'forecast', true),
      version('d942a201-5349-46fd-9043-b697288460fe', 'Approved budget', 'approved', false),
    ],
    getMilestones: async () => [
      { code: 'OCCUPANCY_PERMIT', name: 'Occupancy Permit', dueDate: '2027-12-30', completedAt: null },
    ],
    evaluate: async (versionId, body) => evaluate(versionId, body),
  };
}

export const baselineEvaluate = (versionId: string, body: unknown): HttpResult => {
  if (JSON.stringify(body) !== '{}') throw new Error('baseline must evaluate with an empty body');
  return versionId === 'solstice-forecast-3'
    ? { status: 200, json: readFixture('responses/eval-active.json') }
    : { status: 200, json: readFixture('responses/eval-approved.json') };
};
