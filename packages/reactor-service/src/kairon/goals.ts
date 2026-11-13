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

/** Draw total per partner id for one month; the bank is left out. */
function partnerDraws(funding: Funding, month: string): Map<string, bigint> {
  const partnerOf = new Map(funding.sourceGroups.flatMap((g) => (g.partnerId === undefined ? [] : [[g.sourceId, g.partnerId]])));
  const totals = new Map<string, bigint>();
  for (const d of funding.draws) {
    const partnerId = partnerOf.get(d.sourceId);
    if (partnerId === undefined || d.period.slice(0, 7) !== month) continue;
    totals.set(partnerId, (totals.get(partnerId) ?? 0n) + BigInt(d.amountMinor));
  }
  return totals;
}

function coveredIn(funding: Funding, partnerId: string, month: string): boolean {
  const need = BigInt(funding.walk.cashNeedMinor[month] ?? '0');
  const totals = partnerDraws(funding, month);
  const others = [...totals].filter(([id]) => id !== partnerId).every(([, v]) => v === 0n);
  return (totals.get(partnerId) ?? 0n) === need && others;
}

const mark = (ok: boolean): Mark => (ok ? 'ok' : 'breach');

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
  return goals.map((goal): GoalCheck => {
    if (goal.type === 'funding_cover') {
      const months = windowMonths(goal.fromMonth, goal.months).map((month) => ({
        month,
        parent: coveredIn(parentFunding, goal.partnerId, month),
        draft: coveredIn(draftFunding, goal.partnerId, month),
      }));
      const partnerName =
        draftFunding.sourceGroups.find((g) => g.partnerId === goal.partnerId)?.partnerName ?? goal.partnerId;
      return {
        goal,
        part: 'funding.draws',
        label: `${partnerName} покрывает всю потребность ${goal.months} мес. с ${goal.fromMonth}`,
        parent: mark(months.every((m) => m.parent)),
        draft: mark(months.every((m) => m.draft)),
        months,
      };
    }
    if (goal.type === 'irr_floor') {
      return {
        goal,
        part: 'exit.partners',
        label: `IRR не ниже обещания: ${goal.partnerIds.map(nameOf).join(', ')}`,
        parent: mark(irrAtLeastPromise(parent, input.approved, goal.partnerIds)),
        draft: mark(irrAtLeastPromise(draft, input.approved, goal.partnerIds)),
        months: [],
      };
    }
    const target = profitTargetMinor(goal, input.parentNetProfitMinor);
    return {
      goal,
      part: 'netProfit',
      label: `Чистая прибыль не ниже ${formatMillions(String(target), input.currency.decimals, input.currency.currencyCode)}`,
      parent: mark(BigInt(parent.netProfitMinor) >= target),
      draft: mark(BigInt(draft.netProfitMinor) >= target),
      months: [],
    };
  });
}

export function rankGoalOf(goals: Goal[], parentNetProfitMinor: string): RankGoal {
  const profit = goals.filter((g) => g.type === 'net_profit_target').at(-1);
  if (profit !== undefined && profit.type === 'net_profit_target') {
    return { type: 'net_profit_target', targetMinor: String(profitTargetMinor(profit, parentNetProfitMinor)) };
  }
  const floor = goals.filter((g) => g.type === 'irr_floor').at(-1);
  if (floor !== undefined && floor.type === 'irr_floor') return { type: 'promise', partnerIds: floor.partnerIds };
  return { type: 'promise', partnerIds: null };
}
