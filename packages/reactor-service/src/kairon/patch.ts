// packages/reactor-service/src/kairon/patch.ts
//
// Forecast patch -> Kairon evaluate body. A TypeScript port of the DEV-1364
// discovery applier (apply_patch.py). Ops run in a fixed order: stretch,
// shift, extend, scale, set, then monthRangeTo, shareTarget, draws. Money is
// integer minor units held as strings; arithmetic runs on BigInt. Python's //
// floors toward minus infinity, so scale uses floorDiv to stay identical.
// The schema is strict: a misspelled op key from an LLM is an error, because
// a silently dropped op would score the undelayed forecast as a variant.

import { z } from 'zod';

export const Month = z.string().length(7);
const LineCodes = z.array(z.string().min(1)).min(1);

export const ForecastPatchSchema = z.object({
  name: z.string().min(1),
  stretch: z
    .array(z.object({ lineCodes: LineCodes, fromMonth: Month, byMonths: z.number().int() }).strict())
    .optional(),
  shift: z
    .array(
      z.object({
        lineCodes: LineCodes,
        fromMonth: Month,
        toMonth: Month.optional(),
        byMonths: z.number().int(),
      }).strict(),
    )
    .optional(),
  extend: z
    .array(z.object({ lineCodes: LineCodes, months: z.number().int().positive() }).strict())
    .optional(),
  scale: z
    .array(z.object({ lineCodes: LineCodes, fromMonth: Month, factorPpm: z.number().int().positive() }).strict())
    .optional(),
  set: z
    .array(z.object({ code: z.string().min(1), month: Month, amountMinor: z.string().min(1) }).strict())
    .optional(),
  monthRangeTo: Month.optional(),
  shareTarget: z.object({ equityShareBp: z.number().int().min(0).max(10_000) }).strict().optional(),
  draws: z.array(z.unknown()).optional(),
}).strict();

export type ForecastPatch = z.infer<typeof ForecastPatchSchema>;

export interface PlanLine {
  code: string;
  name: string;
  groupCode?: string;
  monthlyForecast: Record<string, string>;
  forecastTotalMinor?: string;
  [key: string]: unknown;
}

export interface ForecastPlan {
  lines: PlanLine[];
  monthRange: { from: string; to: string };
  [key: string]: unknown;
}

export interface ForecastDocument {
  plan: ForecastPlan;
  /** The version's funding revision and the project's settings.funding, as loadDocument reads them: staleness state only. */
  fundingRevision?: number;
  fundingSettings?: unknown;
  [key: string]: unknown;
}

export interface EvaluateBody {
  plan: ForecastPlan;
  shareTarget?: { equityShareBp: number };
  draws?: unknown[];
}

export function addMonths(ym: string, n: number): string {
  const total = Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1) + n;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function monthsBetween(a: string, b: string): number {
  return (
    Number(b.slice(0, 4)) * 12 + Number(b.slice(5, 7)) - (Number(a.slice(0, 4)) * 12 + Number(a.slice(5, 7)))
  );
}

export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export function applyPatch(doc: ForecastDocument, patch: ForecastPatch): EvaluateBody {
  const plan = structuredClone(doc.plan);
  const byCode = new Map<string, PlanLine>();
  for (const line of plan.lines) {
    delete line.forecastTotalMinor;
    byCode.set(line.code, line);
  }
  const cellsOf = (code: string): Record<string, string> => {
    const line = byCode.get(code);
    if (line === undefined) throw new Error(`Unknown line code: ${code}`);
    return line.monthlyForecast;
  };

  for (const op of patch.stretch ?? []) {
    for (const code of op.lineCodes) {
      const c = cellsOf(code);
      const ks = Object.keys(c)
        .filter((k) => k >= op.fromMonth && BigInt(c[k] ?? '0') !== 0n)
        .sort();
      const last = ks[ks.length - 1];
      if (last === undefined) continue;
      const total = ks.reduce((sum, k) => sum + BigInt(c[k] ?? '0'), 0n);
      for (const k of ks) delete c[k];
      const n = monthsBetween(op.fromMonth, last) + 1 + op.byMonths;
      const nBig = BigInt(n);
      const base = absBig(total) / nBig;
      const rest = absBig(total) % nBig;
      const sign = total < 0n ? -1n : 1n;
      for (let i = 0; i < n; i++) {
        const amount = base + (i === n - 1 ? rest : 0n);
        c[addMonths(op.fromMonth, i)] = String(sign * amount);
      }
    }
  }

  for (const op of patch.shift ?? []) {
    const hi = op.toMonth ?? '9999-12';
    for (const code of op.lineCodes) {
      const c = cellsOf(code);
      const moved: Array<[string, string]> = [];
      for (const k of Object.keys(c)) {
        if (op.fromMonth <= k && k <= hi) {
          moved.push([k, c[k] ?? '0']);
          delete c[k];
        }
      }
      for (const [k, v] of moved) {
        const nk = addMonths(k, op.byMonths);
        c[nk] = String(BigInt(c[nk] ?? '0') + BigInt(v));
      }
    }
  }

  for (const op of patch.extend ?? []) {
    for (const code of op.lineCodes) {
      const c = cellsOf(code);
      const ks = Object.keys(c)
        .filter((k) => BigInt(c[k] ?? '0') !== 0n)
        .sort();
      const last = ks[ks.length - 1];
      if (last === undefined) continue;
      const value = c[last] ?? '0';
      for (let i = 1; i <= op.months; i++) c[addMonths(last, i)] = value;
    }
  }

  for (const op of patch.scale ?? []) {
    for (const code of op.lineCodes) {
      const c = cellsOf(code);
      for (const k of Object.keys(c)) {
        if (k >= op.fromMonth) {
          c[k] = String(floorDiv(BigInt(c[k] ?? '0') * BigInt(op.factorPpm), 1_000_000n));
        }
      }
    }
  }

  for (const op of patch.set ?? []) {
    cellsOf(op.code)[op.month] = op.amountMinor;
  }

  if (patch.monthRangeTo !== undefined) plan.monthRange.to = patch.monthRangeTo;

  const body: EvaluateBody = { plan };
  if (patch.shareTarget !== undefined) body.shareTarget = patch.shareTarget;
  if (patch.draws !== undefined) body.draws = patch.draws;
  return body;
}
