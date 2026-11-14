// packages/reactor-service/src/kairon/checks.ts
//
// Checks a forecast patch before it reaches Kairon evaluate (DEV-1364). The
// server refuses closed-month and derived-line writes with 422; checking them
// here lets the LLM retry with a precise reason. Closed-month writes are found
// by diffing the plan before and after the patch, so every op kind is covered.
//
// Two rules came from the live run of 13.11: extend on a revenue line invents
// income, and a delay that leaves a running overhead (group O) ending where it
// did understates the cost of the delay. Typed interest lines (F2, F3 when the
// server does not derive them) must end later too: the loans run until the exit
// (owner's rule, 13.11). Steady construction and fee lines are not forced: a
// sales-only delay keeps them as planned.

import {
  addMonths,
  applyPatch,
  monthsBetween,
  type EvaluateBody,
  type ForecastDocument,
  type ForecastPatch,
} from './patch.js';

export interface PatchRules {
  closedThrough: string;
  derivedLineCodes: string[];
}

export interface PatchCheck {
  errors: string[];
  adjustments: string[];
  body: EvaluateBody | null;
}

const SCALE_MIN_PPM = 970_000;
const SCALE_MAX_PPM = 1_030_000;
const MAX_MONTHS = 24;

export function patchLineCodes(patch: ForecastPatch): string[] {
  const codes = new Set<string>();
  for (const op of [...(patch.stretch ?? []), ...(patch.shift ?? []), ...(patch.extend ?? []), ...(patch.scale ?? [])]) {
    for (const code of op.lineCodes) codes.add(code);
  }
  for (const op of patch.set ?? []) codes.add(op.code);
  return [...codes];
}

/** The size of a lever patch: one per op entry, one for a month range, one for a share target. */
export function patchOpCount(patch: ForecastPatch): number {
  const entries = [patch.stretch, patch.shift, patch.extend, patch.scale, patch.set].reduce((n, ops) => n + (ops?.length ?? 0), 0);
  return entries + (patch.monthRangeTo === undefined ? 0 : 1) + (patch.shareTarget === undefined ? 0 : 1);
}

/**
 * The errors of a lever outside its bounds: a scale beyond ±3 %, a shift, stretch or extend beyond the month limit.
 * A draft refused only for these asked for more than the levers may give; any other error is a mistake in the reply.
 */
export function leverBoundErrors(patch: ForecastPatch): string[] {
  const errors: string[] = [];
  for (const op of patch.scale ?? []) {
    if (op.factorPpm < SCALE_MIN_PPM || op.factorPpm > SCALE_MAX_PPM) {
      errors.push(
        `scale: factorPpm ${op.factorPpm} is outside ${SCALE_MIN_PPM}..${SCALE_MAX_PPM} (at most 3 % either way)`,
      );
    }
  }
  for (const op of [...(patch.stretch ?? []), ...(patch.shift ?? [])]) {
    if (Math.abs(op.byMonths) > MAX_MONTHS) errors.push(`byMonths ${op.byMonths} is outside -${MAX_MONTHS}..${MAX_MONTHS}`);
  }
  for (const op of patch.extend ?? []) {
    if (op.months > MAX_MONTHS) errors.push(`extend: months ${op.months} is above ${MAX_MONTHS}`);
  }
  return errors;
}

function boundErrors(patch: ForecastPatch): string[] {
  const draws = patch.draws === undefined ? [] : ['draws: not supported by this prototype; leave them out'];
  return [...leverBoundErrors(patch), ...draws];
}

function nonZeroCells(cells: Record<string, string>): Array<[string, bigint]> {
  return Object.entries(cells)
    .map(([month, value]): [string, bigint] => [month, BigInt(value)])
    .filter(([, value]) => value !== 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const RUNNING_MONTHS = 3;
/** Plan line group of company overheads (administration, project management). */
export const OVERHEAD_GROUP = 'O';
/** Kairon's interest lines: bank and private capital. Typed on projects that do not derive them. */
export const INTEREST_LINE_CODES = ['F2', 'F3'];

/** A cost that repeats the same amount in its last three consecutive non-zero months (overheads, fees, construction). */
export function runningCost(cells: Record<string, string>): { monthlyMinor: string; lastMonth: string } | null {
  const tail = nonZeroCells(cells).slice(-RUNNING_MONTHS);
  const first = tail[0];
  const last = tail.at(-1);
  if (tail.length < RUNNING_MONTHS || first === undefined || last === undefined || last[1] >= 0n) return null;
  const steady = tail.every(([, value]) => value === last[1]) && monthsBetween(first[0], last[0]) === RUNNING_MONTHS - 1;
  return steady ? { monthlyMinor: String(last[1]), lastMonth: last[0] } : null;
}

function lastCell(cells: Record<string, string>): [string, bigint] | null {
  return nonZeroCells(cells).at(-1) ?? null;
}

function revenueExtendErrors(doc: ForecastDocument, patch: ForecastPatch): string[] {
  const codes = new Set((patch.extend ?? []).flatMap((op) => op.lineCodes));
  return doc.plan.lines
    .filter((line) => codes.has(line.code) && (lastCell(line.monthlyForecast)?.[1] ?? 0n) > 0n)
    .map((line) => `${line.code}: extend repeats the last monthly revenue and invents income; move revenue with shift`);
}

function delayErrors(doc: ForecastDocument, body: EvaluateBody, rules: PatchRules): string[] {
  const delay = monthsBetween(doc.plan.monthRange.to, body.plan.monthRange.to);
  if (delay <= 0) return [];
  const to = body.plan.monthRange.to;
  const after = new Map(body.plan.lines.map((l) => [l.code, l.monthlyForecast]));
  const endAfter = (code: string) => lastCell(after.get(code) ?? {})?.[0] ?? '';
  const errors: string[] = [];
  for (const line of doc.plan.lines) {
    const open = Object.fromEntries(Object.entries(line.monthlyForecast).filter(([m]) => m > rules.closedThrough));
    const running = line.groupCode === OVERHEAD_GROUP ? runningCost(open) : null;
    if (running !== null && endAfter(line.code) <= running.lastMonth) {
      errors.push(
        `${line.code}: runs at ${running.monthlyMinor} a month and still ends ${running.lastMonth}, while the plan now ends ${delay} months later (${to}); move it with the delay: extend, stretch or shift`,
      );
    }
    const typedInterest = INTEREST_LINE_CODES.includes(line.code) && !rules.derivedLineCodes.includes(line.code);
    const interestEnd = typedInterest ? lastCell(open)?.[0] : undefined;
    if (interestEnd !== undefined && endAfter(line.code) <= interestEnd) {
      errors.push(
        `${line.code}: typed interest still ends ${interestEnd}, while the plan now ends ${delay} months later (${to}); the loans run until the exit: extend it`,
      );
    }
  }
  return errors;
}

function changedMonths(before: Record<string, string>, after: Record<string, string>): string[] {
  const months = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...months].filter((m) => BigInt(before[m] ?? '0') !== BigInt(after[m] ?? '0')).sort();
}

function lastNonZeroMonth(body: EvaluateBody): string | null {
  let last: string | null = null;
  for (const line of body.plan.lines) {
    for (const [month, value] of Object.entries(line.monthlyForecast)) {
      if (BigInt(value) !== 0n && (last === null || month > last)) last = month;
    }
  }
  return last;
}

export function checkPatch(doc: ForecastDocument, rules: PatchRules, patch: ForecastPatch): PatchCheck {
  const known = new Set(doc.plan.lines.map((l) => l.code));
  const derived = new Set(rules.derivedLineCodes);
  const codes = patchLineCodes(patch);
  const errors = [
    ...codes.filter((c) => !known.has(c)).map((c) => `${c}: unknown line code`),
    ...codes.filter((c) => derived.has(c)).map((c) => `${c}: the server derives this line; leave it out of the patch`),
    ...boundErrors(patch),
  ];
  if (errors.length > 0) return { errors, adjustments: [], body: null };

  const body = applyPatch(doc, patch);
  const beforeByCode = new Map(doc.plan.lines.map((l) => [l.code, l.monthlyForecast]));
  for (const line of body.plan.lines) {
    const closed = changedMonths(beforeByCode.get(line.code) ?? {}, line.monthlyForecast).filter(
      (m) => m <= rules.closedThrough,
    );
    if (closed.length > 0) {
      errors.push(
        `${line.code}: the patch changes closed months ${closed.join(', ')} (closed through ${rules.closedThrough}); start the change at ${addMonths(rules.closedThrough, 1)} or later`,
      );
    }
  }
  if (errors.length > 0) return { errors, adjustments: [], body: null };
  const changesCells = body.plan.lines.some(
    (line) => changedMonths(beforeByCode.get(line.code) ?? {}, line.monthlyForecast).length > 0,
  );
  if (!changesCells && body.plan.monthRange.to === doc.plan.monthRange.to && patch.shareTarget === undefined) {
    return {
      errors: ['the patch changes nothing: no cell, no monthRangeTo and no shareTarget differ from the forecast'],
      adjustments: [],
      body: null,
    };
  }

  const adjustments: string[] = [];
  const last = lastNonZeroMonth(body);
  if (last !== null && last > body.plan.monthRange.to) {
    adjustments.push(`monthRange.to moved ${body.plan.monthRange.to} -> ${last} to cover the last non-zero cell`);
    body.plan.monthRange.to = last;
  }
  const content = [...revenueExtendErrors(doc, patch), ...delayErrors(doc, body, rules)];
  if (content.length > 0) return { errors: content, adjustments: [], body: null };
  return { errors: [], adjustments, body };
}
