// packages/reactor-service/src/kairon/ranking.ts
//
// Goal-aware ranking of drafts (DEV-1375, spec 5.6). Three rules in order:
// 1. red lines: a draft that adds a breach (or misses its goal) is never
//    recommended and goes last; a breach the parent already had does not count;
// 2. the goal: the promise by default (IRR at or above it and closest), or a
//    profit target, or one of the switch goals;
// 3. fewer levers, then the id.
// A draft whose figures equal its parent's or an earlier draft's is dropped
// before ranking. The switches re-rank the same drafts under another goal and
// create nothing. The criteria matrix is the table the overview shows.

import type { RankGoal } from './goals.js';
import type { RedLine } from './redLines.js';
import {
  distance,
  formatMillions,
  shortfall,
  signed,
  signedMillions,
  type CurrencyFormat,
  type EvaluationMetrics,
  type PartnerIrr,
} from './summary.js';

export interface DraftScore {
  id: string;
  metrics: EvaluationMetrics;
  parentMetrics: EvaluationMetrics;
  leverCount: number;
  touchesReserve: boolean;
  reserveLeftMinor: string;
  addedBreaches: number;
  goalsMet: boolean;
  /**
   * The draft's own profit target when a net_profit_target goal ranks: its parent's net profit plus the
   * amount for a delta goal, the amount for an absolute one. null falls back to the goal's targetMinor.
   */
  profitTargetMinor: string | null;
}

export interface CriteriaRow {
  step: 1 | 2 | 3 | null;
  label: string;
  values: Record<string, string>;
  best: string | null;
}

export const SWITCH_GOALS: Array<{ label: string; goal: RankGoal }> = [
  { label: 'Важна прибыль как в плане', goal: { type: 'max_net_profit' } },
  { label: 'Меньше денег партнёров', goal: { type: 'min_partner_cash' } },
  { label: 'Прибыль без траты резерва', goal: { type: 'keep_reserve' } },
];

const sumOf = (record: Record<string, string>) => Object.values(record).reduce((s, v) => s + BigInt(v), 0n);

function partnerCashDelta(d: DraftScore): bigint {
  return sumOf(d.metrics.partnerAllocatedMinor) - sumOf(d.parentMetrics.partnerAllocatedMinor);
}

const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** Net profit over the draft's own target; children of different parents carry different targets. */
function overTarget(d: DraftScore, fallbackTargetMinor: string): bigint {
  return BigInt(d.metrics.netProfitMinor) - BigInt(d.profitTargetMinor ?? fallbackTargetMinor);
}

function promisedFor(approved: EvaluationMetrics, partnerIds: string[] | null): PartnerIrr[] {
  return approved.partners.filter((p) => partnerIds === null || partnerIds.includes(p.partnerId));
}

function goalCompare(goal: RankGoal, approved: EvaluationMetrics): (a: DraftScore, b: DraftScore) => number {
  const net = (d: DraftScore) => BigInt(d.metrics.netProfitMinor);
  switch (goal.type) {
    case 'promise': {
      const promised = promisedFor(approved, goal.partnerIds);
      return (a, b) =>
        shortfall(promised, a.metrics) - shortfall(promised, b.metrics) ||
        distance(promised, a.metrics) - distance(promised, b.metrics);
    }
    case 'net_profit_target': {
      const over = (d: DraftScore) => overTarget(d, goal.targetMinor);
      const below = (d: DraftScore) => (over(d) < 0n ? 1 : 0);
      const gap = (d: DraftScore) => (over(d) < 0n ? -over(d) : over(d));
      return (a, b) => below(a) - below(b) || cmpBig(gap(a), gap(b));
    }
    case 'max_net_profit':
      return (a, b) => cmpBig(net(b), net(a));
    case 'min_partner_cash':
      return (a, b) => cmpBig(partnerCashDelta(a), partnerCashDelta(b));
    case 'keep_reserve':
      return (a, b) => Number(a.touchesReserve) - Number(b.touchesReserve) || cmpBig(net(b), net(a));
  }
}

const excluded = (d: DraftScore) => d.addedBreaches > 0 || !d.goalsMet;

export function rankDrafts(
  drafts: DraftScore[],
  approved: EvaluationMetrics,
  goal: RankGoal,
): { ranking: string[]; notRecommendable: Array<{ id: string; reason: string }> } {
  const byGoal = goalCompare(goal, approved);
  const sorted = [...drafts].sort(
    (a, b) =>
      Number(excluded(a)) - Number(excluded(b)) ||
      byGoal(a, b) ||
      a.leverCount - b.leverCount ||
      a.id.localeCompare(b.id),
  );
  return {
    ranking: sorted.map((d) => d.id),
    notRecommendable: sorted
      .filter(excluded)
      .map((d) => ({ id: d.id, reason: d.addedBreaches > 0 ? 'добавляет нарушение красной линии' : 'не выполняет цель' })),
  };
}

function signature(m: EvaluationMetrics): string {
  return JSON.stringify([
    m.partners.map((p) => [p.partnerId, p.irr]),
    m.netProfitMinor,
    m.uncoveredNeedMinor,
    Object.entries(m.partnerAllocatedMinor).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

export function sameAsEarlier(
  drafts: Array<{ id: string; metrics: EvaluationMetrics }>,
  parent: EvaluationMetrics,
): Array<{ id: string; sameAs: string }> {
  const seen: Array<{ id: string; sig: string }> = [{ id: 'parent', sig: signature(parent) }];
  const dropped: Array<{ id: string; sameAs: string }> = [];
  for (const d of drafts) {
    const sig = signature(d.metrics);
    const twin = seen.find((s) => s.sig === sig);
    if (twin === undefined) seen.push({ id: d.id, sig });
    else dropped.push({ id: d.id, sameAs: twin.id });
  }
  return dropped;
}

export function switchesFor(drafts: DraftScore[], approved: EvaluationMetrics): Array<{ label: string; winner: string }> {
  return SWITCH_GOALS.flatMap(({ label, goal }) => {
    const winner = rankDrafts(drafts, approved, goal).ranking[0];
    return winner === undefined ? [] : [{ label, winner }];
  });
}

function redLineSummary(lines: RedLine[]): string {
  const count = (pred: (l: RedLine) => boolean) => lines.filter(pred).length;
  const parts: Array<[number, string]> = [
    [count((l) => l.status === 'ok'), '✓'],
    [count((l) => l.status === 'warn'), '⚠'],
    [count((l) => l.status === 'breach' && l.baseStatus !== 'breach'), '✗'],
  ];
  const out = parts.filter(([n]) => n > 0).map(([n, icon]) => `${icon} ${n}`);
  const base = count((l) => l.status === 'breach' && l.baseStatus === 'breach');
  if (base > 0) out.push(`✗ ${base} в базе`);
  const unchecked = count((l) => l.status === 'unchecked');
  if (unchecked > 0) out.push(`○ ${unchecked}`);
  return out.join(' · ');
}

/** The first id whose value is best by `better` (a strictly better later value wins). */
function bestOf<T>(drafts: DraftScore[], valueOf: (d: DraftScore) => T | null, better: (a: T, b: T) => boolean): string | null {
  let best: { id: string; value: T } | null = null;
  for (const d of drafts) {
    const value = valueOf(d);
    if (value === null) continue;
    if (best === null || better(value, best.value)) best = { id: d.id, value };
  }
  return best?.id ?? null;
}

export function criteriaMatrix(
  drafts: DraftScore[],
  approved: EvaluationMetrics,
  redLinesById: Record<string, RedLine[]>,
  currency: CurrencyFormat,
  goal: RankGoal = { type: 'promise', partnerIds: null },
): CriteriaRow[] {
  const values = (f: (d: DraftScore) => string) => Object.fromEntries(drafts.map((d) => [d.id, f(d)]));
  const money = (minor: bigint) => formatMillions(String(minor), currency.decimals, currency.currencyCode);
  const lineCount = redLinesById[drafts[0]?.id ?? '']?.length ?? 0;
  const rows: CriteriaRow[] = [
    { step: 1, label: `Красные линии (${lineCount})`, values: values((d) => redLineSummary(redLinesById[d.id] ?? [])), best: null },
  ];
  if (goal.type === 'promise') {
    for (const p of promisedFor(approved, goal.partnerIds)) {
      const promise = p.irr;
      if (promise === null) continue;
      const margin = (d: DraftScore) => {
        const irr = d.metrics.partners.find((x) => x.partnerId === p.partnerId)?.irr ?? null;
        return irr === null ? null : irr - promise;
      };
      rows.push({
        step: 2,
        label: `Запас IRR над обещанием, ${p.name}`,
        values: values((d) => {
          const m = margin(d);
          return m === null ? 'нет IRR' : `${signed(m * 100, 2)} п.п.`;
        }),
        best: bestOf(drafts, (d) => {
          const m = margin(d);
          return m === null || m < 0 ? null : m;
        }, (a, b) => a < b),
      });
    }
  }
  if (goal.type === 'net_profit_target') {
    const over = (d: DraftScore) => overTarget(d, goal.targetMinor);
    rows.push({
      step: 2,
      label: 'Чистая прибыль к цели',
      values: values((d) => signedMillions(over(d), currency)),
      best: bestOf(drafts, (d) => (over(d) < 0n ? null : over(d)), (a, b) => a < b),
    });
  }
  rows.push({
    step: 3,
    label: 'Рычаги',
    values: values((d) => (d.leverCount === 0 ? 'нет' : String(d.leverCount))),
    best: bestOf(drafts, (d) => d.leverCount, (a, b) => a < b),
  });
  const netDelta = (d: DraftScore) => BigInt(d.metrics.netProfitMinor) - BigInt(d.parentMetrics.netProfitMinor);
  rows.push({
    step: goal.type === 'max_net_profit' ? 2 : null,
    label: 'Чистая прибыль к базе',
    values: values((d) => signedMillions(netDelta(d), currency)),
    best: bestOf(drafts, netDelta, (a, b) => a > b),
  });
  rows.push({
    step: goal.type === 'min_partner_cash' ? 2 : null,
    label: 'Партнёры вносят дополнительно',
    values: values((d) => signedMillions(partnerCashDelta(d), currency)),
    best: bestOf(drafts, partnerCashDelta, (a, b) => a < b),
  });
  rows.push({
    step: goal.type === 'keep_reserve' ? 2 : null,
    label: 'Резерв после решения',
    values: values((d) => money(BigInt(d.reserveLeftMinor))),
    best: bestOf(drafts, (d) => BigInt(d.reserveLeftMinor), (a, b) => a > b),
  });
  const order = (r: CriteriaRow) => r.step ?? 4;
  return rows.map((r, i) => ({ r, i })).sort((a, b) => order(a.r) - order(b.r) || a.i - b.i).map(({ r }) => r);
}
