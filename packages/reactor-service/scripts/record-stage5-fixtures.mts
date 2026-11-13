// packages/reactor-service/scripts/record-stage5-fixtures.mts
//
// Records the read-only Kairon evaluates behind stage 5 (DEV-1375): scenario 2
// (construction +8 % and its lever variants), the bank-share variant that
// changes nothing, and the Cedar cover goal. Every call is GET or POST
// .../evaluate; nothing is written to Kairon. Run from reactor-service:
//   node --env-file=.env --import tsx scripts/record-stage5-fixtures.mts
// Output: src/__tests__/fixtures/kairon/stage5/*.json (compact JSON).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocument, readBaseline } from '../src/kairon/baseline.js';
import { createKaironClient, readKaironEnv } from '../src/kairon/client.js';
import { addMonths, applyPatch, type ForecastPatch } from '../src/kairon/patch.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', '__tests__', 'fixtures', 'kairon', 'stage5');
const FIXTURE_DOC = join(OUT, '..', 'forecast-document.active.json');

const env = readKaironEnv(process.env);
let rawProject: unknown = null;
const capturingFetch: typeof fetch = async (input, init) => {
  const resp = await fetch(input, init);
  if (String(input).endsWith(`/projects/${env.projectId}`) && resp.ok) rawProject = await resp.clone().json();
  return resp;
};
const api = createKaironClient(env, capturingFetch);

function write(name: string, value: unknown): void {
  writeFileSync(join(OUT, name), JSON.stringify(value));
  console.log('written', name);
}

async function evaluate(versionId: string, body: unknown): Promise<unknown> {
  const res = await api.evaluate(versionId, body);
  console.log('evaluate', versionId, res.status);
  if (res.status !== 200) throw new Error(`evaluate ${versionId} -> HTTP ${res.status}`);
  return res.json;
}

mkdirSync(OUT, { recursive: true });
const b = await readBaseline(api);
const doc = await loadDocument(api, b.forecastVersion.id);
const fixturePlan = (JSON.parse(readFileSync(FIXTURE_DOC, 'utf8')) as { plan: unknown }).plan;
const livePlan = applyPatch(doc, { name: 'noop' }).plan;
const fixtureBody = applyPatch({ plan: fixturePlan as typeof doc.plan }, { name: 'noop' }).plan;
console.log('live plan equals forecast-document.active.json:', JSON.stringify(livePlan) === JSON.stringify(fixtureBody));

const project = rawProject as {
  id: string;
  name: string;
  currentApprovedVersionId: string;
  currency: unknown;
  settings?: { funding?: { partners?: unknown } };
};
write('project.json', {
  id: project.id,
  name: project.name,
  currentApprovedVersionId: project.currentApprovedVersionId,
  currency: project.currency,
  settings: { funding: { partners: project.settings?.funding?.partners ?? [] } },
});

const active = (await evaluate(b.forecastVersion.id, {})) as {
  walk: { cashNeedMinor: Record<string, string> };
  sourceGroups: Array<{ sourceId: string; partnerId?: string }>;
};
write('eval-active.json', active);
write('eval-approved.json', await evaluate(b.approvedVersion.id, {}));
write('approved-plan.json', b.approvedPlan);

const from = addMonths(b.closedThrough, 1);
const construction = { lineCodes: ['D5', 'D8'], fromMonth: from, factorPpm: 1_080_000 };
const u2 = b.lines.find((l) => l.code === 'U2');
const releaseU2 = Object.keys(u2?.openCells ?? {}).map((month) => ({ code: 'U2', month, amountMinor: '0' }));
const prices = (factorPpm: number) => ({ lineCodes: ['R1'], fromMonth: from, factorPpm });

const cedar = active.sourceGroups.find((g) => g.partnerId === 'cedar');
if (cedar === undefined) throw new Error('no Cedar source group in the active evaluate');
const coverDraws = Array.from({ length: 6 }, (_, i) => {
  const month = addMonths(from, i);
  return { sourceId: cedar.sourceId, date: `${month}-01`, amountMinor: active.walk.cashNeedMinor[month] ?? '0', origin: 'manual' };
});

const variants: Array<[string, ForecastPatch]> = [
  ['s2-v1', { name: 'scenario', scale: [construction] }],
  ['s2-v2', { name: 'scenario', scale: [construction], set: releaseU2 }],
  ['s2-v3', { name: 'scenario', scale: [construction, prices(1_030_000)] }],
  ['s2-v4', { name: 'scenario', scale: [construction, prices(1_023_000)], set: releaseU2 }],
  ['s2-bank60', { name: 'scenario', scale: [construction], shareTarget: { equityShareBp: 6000 } }],
  ['cover-cedar', { name: 'cover', draws: coverDraws }],
];
for (const [name, patch] of variants) {
  const body = applyPatch(doc, patch);
  write(`${name}.body.json`, body);
  write(`${name}.eval.json`, await evaluate(b.forecastVersion.id, body));
}
