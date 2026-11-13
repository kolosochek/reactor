// packages/reactor-service/src/kairon/summary.ts
//
// Turns Kairon evaluate responses into the few figures the chat compares
// (DEV-1364): exit month, each partner's IRR, net profit, the senior bank's LTV
// and LTC, uncovered need, lowest cash balance. The explanation step cites
// figures only as {{row.metric}} placeholders; renderPlaceholders fills them
// from these facts, so every number on the page comes from the server.

import { z } from 'zod';
import type { VariantDiff } from './diff.js';

const EvaluationShape = z.object({
  version: z.object({ id: z.string() }),
  exit: z
    .object({
      month: z.string().nullable(),
      partners: z.array(z.object({ partnerId: z.string(), irr: z.number().nullable() })),
    })
    .nullable(),
  netProfit: z.string(),
  covenants: z.array(
    z.object({
      ltv: z.object({ ratioBp: z.number().nullable() }).optional(),
      ltc: z.object({ ratioBp: z.number().nullable() }).optional(),
    }),
  ),
  walk: z.object({
    uncoveredNeedMinor: z.record(z.string()),
    cashBalanceMinor: z.record(z.string()),
  }),
  partnerFrames: z
    .array(z.object({ partnerId: z.string(), name: z.string(), allocatedMinor: z.string().optional() }))
    .optional(),
});

export interface PartnerIrr {
  partnerId: string;
  name: string;
  irr: number | null;
}

/** A partner and its agreed share of partner money, from the project's settings.funding.partners. */
export interface PartnerShare {
  partnerId: string;
  name: string;
  sharePct: number;
}

export interface EvaluationMetrics {
  versionId: string;
  exitMonth: string | null;
  partners: PartnerIrr[];
  netProfitMinor: string;
  ltvBp: number | null;
  ltcBp: number | null;
  uncoveredNeedMinor: string;
  minCashBalanceMinor: string;
  /** partnerFrames[].allocatedMinor by partner id: the money each partner puts in over the plan. */
  partnerAllocatedMinor: Record<string, string>;
}

export function summarizeEvaluation(json: unknown): EvaluationMetrics {
  const r = EvaluationShape.parse(json);
  const names = new Map((r.partnerFrames ?? []).map((f) => [f.partnerId, f.name]));
  const balances = Object.values(r.walk.cashBalanceMinor).map((v) => BigInt(v));
  const minBalance = balances.reduce((min, v) => (v < min ? v : min), balances[0] ?? 0n);
  const bank = r.covenants[0];
  return {
    versionId: r.version.id,
    exitMonth: r.exit?.month ?? null,
    partners: (r.exit?.partners ?? []).map((p) => ({
      partnerId: p.partnerId,
      name: names.get(p.partnerId) ?? p.partnerId,
      irr: p.irr,
    })),
    netProfitMinor: r.netProfit,
    ltvBp: bank?.ltv?.ratioBp ?? null,
    ltcBp: bank?.ltc?.ratioBp ?? null,
    uncoveredNeedMinor: String(Object.values(r.walk.uncoveredNeedMinor).reduce((s, v) => s + BigInt(v), 0n)),
    minCashBalanceMinor: String(minBalance),
    partnerAllocatedMinor: Object.fromEntries(
      (r.partnerFrames ?? []).flatMap((f) => (f.allocatedMinor === undefined ? [] : [[f.partnerId, f.allocatedMinor]])),
    ),
  };
}

function irrOf(metrics: EvaluationMetrics, partnerId: string): number | null {
  return metrics.partners.find((p) => p.partnerId === partnerId)?.irr ?? null;
}

/** The largest IRR shortfall against the promise over the promised partners; Infinity when a partner has no IRR. */
export function shortfall(promised: PartnerIrr[], metrics: EvaluationMetrics): number {
  let worst = 0;
  for (const p of promised) {
    const irr = irrOf(metrics, p.partnerId);
    if (p.irr === null) continue;
    if (irr === null) return Number.POSITIVE_INFINITY;
    worst = Math.max(worst, p.irr - irr);
  }
  return worst;
}

/** Sum of the IRR distances to the promise; smaller means closer to the promise. */
export function distance(promised: PartnerIrr[], metrics: EvaluationMetrics): number {
  let sum = 0;
  for (const p of promised) {
    const irr = irrOf(metrics, p.partnerId);
    if (p.irr === null) continue;
    if (irr === null) return Number.POSITIVE_INFINITY;
    sum += Math.abs(irr - p.irr);
  }
  return sum;
}

export function rankVariants(
  promised: PartnerIrr[],
  rows: Array<{ id: string; metrics: EvaluationMetrics | null }>,
): string[] {
  const scored = rows.map((row) => ({
    id: row.id,
    shortfall: row.metrics === null ? Number.POSITIVE_INFINITY : shortfall(promised, row.metrics),
    distance: row.metrics === null ? Number.POSITIVE_INFINITY : distance(promised, row.metrics),
  }));
  scored.sort((a, b) => a.shortfall - b.shortfall || a.distance - b.distance || a.id.localeCompare(b.id));
  return scored.map((s) => s.id);
}

const RU = (digits: number) =>
  new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** 0.2071 -> "20,71 %". */
export function formatPercent(fraction: number): string {
  return `${RU(2).format(fraction * 100)} %`;
}

export function signed(value: number, digits: number): string {
  return `${value < 0 ? '-' : '+'}${RU(digits).format(Math.abs(value))}`;
}

export function formatMillions(minor: string, decimals: number, currencyCode: string): string {
  const value = BigInt(minor);
  const unit = 10n ** BigInt(decimals) * 100_000n;
  const abs = value < 0n ? -value : value;
  const tenths = (abs * 2n + unit) / (unit * 2n);
  const sign = value < 0n ? '-' : '';
  return `${sign}${new Intl.NumberFormat('ru-RU').format(tenths / 10n)},${tenths % 10n} млн ${currencyCode}`;
}

export interface CurrencyFormat {
  decimals: number;
  currencyCode: string;
}

export function buildFacts(
  currency: CurrencyFormat,
  promised: EvaluationMetrics,
  rows: Array<{ key: string; metrics: EvaluationMetrics }>,
): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const { key, metrics } of rows) {
    for (const p of metrics.partners) {
      if (p.irr === null) continue;
      facts[`${key}.irr.${p.partnerId}`] = `${RU(2).format(p.irr * 100)} %`;
      const target = irrOf(promised, p.partnerId);
      if (target !== null) facts[`${key}.gap.${p.partnerId}`] = `${signed((p.irr - target) * 100, 2)} п.п.`;
    }
    facts[`${key}.netProfit`] = formatMillions(metrics.netProfitMinor, currency.decimals, currency.currencyCode);
    if (metrics.ltvBp !== null) facts[`${key}.ltv`] = `${RU(2).format(metrics.ltvBp / 100)} %`;
    if (metrics.ltcBp !== null) facts[`${key}.ltc`] = `${RU(2).format(metrics.ltcBp / 100)} %`;
    if (metrics.exitMonth !== null) facts[`${key}.exitMonth`] = metrics.exitMonth;
    facts[`${key}.uncoveredNeed`] = formatMillions(metrics.uncoveredNeedMinor, currency.decimals, currency.currencyCode);
  }
  return facts;
}

function mapPlaceholders(template: string, replace: (key: string) => string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = template.indexOf('{{', pos);
    const close = open === -1 ? -1 : template.indexOf('}}', open + 2);
    if (open === -1 || close === -1) break;
    out += template.slice(pos, open) + replace(template.slice(open + 2, close).trim());
    pos = close + 2;
  }
  return out + template.slice(pos);
}

export function renderPlaceholders(
  template: string,
  facts: Record<string, string>,
): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const text = mapPlaceholders(template, (key) => {
    const value = facts[key];
    if (value === undefined) unknown.push(key);
    return value ?? `[?${key}]`;
  });
  return { text, unknown };
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/** A letter has distinct cases; covers Latin and Cyrillic, so "v1" reads as a name. */
function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ch.toLowerCase() !== ch.toUpperCase();
}

function digitRuns(text: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (!isDigit(text[i]) || isLetter(text[i - 1])) {
      i++;
      continue;
    }
    let j = i;
    while (isDigit(text[j]) || ((text[j] === ',' || text[j] === '.') && isDigit(text[j + 1]))) j++;
    found.push(text.slice(i, j));
    i = j;
  }
  return found;
}

/**
 * Numbers the LLM typed itself instead of citing a placeholder. Runs that also
 * appear in an allowed source (the user's scenario, the fact values) are not
 * reported: "3 месяца" or "2028-03" repeated from the scenario is not a figure.
 */
export function literalNumbers(template: string, allowedSources: string[]): string[] {
  const allowed = new Set(allowedSources.flatMap((source) => digitRuns(source)));
  return digitRuns(mapPlaceholders(template, () => ' ')).filter((run) => !allowed.has(run));
}

export function signedMillions(minor: bigint, currency: CurrencyFormat): string {
  const text = formatMillions(String(minor), currency.decimals, currency.currencyCode);
  return minor > 0n ? `+${text}` : text;
}

/** The figures a diff adds to the facts: deltas against the active forecast, the cash trough, the bridge rows. */
export function diffFacts(
  currency: CurrencyFormat,
  id: string,
  active: EvaluationMetrics,
  variant: EvaluationMetrics,
  diff: VariantDiff,
  /** The fact row of the diff's base side: 'active', or the parent draft's id for a child (stage 5). */
  baseKey = 'active',
): Record<string, string> {
  const facts: Record<string, string> = {};
  const money = (minor: string) => formatMillions(minor, currency.decimals, currency.currencyCode);
  facts[`${id}.d.netProfit`] = signedMillions(BigInt(diff.profit.variantNetMinor) - BigInt(diff.profit.activeNetMinor), currency);
  if (diff.profit.variantExitMinor !== null && diff.profit.activeExitMinor !== null) {
    facts[`${id}.exitProfit`] = money(diff.profit.variantExitMinor);
    facts[`${baseKey}.exitProfit`] = money(diff.profit.activeExitMinor);
    facts[`${id}.d.exitProfit`] = signedMillions(BigInt(diff.profit.variantExitMinor) - BigInt(diff.profit.activeExitMinor), currency);
  }
  for (const p of variant.partners) {
    const before = irrOf(active, p.partnerId);
    if (p.irr !== null && before !== null) facts[`${id}.d.irr.${p.partnerId}`] = `${signed((p.irr - before) * 100, 2)} п.п.`;
  }
  const sides = [
    { key: id, low: diff.cash.variantTrough, positive: diff.cash.variantPositive },
    { key: baseKey, low: diff.cash.activeTrough, positive: diff.cash.activePositive },
  ];
  for (const { key, low, positive } of sides) {
    if (low !== null) {
      facts[`${key}.trough`] = money(low.minor);
      facts[`${key}.troughMonth`] = low.month;
    }
    if (positive !== null) facts[`${key}.cashPositive`] = positive;
  }
  for (const row of diff.bridge) {
    if (BigInt(row.minor) !== 0n) facts[`${id}.bridge.${row.key}`] = signedMillions(BigInt(row.minor), currency);
  }
  return facts;
}

/**
 * Stage 5 facts of a draft against its parent (DEV-1375): what each partner and
 * all partners put in more or less (partnerFrames allocations), and the net
 * profit change as a share of the parent's net profit.
 */
export function allocationFacts(
  currency: CurrencyFormat,
  id: string,
  parent: EvaluationMetrics,
  variant: EvaluationMetrics,
): Record<string, string> {
  const facts: Record<string, string> = {};
  let total = 0n;
  for (const [partnerId, minor] of Object.entries(variant.partnerAllocatedMinor)) {
    const delta = BigInt(minor) - BigInt(parent.partnerAllocatedMinor[partnerId] ?? '0');
    total += delta;
    facts[`${id}.d.alloc.${partnerId}`] = signedMillions(delta, currency);
  }
  facts[`${id}.d.alloc`] = signedMillions(total, currency);
  const base = BigInt(parent.netProfitMinor);
  if (base !== 0n) {
    const change = BigInt(variant.netProfitMinor) - base;
    const abs = (v: bigint) => (v < 0n ? -v : v);
    facts[`${id}.d.netProfitShare`] = `${RU(1).format(Number((abs(change) * 10_000n) / abs(base)) / 100)} %`;
  }
  return facts;
}
