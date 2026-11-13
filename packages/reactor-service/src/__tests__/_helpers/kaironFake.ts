// Fake Kairon API over the recorded Rivergate fixtures (DEV-1364): Forecast v3
// and the approved budget, with the recorded {} evaluations as the baseline.
// Stage 5 (DEV-1375) adds the bodies recorded by scripts/record-stage5-fixtures.mts,
// served by body content, and the project's partners.

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

export function readStage5(name: string): unknown {
  return readFixture(join('stage5', name));
}

const STAGE5_PROJECT = readStage5('project.json') as {
  settings: { funding: { partners: Array<{ id: string; name: string; sharePct: number }> } };
};

/** Rivergate's partners and their agreed shares, as settings.funding.partners serves them. */
export const RIVERGATE_PARTNERS = STAGE5_PROJECT.settings.funding.partners.map((p) => ({
  partnerId: p.id,
  name: p.name,
  sharePct: p.sharePct,
}));

export function fakeKaironApi(
  evaluate: (versionId: string, body: unknown) => HttpResult,
  options: { partners?: boolean } = {},
): KaironApi {
  const project = {
    id: 'sol00001-0000-4000-8000-000000000001',
    name: 'Rivergate Park',
    currentApprovedVersionId: 'd942a201-5349-46fd-9043-b697288460fe',
    currency: { code: 'CZK', decimals: 2 },
  };
  return {
    projectId: 'sol00001-0000-4000-8000-000000000001',
    pinnedVersionId: 'solstice-forecast-3',
    getProject: async () => (options.partners === true ? { ...project, settings: STAGE5_PROJECT.settings } : project),
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

/** JSON with object keys sorted: the live API and the stage 4 fixture document order keys differently. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const STAGE5_BODIES = ['s2-v1', 's2-v2', 's2-v3', 's2-v4', 's2-bank60', 'cover-cedar'];
let stage5Bodies: Map<string, string> | null = null;

function recordedStage5Bodies(): Map<string, string> {
  if (stage5Bodies === null) {
    stage5Bodies = new Map(STAGE5_BODIES.map((name) => [canonical(readStage5(`${name}.body.json`)), `${name}.eval.json`]));
  }
  return stage5Bodies;
}

/** The recorded stage 5 evaluate for this body; `{}` gives the active or the approved baseline. */
export const stage5Evaluate = (versionId: string, body: unknown): HttpResult => {
  const key = canonical(body);
  if (key === '{}') {
    return { status: 200, json: readStage5(versionId === 'solstice-forecast-3' ? 'eval-active.json' : 'eval-approved.json') };
  }
  const file = recordedStage5Bodies().get(key);
  if (file === undefined) throw new Error(`unrecorded body for ${versionId}`);
  return { status: 200, json: readStage5(file) };
};
