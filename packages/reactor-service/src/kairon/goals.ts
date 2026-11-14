// packages/reactor-service/src/kairon/goals.ts
//
// Goals the user sets on drafts (DEV-1375). A goal is structured by the LLM
// and then handled by the server: `funding_cover` becomes manual draws equal to
// the parent's cash need (no LLM), `irr_floor` and `net_profit_target` steer the
// lever proposal and the ranking. checkGoals marks every goal per part of the
// forecast JSON for the parent and the draft (b1), month by month for a cover.

import { z } from 'zod';
import { addMonths, Month } from './patch.js';
import { formatMillions, summarizeEvaluation, type CurrencyFormat, type EvaluationMetrics } from './summary.js';

const FundingCoverSchema = z
  .object({
    type: z.literal('funding_cover'),
    partnerId: z.string().min(1),
    fromMonth: Month,
    months: z.number().int().min(1).max(24),
  })
  .strict();

export const GoalSchema = z.discriminatedUnion('type', [
  FundingCoverSchema,
  z.object({ type: z.literal('irr_floor'), partnerIds: z.array(z.string().min(1)).min(1) }).strict(),
  z
    .object({
      type: z.literal('net_profit_target'),
      amountMinor: z.string().min(1),
      basis: z.enum(['delta', 'absolute']),
    })
    .strict(),
]);

export type Goal = z.infer<typeof GoalSchema>;
export type FundingCoverGoal = z.infer<typeof FundingCoverSchema>;
export type Mark = 'ok' | 'warn' | 'breach' | 'unchecked';

export interface ManualDraw {
  sourceId: string;
  date: string;
  amountMinor: string;
  origin: 'manual';
}

/** What the ranking optimises; `promise` is the stage 4 default. */
export type RankGoal =
  | { type: 'promise'; partnerIds: string[] | null }
  | { type: 'net_profit_target'; targetMinor: string }
  | { type: 'max_net_profit' }
  | { type: 'min_partner_cash' }
  | { type: 'keep_reserve' };

export interface GoalCheck {
  goal: Goal;
  part: 'funding.draws' | 'exit.partners' | 'netProfit';
  label: string;
  parent: Mark;
  draft: Mark;
  /** One entry per month of a cover window; empty for goals without a window. */
  months: Array<{ month: string; parent: boolean; draft: boolean }>;
}

const FundingShape = z.object({
  walk: z.object({ cashNeedMinor: z.record(z.string()) }),
  sourceGroups: z.array(
    z.object({ sourceId: z.string(), partnerId: z.string().optional(), partnerName: z.string().optional() }),
  ),
  draws: z.array(z.object({ sourceId: z.string(), period: z.string(), amountMinor: z.string() })),
});

type Funding = z.infer<typeof FundingShape>;

function windowMonths(fromMonth: string, months: number): string[] {
  return Array.from({ length: months }, (_, i) => addMonths(fromMonth, i));
}

export function fundingCoverDraws(
  goal: FundingCoverGoal,
  parentEval: unknown,
  rules: { closedThrough: string; planEnd: string },
): { draws: ManualDraw[]; errors: string[] } {
  const funding = FundingShape.parse(parentEval);
  const months = windowMonths(goal.fromMonth, goal.months);
  const last = months[months.length - 1] ?? goal.fromMonth;
  const source = funding.sourceGroups.find((g) => g.partnerId === goal.partnerId);
  const errors: string[] = [];
  if (goal.fromMonth <= rules.closedThrough) errors.push(`${goal.fromMonth}: closed through ${rules.closedThrough}`);
  if (last > rules.planEnd) errors.push(`${last}: after the plan end ${rules.planEnd}`);
  if (source === undefined) errors.push(`${goal.partnerId}: no funding source for this partner`);
  if (errors.length > 0 || source === undefined) return { draws: [], errors };
  return {
    draws: months.map((month) => ({
      sourceId: source.sourceId,
      date: `${month}-01`,
      amountMinor: funding.walk.cashNeedMinor[month] ?? '0',
      origin: 'manual' as const,
    })),
    errors: [],
  };
}

/** Draw total per source id for one month: the partners' sources and the bank's. */
function sourceDraws(funding: Funding, month: string): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const d of funding.draws) {
    if (d.period.slice(0, 7) !== month) continue;
    totals.set(d.sourceId, (totals.get(d.sourceId) ?? 0n) + BigInt(d.amountMinor));
  }
  return totals;
}

/**
 * The named partner covers the month: its sources draw the whole need and every other source,
 * the bank included, draws 0 (DEV-1377).
 */
function coveredIn(funding: Funding, partnerId: string, month: string): boolean {
  const need = BigInt(funding.walk.cashNeedMinor[month] ?? '0');
  const own = new Set(funding.sourceGroups.filter((g) => g.partnerId === partnerId).map((g) => g.sourceId));
  let named = 0n;
  let othersDraw = false;
  for (const [sourceId, total] of sourceDraws(funding, month)) {
    if (own.has(sourceId)) named += total;
    else if (total !== 0n) othersDraw = true;
  }
  return named === need && !othersDraw;
}

const mark = (ok: boolean): Mark => (ok ? 'ok' : 'breach');

/** The goal in Russian words: the goal check's label and a cover draft's title. */
export function goalLabel(
  goal: Goal,
  nameOf: (partnerId: string) => string,
  currency: CurrencyFormat,
  parentNetProfitMinor: string,
): string {
  if (goal.type === 'funding_cover') {
    return `${nameOf(goal.partnerId)} покрывает всю потребность ${goal.months} мес. с ${goal.fromMonth}`;
  }
  if (goal.type === 'irr_floor') return `IRR не ниже обещания: ${goal.partnerIds.map(nameOf).join(', ')}`;
  const target = profitTargetMinor(goal, parentNetProfitMinor);
  return `Чистая прибыль не ниже ${formatMillions(String(target), currency.decimals, currency.currencyCode)}`;
}

function irrAtLeastPromise(metrics: EvaluationMetrics, approved: EvaluationMetrics, partnerIds: string[]): boolean {
  return partnerIds.every((id) => {
    const irr = metrics.partners.find((p) => p.partnerId === id)?.irr ?? null;
    const promised = approved.partners.find((p) => p.partnerId === id)?.irr ?? null;
    return irr !== null && promised !== null && irr >= promised;
  });
}

function profitTargetMinor(goal: Extract<Goal, { type: 'net_profit_target' }>, parentNetProfitMinor: string): bigint {
  return goal.basis === 'delta' ? BigInt(parentNetProfitMinor) + BigInt(goal.amountMinor) : BigInt(goal.amountMinor);
}

export function checkGoals(
  goals: Goal[],
  input: {
    approved: EvaluationMetrics;
    parentEval: unknown;
    draftEval: unknown;
    parentNetProfitMinor: string;
    currency: CurrencyFormat;
  },
): GoalCheck[] {
  const parentFunding = FundingShape.parse(input.parentEval);
  const draftFunding = FundingShape.parse(input.draftEval);
  const parent = summarizeEvaluation(input.parentEval);
  const draft = summarizeEvaluation(input.draftEval);
  const nameOf = (id: string) => input.approved.partners.find((p) => p.partnerId === id)?.name ?? id;
  const coverName = (id: string) => draftFunding.sourceGroups.find((g) => g.partnerId === id)?.partnerName ?? nameOf(id);
  return goals.map((goal): GoalCheck => {
    if (goal.type === 'funding_cover') {
      const months = windowMonths(goal.fromMonth, goal.months).map((month) => ({
        month,
        parent: coveredIn(parentFunding, goal.partnerId, month),
        draft: coveredIn(draftFunding, goal.partnerId, month),
      }));
      return {
        goal,
        part: 'funding.draws',
        label: goalLabel(goal, coverName, input.currency, input.parentNetProfitMinor),
        parent: mark(months.every((m) => m.parent)),
        draft: mark(months.every((m) => m.draft)),
        months,
      };
    }
    if (goal.type === 'irr_floor') {
      return {
        goal,
        part: 'exit.partners',
        label: goalLabel(goal, nameOf, input.currency, input.parentNetProfitMinor),
        parent: mark(irrAtLeastPromise(parent, input.approved, goal.partnerIds)),
        draft: mark(irrAtLeastPromise(draft, input.approved, goal.partnerIds)),
        months: [],
      };
    }
    const target = profitTargetMinor(goal, input.parentNetProfitMinor);
    return {
      goal,
      part: 'netProfit',
      label: goalLabel(goal, nameOf, input.currency, input.parentNetProfitMinor),
      parent: mark(BigInt(parent.netProfitMinor) >= target),
      draft: mark(BigInt(draft.netProfitMinor) >= target),
      months: [],
    };
  });
}

/** The newest profit target or IRR floor decides the ranking; a cover goal is a pass/fail check only. */
export function rankGoalOf(goals: Goal[], parentNetProfitMinor: string): RankGoal {
  const last = goals.filter((g) => g.type !== 'funding_cover').at(-1);
  if (last !== undefined && last.type === 'net_profit_target') {
    return { type: 'net_profit_target', targetMinor: String(profitTargetMinor(last, parentNetProfitMinor)) };
  }
  if (last !== undefined && last.type === 'irr_floor') return { type: 'promise', partnerIds: last.partnerIds };
  return { type: 'promise', partnerIds: null };
}
