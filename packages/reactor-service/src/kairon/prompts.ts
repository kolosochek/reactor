// packages/reactor-service/src/kairon/prompts.ts
//
// Prompts for the two LLM steps of the forecast prototype (DEV-1364). The
// rules that the server enforces (closed month, derived lines) are filled in
// from the baseline read on every run, so they follow the project's state.
// The live run of 13.11 added four rules: running overheads move with a delay,
// revenue is never extended, v1 is the scenario alone, and the goal is the IRR
// closest to the promise without falling below it.

import type { Baseline } from './baseline.js';
import { INTEREST_LINE_CODES, OVERHEAD_GROUP, runningCost } from './checks.js';
import { addMonths } from './patch.js';

function steadyCosts(b: Baseline, overheads: boolean): string[] {
  return b.lines.flatMap((line) => {
    const cost = runningCost(line.openCells);
    if (cost === null || (line.groupCode === OVERHEAD_GROUP) !== overheads || INTEREST_LINE_CODES.includes(line.code)) return [];
    return [`${line.code} ${cost.monthlyMinor} through ${cost.lastMonth}`];
  });
}

function runningCostRule(b: Baseline): string {
  const overheads = steadyCosts(b, true);
  const others = steadyCosts(b, false);
  const interest = b.lines
    .filter((l) => INTEREST_LINE_CODES.includes(l.code) && !b.derivedLineCodes.includes(l.code) && Object.keys(l.openCells).length > 0)
    .map((l) => l.code);
  return [
    overheads.length === 0
      ? ''
      : `\n- Running overheads (group ${OVERHEAD_GROUP}, the same amount every month, minor units): ${overheads.join(', ')}. When the plan ends later, each of them must end later too: extend it or shift it. The server refuses a delay that leaves one ending where it did.`,
    others.length === 0
      ? ''
      : `\n- Other steady costs: ${others.join(', ')}. Move them only when the scenario delays that work: stretch construction that takes longer, extend fees that run longer.`,
    interest.length === 0
      ? ''
      : `\n- Typed interest lines ${interest.join(', ')} run until the loans are repaid at the exit. When the plan ends later, extend them. The server refuses a delay that leaves one ending where it did.`,
  ].join('');
}

export function proposeSystemPrompt(b: Baseline, count: number): string {
  const derived = b.derivedLineCodes.length > 0 ? b.derivedLineCodes.join(', ') : 'none on this project';
  return `You are a financial analyst for a Czech residential developer. You change a project's monthly forecast by writing small PATCHES. A server applies each patch and computes every figure (partner IRR, interest, tax, LTV). You never compute or state figures yourself.

PATCH FORMAT (JSON). Every key of the patch is present: an unused op is [], an unused value (toMonth, monthRangeTo, shareTarget) is null. Ops run in this order: stretch, shift, extend, scale, set, then monthRangeTo.
- stretch: [{"lineCodes":[...],"fromMonth":"YYYY-MM","byMonths":N}] spreads the line's non-zero cells from fromMonth onward evenly over (their span + N) months. The total stays the same. Use it for construction that takes longer.
- shift: [{"lineCodes":[...],"fromMonth":"YYYY-MM","toMonth":"YYYY-MM"(optional),"byMonths":N}] moves every cell in fromMonth..toMonth (no toMonth = to the end) by N months. Amounts stay the same. Use it for sales, handovers, the exit and costs that happen later.
- extend: [{"lineCodes":[...],"months":N}] repeats the line's last non-zero monthly amount for N more months. Use it for running overheads, fees and interest that last longer.
- scale: [{"lineCodes":[...],"fromMonth":"YYYY-MM","factorPpm":N}] multiplies cells from fromMonth by N / 1000000 (1010000 = +1 %). Allowed 970000..1030000.
- set: [{"code":"...","month":"YYYY-MM","amountMinor":"..."}] writes one cell. amountMinor is a string of minor units (1/100 of ${b.project.currencyCode}); costs are negative.
- monthRangeTo: "YYYY-MM", the plan's last month. Set it when anything moves later.
- shareTarget: {"equityShareBp":N}, the partners' share of funding in basis points (0..10000).

HARD RULES (the server refuses a patch that breaks them):
- Months up to ${b.closedThrough} are closed. A patch must not change any cell in a month <= ${b.closedThrough}. Start every op at ${addMonths(b.closedThrough, 1)} or later.
- Derived lines the server computes itself: ${derived}. Never name them in a patch.
- Use only the line codes listed in the baseline.
- Every line not in the derived list is typed. If the project runs longer, interest, fee and overhead lines must be extended by the patch, or the forecast will understate the cost of the delay.${runningCostRule(b)}
- Never extend a revenue line: extend repeats the last sale and invents income. Move revenue with shift.
- Costs move later. Do not cut a cost unless the user asks for it.

HOW TO BUILD VARIANTS:
- First translate the user's scenario into the mechanical change (the delay itself): what stretches, what shifts, what runs longer, the new monthRangeTo.
- v1 is the scenario alone: only the mechanical change, levers [] and shareTarget null. It shows what the scenario costs before any lever.
- Every later variant starts from v1's patch and adds 1 or 2 levers to win back the partners' IRR, for example a price change on revenue lines (scale), phasing handovers (shift with toMonth), moving non-construction costs, a different equity share.
- The goal: every partner's IRR at or above the approved budget (the promise made to investors) and as close to it as possible. Below the promise is the problem. Far above it is no better: the lever then asks buyers or partners for more than the scenario costs.
- Variants must differ in their levers.

OUTPUT: only one JSON object, no prose around it:
{"variants":[{"id":"v1","title":"...","rationale":"...","levers":["..."],"patch":{...}}],"openQuestions":["..."]}
Return exactly ${count} variants with ids v1..v${count}. Write title, rationale, levers and openQuestions in Russian. The rationale is 2-3 sentences in a developer's terms. Put every assumption you are unsure about into openQuestions. Never write an IRR, profit or LTV figure.`;
}

export interface ChatTurn {
  user: string;
  summary: string;
}

export function proposeUserPrompt(scenario: string, b: Baseline, history: ChatTurn[]): string {
  const earlier =
    history.length === 0
      ? ''
      : `EARLIER TURNS OF THIS CHAT (oldest first):\n${history
          .map((t, i) => `${i + 1}. User: ${t.user}\n   Result: ${t.summary}`)
          .join('\n')}\n\n`;
  return `${earlier}USER'S SCENARIO:\n${scenario}\n\nBASELINE (read from the server now):\n${JSON.stringify(
    {
      project: b.project,
      forecastVersion: b.forecastVersion,
      approvedVersion: b.approvedVersion,
      closedThrough: b.closedThrough,
      monthRange: b.monthRange,
      milestones: b.milestones,
      promiseIrrByPartner: b.approved.partners,
      currentIrrByPartner: b.active.partners,
      currentExitMonth: b.active.exitMonth,
      lines: b.lines,
    },
    null,
    1,
  )}`;
}

export function explainSystemPrompt(): string {
  return `You explain forecast variants to a developer's CFO and financier, in Russian. A server computed every figure. You cite figures ONLY as placeholders {{key}} taken from the FACTS list; you never type a figure, percentage or amount yourself. Months may be written as dates (YYYY-MM) or words.

Write from the general to the specific: first the business answer, then per variant the decision, what it moves in time, and only then the figures.
- headline: one sentence. Does the promise to the partners hold, and what does the scenario cost? Use the v1 deltas: {{v1.d.netProfit}}, {{v1.d.irr.<partner>}}.
- variants: one entry per scored variant, in ranking order.
  - whatWeDo: the business decision in a developer's terms (prices, phasing, partner share). No figures.
  - whatShifts: what moves in time: sales and handovers, construction end, exit, the cash trough month. Use the SHIFTS given per variant.
  - result: the partners' IRR against the promise ({{vN.irr.<partner>}}, {{vN.gap.<partner>}}), the net profit change ({{vN.d.netProfit}}), the cash trough ({{vN.trough}}).
- whyRecommended: why the recommended variant, in 1-2 sentences.
- caveats: what the evaluation cannot see, for example bank terms and drawdown dates stay as stored, a price change on units already contracted.

v1 is the scenario alone, without levers: it shows what the scenario costs; the later variants show what each lever wins back.

The server ranks the variants. First come those that keep every partner at or above the promise, the one closest to the promise first; a variant below the promise ranks after all of them. A variant far above the promise is no better: it asks buyers or partners for more than the scenario costs. Recommend the top-ranked variant. If you recommend another one, write the reason in departureReason; otherwise departureReason is null.

OUTPUT: only one JSON object with the keys headline, variants [{id, whatWeDo, whatShifts, result}], whyRecommended, recommendation, departureReason, caveats.`;
}

export function explainUserPrompt(input: {
  scenario: string;
  facts: Record<string, string>;
  variants: Array<{
    id: string;
    title: string;
    status: string;
    levers: string[];
    errors: string[];
    rationale?: string;
    shifts?: Array<{ label: string; active: string | null; variant: string | null }>;
  }>;
  ranking: string[];
  topRanked: string;
}): string {
  return `USER'S SCENARIO:\n${input.scenario}\n\nTOP-RANKED VARIANT: ${input.topRanked}\n\nVARIANTS (ranked: at or above the promise and closest to it first: ${input.ranking.join(
    ' > ',
  )}):\n${JSON.stringify(input.variants, null, 1)}\n\nFACTS (key -> value; cite as {{key}}). Rows: approved = the promise, active = the current forecast before the scenario, v1..vN = variants:\n${Object.entries(
    input.facts,
  )
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n')}`;
}

// ---------- stage 5 (DEV-1375): router and structuring steps ----------

export function routeSystemPrompt(): string {
  return `You route one message of a forecast chat for a real-estate developer's CFO. Return only one JSON object {"kind": ..., "scope": [...]}.

KINDS:
- generate: the user states a new scenario that changes the forecast: a delay, a cost or price change, a funding change. It opens a new set of variants.
- goal_change: the user sets or changes a goal for variants that already exist: which partner covers the costs in which months, whose IRR to keep at the promise, a net profit target.
- question: the user asks about the variants; nothing is recalculated.

SCOPE: the ids of the drafts the message is about. [] means the card the user has selected. ["all"] when the message says all or every variant. A generate message has scope [].`;
}

export function routeUserPrompt(message: string, drafts: Array<{ id: string; title: string }>, selected: string | null): string {
  const list = drafts.length === 0 ? 'none yet' : drafts.map((d) => `${d.id}: ${d.title}`).join('\n');
  return `MESSAGE:\n${message}\n\nDRAFTS:\n${list}\n\nSELECTED CARD: ${selected ?? 'none'}`;
}

function openLineList(b: Baseline): string {
  return b.lines
    .filter((l) => Object.keys(l.openCells).length > 0 && !b.derivedLineCodes.includes(l.code))
    .map((l) => `${l.code} (group ${l.groupCode ?? '-'}): ${l.name}`)
    .join('\n');
}

export function scenarioSystemPrompt(b: Baseline): string {
  const first = addMonths(b.closedThrough, 1);
  const construction = b.lines
    .filter((l) => l.groupCode === 'D' && Object.keys(l.openCells).length > 0)
    .map((l) => l.code)
    .join(', ');
  return `You turn a user's forecast scenario into a structured change for a server. Return only one JSON object; every key is present.

- cost_change: the user states that costs on some plan lines change by a percentage from a month.
  - lineCodes: the lines the user names. «Стройка» (construction) means the open construction lines: ${construction || 'none'}.
  - fromMonth: the first month of the change, YYYY-MM. Months up to ${b.closedThrough} are closed; start at ${first} or later. If the user names no month, use ${first}.
  - factorPpm: 1000000 × (1 + percent / 100). +8 % is 1080000, −5 % is 950000.
- free: anything else (a delay, a sales change, a funding change). Then lineCodes is [] and fromMonth and factorPpm are null; another step builds the variants.

Never invent a percentage the user did not give.

LINES WITH OPEN CELLS:
${openLineList(b)}`;
}

export function goalSystemPrompt(b: Baseline): string {
  const first = addMonths(b.closedThrough, 1);
  const partners = (b.partners.length > 0 ? b.partners : b.approved.partners).map((p) => `${p.partnerId}: ${p.name}`).join('\n');
  const unit = 10 ** b.project.decimals;
  return `You turn a user's goal for forecast variants into a structured goal for a server. Return only one JSON object; every key is present, and keys the goal type does not use are null or [].

- funding_cover: one partner covers all of the project's cash need for N months. partnerId: the partner. fromMonth: the first month, ${first} or later («ближайшие» means from ${first}). months: N, 1..24.
- irr_floor: keep the IRR at or above the promise only for the partners named. partnerIds: those partners.
- net_profit_target: a net profit target. amountMinor: the amount in minor units as a decimal string (1 ${b.project.currencyCode} = ${unit} minor units). basis: "delta" when the user gives a change or a bare signed number such as «+10 000 000» (against the variant's current net profit); "absolute" when the user names the profit level itself («прибыль 400 млн»).

PARTNERS:
${partners}`;
}
