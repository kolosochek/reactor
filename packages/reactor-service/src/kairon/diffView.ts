// packages/reactor-service/src/kairon/diffView.ts
//
// Data for the copy of Kairon's forecast diff view (DEV-1375, spec 5.4.6).
// Kairon's «Set active» review (frontend activation-review-model.ts) answers
// four questions; this copies their meaning for a draft, not the code:
// - what changes against the parent: cost and revenue deltas, every line
//   whose total moves;
// - what does not add up to the approved budget: the cost total's gap, the
//   lines that differ, each differing group in words;
// - who contributes: the bank's walk allocation and each partner's served
//   partnerFrames allocation, parent → draft;
// - does the funding cover the need: uncovered need in open months, and what
//   the funding rule and the share signal say.
// Plans hold costs as negative cells and revenue as positive ones, so a cost
// delta of −53,7 млн means 53,7 млн more cost; the renderer puts that in words.

import { z } from 'zod';
import type { VariantDiff } from './diff.js';
import type { ForecastPlan, PlanLine } from './patch.js';

export interface DiffView {
  tiles: {
    costsDeltaMinor: string;
    revenueDeltaMinor: string;
    overApprovedMinor: string;
    overApprovedLines: number;
    uncoveredMinor: string;
    uncoveredParentMinor: string;
  };
  changedLines: Array<{ code: string; name: string; parentMinor: string; draftMinor: string }>;
  contributors: Array<{ name: string; group: 'bank' | 'partner'; parentMinor: string; draftMinor: string }>;
  againstApproved: Array<{
    groupCode: string;
    draftMinor: string;
    approvedMinor: string;
    words: 'перерасход' | 'экономия' | 'выше плана' | 'ниже плана';
  }>;
  coverage: { covered: boolean; notices: string[] };
  events: VariantDiff['events'];
}

const Notice = z.object({ kind: z.string(), month: z.string().nullable().optional() }).passthrough();

const ViewShape = z.object({
  factBoundary: z.object({ month: z.string().nullable() }).nullable(),
  walk: z.object({
    uncoveredNeedMinor: z.record(z.string()),
    sources: z.array(z.object({ id: z.string(), name: z.string(), allocatedMinor: z.string() })),
  }),
  sourceGroups: z.array(z.object({ sourceId: z.string(), group: z.string() })),
  partnerFrames: z.array(z.object({ partnerId: z.string(), name: z.string(), allocatedMinor: z.string() })).default([]),
  ruleNotices: z.array(Notice).default([]),
  fundingSignals: z.array(Notice).default([]),
});

type Evaluation = z.infer<typeof ViewShape>;

const NOTICE_WORDS: Record<string, string> = {
  anchor_gap: 'Касса расходится с выпиской на конец месяца',
  share_outside_target: 'Доля частного капитала вне цели',
  bridge_matures_before_takeout: 'Бридж заканчивается раньше, чем его выкупает банк',
  bridge_unpaid_at_maturity: 'Бридж не погашен к сроку',
  pinned_month_below_payoff: 'Закреплённый месяц ниже погашения',
  unpaid_at_horizon: 'Не погашено к концу горизонта',
};

const totalOf = (line: PlanLine) => Object.values(line.monthlyForecast).reduce((s, v) => s + BigInt(v), 0n);

function sideTotal(plan: ForecastPlan, revenue: boolean, revenueGroups: string[]): bigint {
  return plan.lines
    .filter((l) => revenueGroups.includes(String(l.groupCode ?? '')) === revenue)
    .reduce((s, l) => s + totalOf(l), 0n);
}

function openUncovered(e: Evaluation): bigint {
  const closed = e.factBoundary?.month ?? '';
  return Object.entries(e.walk.uncoveredNeedMinor)
    .filter(([m]) => m > closed)
    .reduce((s, [, v]) => s + BigInt(v), 0n);
}

function contributors(parent: Evaluation, draft: Evaluation): DiffView['contributors'] {
  const bankIds = new Set(draft.sourceGroups.filter((g) => g.group === 'bank').map((g) => g.sourceId));
  const parentSource = new Map(parent.walk.sources.map((s) => [s.id, s.allocatedMinor]));
  const parentFrame = new Map(parent.partnerFrames.map((f) => [f.partnerId, f.allocatedMinor]));
  return [
    ...draft.walk.sources
      .filter((s) => bankIds.has(s.id))
      .map((s) => ({ name: s.name, group: 'bank' as const, parentMinor: parentSource.get(s.id) ?? '0', draftMinor: s.allocatedMinor })),
    ...draft.partnerFrames.map((f) => ({
      name: f.name,
      group: 'partner' as const,
      parentMinor: parentFrame.get(f.partnerId) ?? '0',
      draftMinor: f.allocatedMinor,
    })),
  ];
}

function againstApproved(draft: ForecastPlan, approved: ForecastPlan, revenueGroups: string[]): DiffView['againstApproved'] {
  // A line counts in the draft's group for its code (Kairon groups by the draft's grid rows); the approved plan
  // may file the same line elsewhere (Rivergate's approved F7 sits in group F7, the draft's in F).
  const draftGroupOf = new Map(draft.lines.map((l) => [l.code, String(l.groupCode ?? '')]));
  const groups = new Map<string, { draft: bigint; approved: bigint }>();
  const add = (line: PlanLine, key: 'draft' | 'approved') => {
    const code = draftGroupOf.get(line.code) ?? String(line.groupCode ?? '');
    const g = groups.get(code) ?? { draft: 0n, approved: 0n };
    g[key] += totalOf(line);
    groups.set(code, g);
  };
  for (const line of draft.lines) add(line, 'draft');
  for (const line of approved.lines) add(line, 'approved');
  return [...groups.entries()]
    .filter(([, g]) => g.draft !== g.approved)
    .map(([groupCode, g]) => {
      const up = g.draft > g.approved;
      const revenue = revenueGroups.includes(groupCode);
      const words = revenue ? (up ? 'выше плана' : 'ниже плана') : up ? 'экономия' : 'перерасход';
      return { groupCode, draftMinor: String(g.draft), approvedMinor: String(g.approved), words };
    });
}

export function forecastDiffView(input: {
  parentPlan: ForecastPlan;
  draftPlan: ForecastPlan;
  approvedPlan: ForecastPlan;
  parentEval: unknown;
  draftEval: unknown;
  diff: VariantDiff;
  revenueGroups: string[];
}): DiffView {
  const parent = ViewShape.parse(input.parentEval);
  const draft = ViewShape.parse(input.draftEval);
  const { parentPlan, draftPlan, approvedPlan, revenueGroups } = input;
  const parentLines = new Map(parentPlan.lines.map((l) => [l.code, totalOf(l)]));
  const approvedLines = new Map(approvedPlan.lines.map((l) => [l.code, totalOf(l)]));
  const changedLines = draftPlan.lines
    .map((l) => ({ line: l, before: parentLines.get(l.code) ?? 0n, after: totalOf(l) }))
    .filter((c) => c.before !== c.after)
    .sort((a, b) => {
      const da = a.after - a.before;
      const db = b.after - b.before;
      const abs = (v: bigint) => (v < 0n ? -v : v);
      return abs(db) > abs(da) ? 1 : abs(db) < abs(da) ? -1 : 0;
    })
    .map((c) => ({ code: c.line.code, name: c.line.name, parentMinor: String(c.before), draftMinor: String(c.after) }));
  const uncovered = openUncovered(draft);
  const notices = [...draft.ruleNotices, ...draft.fundingSignals].map((n) => {
    const words = NOTICE_WORDS[n.kind] ?? n.kind;
    return typeof n.month === 'string' ? `${words}: ${n.month}` : words;
  });
  return {
    tiles: {
      costsDeltaMinor: String(sideTotal(draftPlan, false, revenueGroups) - sideTotal(parentPlan, false, revenueGroups)),
      revenueDeltaMinor: String(sideTotal(draftPlan, true, revenueGroups) - sideTotal(parentPlan, true, revenueGroups)),
      overApprovedMinor: String(sideTotal(approvedPlan, false, revenueGroups) - sideTotal(draftPlan, false, revenueGroups)),
      overApprovedLines: draftPlan.lines.filter((l) => totalOf(l) !== (approvedLines.get(l.code) ?? 0n)).length,
      uncoveredMinor: String(uncovered),
      uncoveredParentMinor: String(openUncovered(parent)),
    },
    changedLines,
    contributors: contributors(parent, draft),
    againstApproved: againstApproved(draftPlan, approvedPlan, revenueGroups),
    coverage: { covered: uncovered === 0n, notices },
    events: input.diff.events,
  };
}
