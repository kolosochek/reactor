// packages/reactor-service/src/kairon/scenario.ts
//
// The scenario the user states, structured (DEV-1375). «Стройка дорожает на
// 8 % с 2026-09» is a fact the user gives, not a lever the agent picks: the LLM
// structures the phrase into a cost_change, and the server builds the scale op
// and applies it with applyPatch. checkPatch is not used here, so the ±3 %
// lever bound does not cap the stated change; closed months, derived lines and
// unknown codes are still refused. A phrase that is not a cost change stays
// `free` and goes to the LLM's variants, as in stage 4.

import { z } from 'zod';
import type { PatchRules } from './checks.js';
import { addMonths, applyPatch, Month, type ForecastDocument, type ForecastPatch } from './patch.js';

export const ScenarioSpecSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('cost_change'),
      lineCodes: z.array(z.string().min(1)).min(1),
      fromMonth: Month,
      factorPpm: z.number().int().min(500_000).max(2_000_000),
    })
    .strict(),
  z.object({ type: z.literal('free') }).strict(),
]);

export type ScenarioSpec = z.infer<typeof ScenarioSpecSchema>;

export interface ScenarioResult {
  doc: ForecastDocument;
  ops: ForecastPatch | null;
  errors: string[];
}

export function applyScenario(doc: ForecastDocument, rules: PatchRules, spec: ScenarioSpec): ScenarioResult {
  if (spec.type === 'free') return { doc, ops: null, errors: [] };
  const errors: string[] = [];
  if (spec.fromMonth <= rules.closedThrough) {
    errors.push(
      `${spec.fromMonth}: closed through ${rules.closedThrough}; the scenario starts at ${addMonths(rules.closedThrough, 1)} or later`,
    );
  }
  const lines = new Map(doc.plan.lines.map((line) => [line.code, line]));
  for (const code of spec.lineCodes) {
    const line = lines.get(code);
    if (line === undefined) errors.push(`${code}: unknown line code`);
    else if (rules.derivedLineCodes.includes(code)) errors.push(`${code}: the server derives this line`);
    else if (!Object.entries(line.monthlyForecast).some(([m, v]) => m >= spec.fromMonth && BigInt(v) !== 0n)) {
      errors.push(`${code}: no cell from ${spec.fromMonth} to change`);
    }
  }
  if (errors.length > 0) return { doc, ops: null, errors };
  const ops: ForecastPatch = {
    name: 'scenario',
    scale: [{ lineCodes: spec.lineCodes, fromMonth: spec.fromMonth, factorPpm: spec.factorPpm }],
  };
  return { doc: { ...doc, plan: applyPatch(doc, ops).plan }, ops, errors: [] };
}
