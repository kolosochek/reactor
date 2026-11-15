// packages/reactor-service/src/kairon/diff.ts
//
// What a variant changes against the active forecast (DEV-1364 stage 4), for
// the CFO report on the prototype page. Pure and deterministic: it reads the
// two plans (active and the patched body) and the two Kairon evaluate
// responses. The LLM never computes any of it; it only cites the figures as
// placeholders.
//
// - bridge: net profit change split by plan line group; a residual row keeps
//   the sum equal to the change Kairon reports.
// - events: when construction ends, the largest handover, the exit. evaluate
//   does not move milestones, so the shifts are read from the patched cells.
// - cash: the trough of the cumulative net cash and the month it is back at 0
//   or above. The month series are not here: the catalog widgets draw them from
//   widget data (DEV-1381).
// - notes: what the evaluation cannot see (a typed tax line, typed interest).

import { z } from 'zod';
import { bankNote, bankOf } from './bank.js';
import { INTEREST_LINE_CODES } from './checks.js';
import type { ForecastPlan } from './patch.js';
import { formatMillions, signedMillions, type CurrencyFormat } from './summary.js';

const EvalShape = z.object({
  netProfit: z.string(),
  exit: z
    .object({
      month: z.string().nullable(),
      profitMinor: z.string(),
      reconciliation: z
        .object({ exclusions: z.array(z.object({ kind: z.string(), minor: z.string() })) })
        .optional(),
    })
    .nullable(),
  draws: z.array(z.object({ provenance: z.string() })).default([]),
  walk: z.object({
    cumulativeNetCashMinor: z.record(z.string()),
    interestTotalMinor: z.string(),
  }),
});

type Evaluation = z.infer<typeof EvalShape>;

export type BridgeKey = 'revenue' | 'land' | 'construction' | 'reserve' | 'overheads' | 'financing' | 'tax' | 'other';

const BRIDGE: Array<{ key: BridgeKey; label: string }> = [
  { key: 'revenue', label: 'Выручка' },
  { key: 'land', label: 'Земля' },
  { key: 'construction', label: 'Стройка' },
  { key: 'reserve', label: 'Резерв' },
  { key: 'overheads', label: 'Накладные' },
  { key: 'financing', label: 'Финансирование' },
  { key: 'tax', label: 'Налог на прибыль' },
  { key: 'other', label: 'Прочее' },
];

/** Plan line groups that hold revenue (R sales, C other income); every other group is a cost. */
export const REVENUE_GROUP_CODES = ['R', 'C'];

/** Kairon's income tax line; typed on projects without derived lines. */
export const TAX_LINE_CODE = 'F7';

function bridgeKeyOf(code: string, groupCode: string | null | undefined): BridgeKey {
  if (code === TAX_LINE_CODE) return 'tax';
  switch (groupCode) {
    case 'R':
    case 'C':
      return 'revenue';
    case 'A':
      return 'land';
    case 'D':
      return 'construction';
    case 'U':
      return 'reserve';
    case 'O':
      return 'overheads';
    case 'F':
      return 'financing';
    default:
      return 'other';
  }
}

export interface MonthPoint {
  month: string;
  minor: string;
}

export interface VariantDiff {
  profit: { activeNetMinor: string; variantNetMinor: string; activeExitMinor: string | null; variantExitMinor: string | null };
  bridge: Array<{ key: BridgeKey; label: string; minor: string }>;
  events: Array<{ key: 'constructionEnd' | 'mainHandover' | 'exit'; label: string; active: string | null; variant: string | null }>;
  cash: {
    activeTrough: MonthPoint | null;
    variantTrough: MonthPoint | null;
    activePositive: string | null;
    variantPositive: string | null;
  };
  interest: { activeMinor: string; variantMinor: string };
  notes: string[];
}

export interface VariantDiffInput {
  currency: CurrencyFormat;
  closedThrough: string;
  derivedLineCodes: string[];
  activePlan: ForecastPlan;
  variantPlan: ForecastPlan;
  activeEval: unknown;
  variantEval: unknown;
}

function sumCells(cells: Record<string, string>): bigint {
  return Object.values(cells).reduce((s, v) => s + BigInt(v), 0n);
}

function groupTotals(plan: ForecastPlan): Map<BridgeKey, bigint> {
  const totals = new Map<BridgeKey, bigint>();
  for (const line of plan.lines) {
    const key = bridgeKeyOf(line.code, typeof line.groupCode === 'string' ? line.groupCode : null);
    totals.set(key, (totals.get(key) ?? 0n) + sumCells(line.monthlyForecast));
  }
  return totals;
}

/** The last month a line of the groups has a cell other than 0. */
function lastMonthOf(plan: ForecastPlan, groups: string[]): string | null {
  let to: string | null = null;
  for (const line of plan.lines) {
    if (typeof line.groupCode !== 'string' || !groups.includes(line.groupCode)) continue;
    for (const [month, value] of Object.entries(line.monthlyForecast)) {
      if (BigInt(value) === 0n) continue;
      if (to === null || month > to) to = month;
    }
  }
  return to;
}

function largestCellMonth(plan: ForecastPlan, groups: string[]): string | null {
  let best: MonthPoint | null = null;
  for (const line of plan.lines) {
    if (typeof line.groupCode !== 'string' || !groups.includes(line.groupCode)) continue;
    for (const [month, value] of Object.entries(line.monthlyForecast)) {
      if (best === null || BigInt(value) > BigInt(best.minor)) best = { month, minor: value };
    }
  }
  return best === null || BigInt(best.minor) <= 0n ? null : best.month;
}

function trough(record: Record<string, string>): MonthPoint | null {
  let low: MonthPoint | null = null;
  for (const month of Object.keys(record).sort()) {
    const minor = record[month] ?? '0';
    if (low === null || BigInt(minor) < BigInt(low.minor)) low = { month, minor };
  }
  return low;
}

/** First month after the trough when the cumulative net cash is back at 0 or above. */
function positiveAfter(record: Record<string, string>, low: MonthPoint | null): string | null {
  if (low === null || BigInt(low.minor) >= 0n) return null;
  return Object.keys(record).sort().find((m) => m > low.month && BigInt(record[m] ?? '0') >= 0n) ?? null;
}

function lineTotal(plan: ForecastPlan, codes: string[]): bigint {
  return plan.lines.filter((l) => codes.includes(l.code)).reduce((s, l) => s + sumCells(l.monthlyForecast), 0n);
}

function notesOf(input: VariantDiffInput, variant: Evaluation, bridge: Map<BridgeKey, bigint>): string[] {
  const { currency } = input;
  const notes: string[] = [];
  const revenueDelta = bridge.get('revenue') ?? 0n;
  const taxTyped = !input.derivedLineCodes.includes(TAX_LINE_CODE) && input.variantPlan.lines.some((l) => l.code === TAX_LINE_CODE);
  if (taxTyped && revenueDelta !== 0n && (bridge.get('tax') ?? 0n) === 0n) {
    notes.push(
      `Налог на прибыль (${TAX_LINE_CODE}) вписан в план и не пересчитан: выручка ${signedMillions(revenueDelta, currency)}, налог без изменений. Чистая прибыль варианта завышена на налог с этой разницы.`,
    );
  }
  const typedInterest = INTEREST_LINE_CODES.filter((c) => !input.derivedLineCodes.includes(c));
  const interestBasis = variant.exit?.reconciliation?.exclusions.find((e) => e.kind === 'interest_basis');
  const typedTotal = lineTotal(input.variantPlan, typedInterest);
  if (typedInterest.length > 0 && typedTotal !== 0n && interestBasis !== undefined) {
    notes.push(
      `Проценты ${typedInterest.join(', ')} вписаны в план: ${formatMillions(String(-typedTotal), currency.decimals, currency.currencyCode)}; чистая прибыль вычитает их. Прибыль на выходе для партнёров вычитает ещё проценты модели источников: ${formatMillions(String(-BigInt(interestBasis.minor)), currency.decimals, currency.currencyCode)}.`,
    );
  }
  if (variant.draws.length > 0 && variant.draws.every((d) => d.provenance === 'proposed')) {
    notes.push('Транши партнёров предлагает правило финансирования Kairon; вариант их не задаёт.');
  }
  // Why the funding plan shows no bank: read off the variant's own evaluate, never planned here.
  const bank = bankOf(input.variantEval, input.closedThrough);
  const bankLine = bank === null ? null : bankNote(bank, currency);
  if (bankLine !== null) notes.push(bankLine);
  return notes;
}

export function diffVariant(input: VariantDiffInput): VariantDiff {
  const active = EvalShape.parse(input.activeEval);
  const variant = EvalShape.parse(input.variantEval);

  const before = groupTotals(input.activePlan);
  const after = groupTotals(input.variantPlan);
  const deltas = new Map<BridgeKey, bigint>(BRIDGE.map(({ key }) => [key, (after.get(key) ?? 0n) - (before.get(key) ?? 0n)]));
  const netDelta = BigInt(variant.netProfit) - BigInt(active.netProfit);
  const explained = [...deltas.values()].reduce((s, v) => s + v, 0n);
  deltas.set('other', (deltas.get('other') ?? 0n) + netDelta - explained);

  const activeLow = trough(active.walk.cumulativeNetCashMinor);
  const variantLow = trough(variant.walk.cumulativeNetCashMinor);

  return {
    profit: {
      activeNetMinor: active.netProfit,
      variantNetMinor: variant.netProfit,
      activeExitMinor: active.exit?.profitMinor ?? null,
      variantExitMinor: variant.exit?.profitMinor ?? null,
    },
    bridge: BRIDGE.map(({ key, label }) => ({ key, label, minor: String(deltas.get(key) ?? 0n) })),
    events: [
      {
        key: 'constructionEnd',
        label: 'Конец стройки',
        active: lastMonthOf(input.activePlan, ['D']),
        variant: lastMonthOf(input.variantPlan, ['D']),
      },
      {
        key: 'mainHandover',
        label: 'Основная передача',
        active: largestCellMonth(input.activePlan, ['R']),
        variant: largestCellMonth(input.variantPlan, ['R']),
      },
      { key: 'exit', label: 'Выход', active: active.exit?.month ?? null, variant: variant.exit?.month ?? null },
    ],
    cash: {
      activeTrough: activeLow,
      variantTrough: variantLow,
      activePositive: positiveAfter(active.walk.cumulativeNetCashMinor, activeLow),
      variantPositive: positiveAfter(variant.walk.cumulativeNetCashMinor, variantLow),
    },
    interest: { activeMinor: active.walk.interestTotalMinor, variantMinor: variant.walk.interestTotalMinor },
    notes: notesOf(input, variant, deltas),
  };
}
