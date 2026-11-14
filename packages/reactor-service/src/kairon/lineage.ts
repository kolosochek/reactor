// packages/reactor-service/src/kairon/lineage.ts
//
// Draft lineage (DEV-1375, spec 5.2). A draft is not stored as a full forecast:
// it is the active forecast plus its scenario, its lever patch and its goal
// steps, and the server replays that on every message and on the save click.
// The card and the saved Kairon version therefore come from the same body.
// The lineage pins the active forecast by hash: the plan, the version's funding
// revision and the project's funding settings (DEV-1377). If any of them changed
// between two messages, the replay refuses instead of scoring a different
// base. Levers go through checkPatch again (bounds, closed months and its
// monthRange adjustment); the scenario goes through applyScenario, outside
// the lever bound; cover draws are appended, a later draw for the same source
// and month replacing an earlier one.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { checkPatch, type PatchRules } from './checks.js';
import { GoalSchema } from './goals.js';
import { applyPatch, ForecastPatchSchema, type EvaluateBody, type ForecastDocument } from './patch.js';
import { applyScenario, ScenarioSpecSchema } from './scenario.js';

const ManualDrawSchema = z
  .object({ sourceId: z.string().min(1), date: z.string().length(10), amountMinor: z.string().min(1), origin: z.literal('manual') })
  .strict();

export const DraftLineageSchema = z
  .object({
    activePlanHash: z.string().min(1),
    scenario: ScenarioSpecSchema,
    leverPatch: ForecastPatchSchema.nullable(),
    steps: z.array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('cover'), goal: GoalSchema, draws: z.array(ManualDrawSchema) }).strict(),
        z.object({ type: z.literal('levers'), goal: GoalSchema, patch: ForecastPatchSchema }).strict(),
      ]),
    ),
  })
  .strict();

export type DraftLineage = z.infer<typeof DraftLineageSchema>;

export const STALE_LINEAGE = 'Активный прогноз изменился, начните новый сценарий';

/** JSON with object keys sorted, so equal content gives equal text whatever key order built it. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * sha256 of what a draft is built on: the plan as an evaluate body carries it (server-owned keys dropped),
 * the active version's funding revision and the project's funding settings, keys sorted. A document without
 * funding state reads as revision 0 and no settings.
 */
export function planHash(doc: ForecastDocument): string {
  const state = {
    plan: applyPatch(doc, { name: 'hash' }).plan,
    fundingRevision: doc.fundingRevision ?? 0,
    fundingSettings: doc.fundingSettings ?? null,
  };
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}

export function replayLineage(
  doc: ForecastDocument,
  rules: PatchRules,
  lineage: DraftLineage,
): { body: EvaluateBody | null; errors: string[] } {
  if (planHash(doc) !== lineage.activePlanHash) return { body: null, errors: [STALE_LINEAGE] };
  const scenario = applyScenario(doc, rules, lineage.scenario);
  if (scenario.errors.length > 0) return { body: null, errors: scenario.errors };
  let current: ForecastDocument = scenario.doc;
  let shareTarget: EvaluateBody['shareTarget'];
  const draws: Array<z.infer<typeof ManualDrawSchema>> = [];
  const levers = (patch: z.infer<typeof ForecastPatchSchema>): string[] => {
    const check = checkPatch(current, rules, patch);
    if (check.body === null) return check.errors;
    current = { ...current, plan: check.body.plan };
    if (check.body.shareTarget !== undefined) shareTarget = check.body.shareTarget;
    return [];
  };
  if (lineage.leverPatch !== null) {
    const errors = levers(lineage.leverPatch);
    if (errors.length > 0) return { body: null, errors };
  }
  for (const step of lineage.steps) {
    if (step.type === 'levers') {
      const errors = levers(step.patch);
      if (errors.length > 0) return { body: null, errors };
      continue;
    }
    for (const draw of step.draws) {
      const at = draws.findIndex((d) => d.sourceId === draw.sourceId && d.date === draw.date);
      if (at === -1) draws.push(draw);
      else draws[at] = draw;
    }
  }
  const body = applyPatch(current, {
    name: 'replay',
    ...(shareTarget === undefined ? {} : { shareTarget }),
    ...(draws.length === 0 ? {} : { draws }),
  });
  return { body, errors: [] };
}

/** Children are numbered under the root draft: v2 → v2.1, a goal on v2.1 → v2.2. */
export function childId(parentId: string, existing: string[]): string {
  const root = parentId.split('.')[0] ?? parentId;
  const taken = existing
    .filter((id) => id.startsWith(`${root}.`))
    .map((id) => Number(id.split('.')[1]))
    .filter((n) => Number.isInteger(n));
  return `${root}.${Math.max(0, ...taken) + 1}`;
}
