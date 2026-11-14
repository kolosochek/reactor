// packages/reactor-service/src/kairon/activities.ts
//
// Reactor activities of the forecast prototype (DEV-1364; stage 5 adds the
// router and structuring steps of conversation.ts, DEV-1375). One chat turn is a
// batch plan of four calls: baseline (explicit) -> proposeVariants (LLM) ->
// scoreVariants (explicit, Kairon evaluate) -> explainVariants (LLM, explain.ts). A server
// refusal is returned as the variant's result, never thrown, because batch
// mode aborts the whole plan on the first throw.
//
// Stage 3: the LLM steps send a strict JSON schema built from the baseline,
// and every tool call and Kairon call is traced through ctx.onProgress.

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Activity, ActivityContext, LLMCompletionRequest } from '@kolosochek/reactor-core';
import { digestLines, loadDocument, readBaseline, type Baseline } from './baseline.js';
import { checkPatch, patchLineCodes, type PatchRules } from './checks.js';
import type { KaironApi } from './client.js';
import { route, RouteInput, StructureGoalInput, structureGoal, StructureScenarioInput, structureScenario } from './conversation.js';
import { diffVariant, REVENUE_GROUP_CODES, type VariantDiff } from './diff.js';
import { AnswerInput, answerQuestion, ExplainInput, explainVariants, PlanWidgetsInput, planWidgets } from './explain.js';
import { forecastDiffView, type DiffView } from './diffView.js';
import {
  CUT_OFF_ERROR,
  normalizeStrictAnswer,
  openMonths,
  parseJsonObject,
  proposalJsonSchema,
} from './llmSchemas.js';
import type { KaironLLMRequest } from './openrouter.js';
import {
  checkGoals,
  fundingCoverDraws,
  goalLabel,
  GoalSchema,
  rankGoalOf,
  type Goal,
  type GoalCheck,
  type RankGoal,
} from './goals.js';
import { childId, DraftLineageSchema, planHash, replayLineage, type DraftLineage } from './lineage.js';
import { applyPatch, ForecastPatchSchema, type EvaluateBody, type ForecastDocument } from './patch.js';
import { criteriaMatrix, rankDrafts, sameAsEarlier, switchesFor, type DraftScore } from './ranking.js';
import { reconcile, type Reconciliation } from './reconcile.js';
import { redLines, type RedLine } from './redLines.js';
import { changedPaths, widgetInputs, type PathChange, type WidgetInputs } from './widgets.js';
import { applyScenario, ScenarioSpecSchema, type ScenarioSpec } from './scenario.js';
import {
  proposeSystemPrompt,
  proposeUserPrompt,
  type LeverMode,
} from './prompts.js';
import {
  allocationFacts,
  buildFacts,
  diffFacts,
  formatMillions,
  summarizeEvaluation,
  type EvaluationMetrics,
} from './summary.js';
import { traceActivity, traceKaironApi } from './trace.js';

type LLMMessage = LLMCompletionRequest['messages'][number];

const MAX_PROPOSE_ATTEMPTS = 3;
/** Reasoning models spent 7 677 of 8 000 tokens thinking in the live run of 13.11 and cut the JSON off. */
const PROPOSE_MAX_TOKENS = 32_000;
/** The structured explanation runs about 1 500 tokens; reasoning models spend more before it. */
const V1_LEVERS_ERROR =
  'the first variant is the scenario alone; leave levers [] and shareTarget null, put levers into the later variants';

const VariantSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().default(''),
  levers: z.array(z.string()).default([]),
  patch: ForecastPatchSchema.omit({ name: true }),
});

type Variant = z.infer<typeof VariantSchema>;

const ProposalSchema = z.object({
  variants: z.array(VariantSchema).min(1),
  openQuestions: z.array(z.string()).default([]),
});

const BaselineArg = z.custom<Baseline>(
  (v) => typeof v === 'object' && v !== null && 'closedThrough' in v && 'forecastVersion' in v,
  'baseline must be the output of kairon.baseline',
);

export { parseJsonObject } from './llmSchemas.js';

export function rulesOf(b: Baseline): PatchRules {
  return { closedThrough: b.closedThrough, derivedLineCodes: b.derivedLineCodes };
}

interface Judgement {
  errors: string[];
  accepted: Variant[];
  rejected: Array<{ id: string; title: string; errors: string[] }>;
  openQuestions: string[];
}

/**
 * expectedIds: the ids the server asked for (lever mode); null in free mode,
 * where v1 must be the scenario alone.
 */
function judgeProposal(content: string, doc: ForecastDocument, rules: PatchRules, expectedIds: string[] | null): Judgement {
  let raw: unknown;
  try {
    raw = parseJsonObject(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { errors: [`reply: ${message}`], accepted: [], rejected: [], openQuestions: [] };
  }
  const parsed = ProposalSchema.safeParse(normalizeStrictAnswer(raw));
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `reply: ${i.path.join('.')}: ${i.message}`);
    return { errors, accepted: [], rejected: [], openQuestions: [] };
  }
  const judgement: Judgement = { errors: [], accepted: [], rejected: [], openQuestions: parsed.data.openQuestions };
  for (const variant of parsed.data.variants) {
    const leversInV1 =
      expectedIds === null && variant.id === 'v1' && (variant.levers.length > 0 || variant.patch.shareTarget !== undefined);
    const unexpected = expectedIds !== null && !expectedIds.includes(variant.id);
    const errors = [
      ...(leversInV1 ? [V1_LEVERS_ERROR] : []),
      ...(unexpected ? [`id ${variant.id} was not asked for; use ${expectedIds.join(', ')}`] : []),
      ...checkPatch(doc, rules, { ...variant.patch, name: variant.id }).errors,
    ];
    if (errors.length === 0) {
      judgement.accepted.push(variant);
    } else {
      judgement.rejected.push({ id: variant.id, title: variant.title, errors });
      judgement.errors.push(...errors.map((e) => `${variant.id}: ${e}`));
    }
  }
  return judgement;
}

const HistoryArg = z.array(z.object({ user: z.string(), summary: z.string() })).default([]);

const ProposeInput = z.object({
  scenario: z.string().min(1),
  baseline: BaselineArg,
  history: HistoryArg,
  count: z.number().int().min(1).max(4).default(3),
  scenarioSpec: ScenarioSpecSchema.default({ type: 'free' }),
  section: z.string().default('S1'),
  /** structureScenario's errors in the same batch: non-empty means the phrase was not structured, so nothing is asked. */
  scenarioErrors: z.array(z.string()).default([]),
});

interface LeverAsk {
  b: Baseline;
  doc: ForecastDocument;
  scenario: string;
  history: Array<{ user: string; summary: string }>;
  /** Free mode (stage 4) builds `count` variants with v1 = the scenario alone; lever mode builds `levers.ids`. */
  count: number;
  levers?: LeverMode;
}

interface LeverAnswer {
  accepted: Variant[];
  rejected: Judgement['rejected'];
  openQuestions: string[];
  attempts: Array<{ attempt: number; errors: string[] }>;
  model: string;
}

/** The propose loop: strict schema, server checks on `doc`, up to 3 attempts with the errors fed back. */
async function askVariants(ctx: ActivityContext, ask: LeverAsk): Promise<LeverAnswer> {
  const { b, doc } = ask;
  const view: Baseline = { ...b, lines: digestLines(doc.plan, b.closedThrough) };
  const count = ask.levers?.ids.length ?? ask.count;
  const codes = b.lines.map((l) => l.code);
  const months = openMonths(b.closedThrough, b.monthRange.to, 24);
  const responseSchema = {
    name: 'forecast_variants',
    schema: proposalJsonSchema(codes, months),
    relaxedSchema: proposalJsonSchema(codes, months, { relaxed: true }),
  };
  const messages: LLMMessage[] = [
    { role: 'system', content: proposeSystemPrompt(b, count, ask.levers) },
    { role: 'user', content: proposeUserPrompt(ask.scenario, view, ask.history) },
  ];
  const attempts: LeverAnswer['attempts'] = [];
  let last: Judgement = { errors: [], accepted: [], rejected: [], openQuestions: [] };
  let model = '';
  for (let attempt = 1; attempt <= MAX_PROPOSE_ATTEMPTS; attempt++) {
    const request: KaironLLMRequest = {
      messages: [...messages],
      temperature: 0.2,
      maxTokens: PROPOSE_MAX_TOKENS,
      jsonMode: true,
      responseSchema,
      label: `proposeVariants, attempt ${attempt}`,
      signal: ctx.signal,
    };
    const resp = await ctx.llm.complete(request);
    model = resp.model;
    const cutOff = resp.finishReason === 'length';
    last = cutOff
      ? { errors: [CUT_OFF_ERROR], accepted: [], rejected: [], openQuestions: [] }
      : judgeProposal(resp.content, doc, rulesOf(b), ask.levers?.ids ?? null);
    attempts.push({ attempt, errors: last.errors });
    ctx.onProgress?.({ type: 'kairon.propose.attempt', payload: { attempt, errors: last.errors } });
    if (last.errors.length === 0) break;
    messages.push(
      { role: 'assistant', content: resp.content },
      {
        role: 'user',
        content: cutOff
          ? `Your answer was cut off at the token limit before the JSON closed. Return the whole JSON again with all ${count} variants; keep each rationale to 2 sentences.`
          : `The server would refuse parts of this answer. Fix every error below and return the whole JSON again with all ${count} variants:\n${last.errors.map((e) => `- ${e}`).join('\n')}`,
      },
    );
  }
  return { accepted: last.accepted, rejected: last.rejected, openQuestions: last.openQuestions, attempts, model };
}

/** A proposed draft: what the page keeps in its section and sends back for scoring, goals and the save. */
export interface DraftVariant {
  id: string;
  parentId: string | null;
  title: string;
  rationale: string;
  levers: string[];
  /** The lever patch of this step ({} for a server-built draft); kept for the stage 4 scoring. */
  patch: Variant['patch'];
  lineage: DraftLineage;
}

function appliedText(spec: ScenarioSpec): string {
  if (spec.type === 'free') return 'nothing';
  const percent = (spec.factorPpm - 1_000_000) / 10_000;
  return `the user's stated change: lines ${spec.lineCodes.join(', ')} ${percent >= 0 ? '+' : ''}${percent} % from ${spec.fromMonth}`;
}

async function proposeVariants(api: KaironApi, raw: unknown, ctx: ActivityContext) {
  const input = ProposeInput.parse(raw);
  if (input.scenarioErrors.length > 0) {
    return { section: input.section, variants: [], rejected: [], openQuestions: [], attempts: [], model: '', errors: input.scenarioErrors };
  }
  const b = input.baseline;
  const doc = await loadDocument(api, b.forecastVersion.id);
  const activePlanHash = planHash(doc);
  const spec = input.scenarioSpec;
  const lineageOf = (leverPatch: DraftLineage['leverPatch']): DraftLineage => ({ activePlanHash, scenario: spec, leverPatch, steps: [] });
  const draft = (v: Variant): DraftVariant => ({
    id: v.id,
    parentId: null,
    title: v.title,
    rationale: v.rationale,
    levers: v.levers,
    patch: v.patch,
    lineage: lineageOf({ ...v.patch, name: v.id }),
  });
  if (spec.type === 'free') {
    const out = await askVariants(ctx, { b, doc, scenario: input.scenario, history: input.history, count: input.count });
    return { section: input.section, variants: out.accepted.map(draft), rejected: out.rejected, openQuestions: out.openQuestions, attempts: out.attempts, model: out.model, errors: [] };
  }
  const scenario = applyScenario(doc, rulesOf(b), spec);
  if (scenario.errors.length > 0) {
    return { section: input.section, variants: [], rejected: [{ id: 'v1', title: input.scenario, errors: scenario.errors }], openQuestions: [], attempts: [], model: '', errors: [] };
  }
  const v1: DraftVariant = {
    id: 'v1',
    parentId: null,
    title: input.scenario,
    rationale: 'Только заявленное изменение, без рычагов: показывает цену сценария.',
    levers: [],
    patch: {},
    lineage: lineageOf(null),
  };
  const ids = Array.from({ length: input.count - 1 }, (_, i) => `v${i + 2}`);
  if (ids.length === 0) {
    return { section: input.section, variants: [v1], rejected: [], openQuestions: [], attempts: [], model: '', errors: [] };
  }
  const out = await askVariants(ctx, {
    b,
    doc: scenario.doc,
    scenario: input.scenario,
    history: input.history,
    count: ids.length,
    levers: { ids, applied: appliedText(spec), goal: null },
  });
  return {
    section: input.section,
    variants: [v1, ...out.accepted.map(draft)],
    rejected: out.rejected,
    openQuestions: out.openQuestions,
    attempts: out.attempts,
    model: out.model,
    errors: [],
  };
}

const GoalDraftsInput = z.object({
  baseline: BaselineArg,
  goal: GoalSchema,
  parents: z.array(z.object({ id: z.string().min(1), lineage: DraftLineageSchema })).min(1),
  existingIds: z.array(z.string()).default([]),
  message: z.string().default(''),
  history: HistoryArg,
});

function goalText(goal: Goal, b: Baseline, parentNetProfitMinor: string): string {
  const name = (id: string) => partnersOf(b).find((p) => p.partnerId === id)?.name ?? id;
  if (goal.type === 'irr_floor') {
    return `the IRR of ${goal.partnerIds.map(name).join(', ')} at or above the approved budget (the promise) and as close to it as possible; the other partners do not matter.`;
  }
  if (goal.type === 'net_profit_target') {
    return `${goalLabel(goal, name, currencyOf(b), parentNetProfitMinor)}: net profit at or above this target and as close to it as possible.`;
  }
  return goalLabel(goal, name, currencyOf(b), parentNetProfitMinor);
}

function partnersOf(b: Baseline): Array<{ partnerId: string; name: string }> {
  return b.partners.length > 0 ? b.partners : b.approved.partners;
}

async function buildGoalDrafts(api: KaironApi, raw: unknown, ctx: ActivityContext) {
  const input = GoalDraftsInput.parse(raw);
  const { baseline: b, goal } = input;
  const doc = await loadDocument(api, b.forecastVersion.id);
  const rules = rulesOf(b);
  const name = (id: string) => partnersOf(b).find((p) => p.partnerId === id)?.name ?? id;
  const variants: DraftVariant[] = [];
  const answers: Array<{ parentId: string; text: string }> = [];
  const rejected: Judgement['rejected'] = [];
  const attempts: LeverAnswer['attempts'] = [];
  const taken = [...input.existingIds];
  let model = '';
  for (const parent of input.parents) {
    const replay = replayLineage(doc, rules, parent.lineage);
    if (replay.body === null) {
      rejected.push({ id: parent.id, title: parent.id, errors: replay.errors });
      continue;
    }
    const res = await api.evaluate(b.forecastVersion.id, replay.body);
    if (res.status !== 200) {
      rejected.push({ id: parent.id, title: parent.id, errors: [refusalMessage(res.json)] });
      continue;
    }
    const parentNet = summarizeEvaluation(res.json).netProfitMinor;
    const id = childId(parent.id, taken);
    if (goal.type === 'funding_cover') {
      const title = goalLabel(goal, name, currencyOf(b), parentNet);
      const cover = fundingCoverDraws(goal, res.json, { closedThrough: b.closedThrough, planEnd: b.monthRange.to });
      if (cover.errors.length > 0) {
        rejected.push({ id, title, errors: cover.errors });
        continue;
      }
      taken.push(id);
      variants.push({
        id,
        parentId: parent.id,
        title,
        rationale: '',
        levers: [],
        patch: {},
        lineage: { ...parent.lineage, steps: [...parent.lineage.steps, { type: 'cover', goal, draws: cover.draws }] },
      });
      continue;
    }
    const [met] = checkGoals([goal], {
      approved: b.approved,
      parentEval: res.json,
      draftEval: res.json,
      parentNetProfitMinor: parentNet,
      currency: currencyOf(b),
    });
    if (met?.draft === 'ok') {
      answers.push({ parentId: parent.id, text: `Цель уже выполнена в ${parent.id}` });
      continue;
    }
    const out = await askVariants(ctx, {
      b,
      doc: { ...doc, plan: replay.body.plan },
      scenario: input.message === '' ? goalLabel(goal, name, currencyOf(b), parentNet) : input.message,
      history: input.history,
      count: 1,
      levers: { ids: [id], applied: `the draft ${parent.id} (its scenario, levers and goals)`, goal: goalText(goal, b, parentNet) },
    });
    model = out.model;
    attempts.push(...out.attempts);
    rejected.push(...out.rejected);
    if (out.accepted.length === 0) answers.push({ parentId: parent.id, text: noDraftText(parent.id) });
    for (const v of out.accepted) {
      taken.push(v.id);
      variants.push({
        id: v.id,
        parentId: parent.id,
        title: v.title,
        rationale: v.rationale,
        levers: v.levers,
        patch: v.patch,
        lineage: { ...parent.lineage, steps: [...parent.lineage.steps, { type: 'levers', goal, patch: { ...v.patch, name: v.id } }] },
      });
    }
  }
  return { variants, answers, rejected, attempts, model };
}

const ScoredDraftArg = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable().default(null),
  title: z.string().min(1),
  rationale: z.string().default(''),
  levers: z.array(z.string()).default([]),
  /** Stage 4 proposals carry only the patch; their lineage is the patch on the active forecast. */
  patch: ForecastPatchSchema.omit({ name: true }).default({}),
  lineage: DraftLineageSchema.optional(),
});

const ScoreInput = z.object({
  baseline: BaselineArg,
  proposals: z.object({
    variants: z.array(ScoredDraftArg),
    answers: z.array(z.object({ parentId: z.string(), text: z.string() })).default([]),
  }),
  parents: z.array(z.object({ id: z.string().min(1), lineage: DraftLineageSchema })).default([]),
  // The page sends the section goals plus the new one last; a new goal replaces the section goal of its type.
  goals: z.array(GoalSchema).default([]).transform(lastGoalPerType),
});

/** One goal per type, the last one given. */
function lastGoalPerType<G extends { type: string }>(goals: G[]): G[] {
  return goals.filter((g, i) => !goals.slice(i + 1).some((later) => later.type === g.type));
}

function refusalMessage(json: unknown): string {
  if (typeof json === 'object' && json !== null) {
    const message = (json as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }
  return JSON.stringify(json).slice(0, 300);
}

export interface ScoredVariant {
  id: string;
  parentId: string | null;
  title: string;
  rationale: string;
  levers: string[];
  patch: Variant['patch'];
  lineage: DraftLineage;
  status: 'ok' | 'refused' | 'invalid';
  httpStatus: number | null;
  errors: string[];
  adjustments: string[];
  metrics: EvaluationMetrics | null;
  /** What the variant changes against its parent; null unless Kairon scored it. */
  diff: VariantDiff | null;
  redLines: RedLine[];
  reconciliations: Reconciliation[];
  goalChecks: GoalCheck[];
  changed: PathChange[];
  diffView: DiffView | null;
  /** What w1 and w2 read from the parent's and the draft's evaluation; null unless Kairon scored it. */
  widgetInputs: { parent: WidgetInputs; draft: WidgetInputs } | null;
  /** Server-side scoring inputs the ranking reads. */
  touchesReserve: boolean;
  reserveLeftMinor: string;
}

/** A draft's parent as the scoring compares against it: the active forecast or a replayed parent draft. */
interface ParentSide {
  key: string;
  body: EvaluateBody;
  eval: unknown;
  metrics: EvaluationMetrics;
}

function currencyOf(b: Baseline) {
  return { decimals: b.project.decimals, currencyCode: b.project.currencyCode };
}

const RESERVE_GROUP = 'U';

function reserveOf(body: EvaluateBody, active: ForecastDocument, closedThrough: string): { touches: boolean; leftMinor: string } {
  const before = new Map(active.plan.lines.map((l) => [l.code, l.monthlyForecast]));
  let touches = false;
  let left = 0n;
  for (const line of body.plan.lines) {
    if (line.groupCode !== RESERVE_GROUP) continue;
    const old = before.get(line.code) ?? {};
    const months = new Set([...Object.keys(old), ...Object.keys(line.monthlyForecast)]);
    for (const m of months) if (BigInt(old[m] ?? '0') !== BigInt(line.monthlyForecast[m] ?? '0')) touches = true;
    for (const [m, v] of Object.entries(line.monthlyForecast)) {
      if (m > closedThrough) left += BigInt(v) < 0n ? -BigInt(v) : BigInt(v);
    }
  }
  return { touches, leftMinor: String(left) };
}

/** What the request named for this draft: the scenario's and levers' lines, the cover's sources. */
function askedOf(lineage: DraftLineage, isChild: boolean): { lines: string[]; sources: string[] } {
  const last = lineage.steps.at(-1);
  if (isChild && last !== undefined) {
    return last.type === 'cover'
      ? { lines: [], sources: [...new Set(last.draws.map((d) => d.sourceId))] }
      : { lines: patchLineCodes(last.patch), sources: [] };
  }
  const scenarioLines = lineage.scenario.type === 'cost_change' ? lineage.scenario.lineCodes : [];
  const leverLines = lineage.leverPatch === null ? [] : patchLineCodes(lineage.leverPatch);
  return { lines: [...new Set([...scenarioLines, ...leverLines])], sources: [] };
}

const RULE_RED_LINES = 'Красные линии отсекают варианты: отсекает только нарушение, которое добавил сам вариант.';
const RULE_LEVERS = 'При равенстве выигрывает вариант с меньшим числом рычагов.';
const UNREACHABLE = 'Цель недостижима рычагами в пределах ±3 %:';
/** The answer for a draft that misses the goal it was built for; `id` is ranked, so the page shows it. */
const closestText = (id: string) => `${UNREACHABLE} ближе всего ${id}`;
/** The answer for a parent whose every lever the server refused: there is no draft to show. */
const noDraftText = (parentId: string) => `${UNREACHABLE} черновик для ${parentId} не построен`;

function goalRule(goal: RankGoal, b: Baseline): string {
  if (goal.type === 'net_profit_target') {
    return `Чистая прибыль не ниже ${formatMillions(goal.targetMinor, b.project.decimals, b.project.currencyCode)} и как можно ближе к ней.`;
  }
  if (goal.type === 'promise' && goal.partnerIds !== null) {
    const names = goal.partnerIds.map((id) => partnersOf(b).find((p) => p.partnerId === id)?.name ?? id);
    return `IRR не ниже обещания только для: ${names.join(', ')}.`;
  }
  return 'Цель запроса не названа, поэтому цель по умолчанию: IRR каждого партнёра не ниже обещания и как можно ближе к нему.';
}

async function scoreVariants(api: KaironApi, raw: unknown) {
  const input = ScoreInput.parse(raw);
  const b = input.baseline;
  const currency = currencyOf(b);
  const rules = rulesOf(b);
  const doc = await loadDocument(api, b.forecastVersion.id);
  const activePlanHash = planHash(doc);
  const activeRes = await api.evaluate(b.forecastVersion.id, {});
  if (activeRes.status !== 200) throw new Error(`Active forecast evaluate failed: ${activeRes.status}`);
  const activeSide: ParentSide = {
    key: 'active',
    body: applyPatch(doc, { name: 'active' }),
    eval: activeRes.json,
    metrics: summarizeEvaluation(activeRes.json),
  };
  const parents = new Map<string, ParentSide>();
  for (const parent of input.parents) {
    const replay = replayLineage(doc, rules, parent.lineage);
    if (replay.body === null) continue;
    const res = await api.evaluate(b.forecastVersion.id, replay.body);
    if (res.status === 200) parents.set(parent.id, { key: parent.id, body: replay.body, eval: res.json, metrics: summarizeEvaluation(res.json) });
  }
  const irrPartnerIds = input.goals.filter((g) => g.type === 'irr_floor').at(-1)?.partnerIds ?? null;

  const scoreOne = async (v: z.infer<typeof ScoredDraftArg>): Promise<ScoredVariant> => {
    const lineage: DraftLineage = v.lineage ?? {
      activePlanHash,
      scenario: { type: 'free' },
      leverPatch: { ...v.patch, name: v.id },
      steps: [],
    };
    const base = {
      id: v.id,
      parentId: v.parentId,
      title: v.title,
      rationale: v.rationale,
      levers: v.levers,
      patch: v.patch,
      lineage,
      diff: null,
      redLines: [],
      reconciliations: [],
      goalChecks: [],
      changed: [],
      diffView: null,
      widgetInputs: null,
      touchesReserve: false,
      reserveLeftMinor: '0',
    };
    const parent = v.parentId === null ? activeSide : parents.get(v.parentId);
    if (parent === undefined) {
      return { ...base, status: 'invalid', httpStatus: null, errors: [`parent ${v.parentId ?? ''} could not be scored`], adjustments: [], metrics: null };
    }
    const replay = replayLineage(doc, rules, lineage);
    if (replay.body === null) {
      return { ...base, status: 'invalid', httpStatus: null, errors: replay.errors, adjustments: [], metrics: null };
    }
    const body = replay.body;
    const adjustments = lineage.leverPatch === null ? [] : checkPatch(applyScenario(doc, rules, lineage.scenario).doc, rules, lineage.leverPatch).adjustments;
    const res = await api.evaluate(b.forecastVersion.id, body);
    if (res.status !== 200) {
      return { ...base, status: 'refused', httpStatus: res.status, errors: [refusalMessage(res.json)], adjustments, metrics: null };
    }
    const diff = diffVariant({
      currency,
      closedThrough: b.closedThrough,
      derivedLineCodes: b.derivedLineCodes,
      activePlan: parent.body.plan,
      variantPlan: body.plan,
      activeEval: parent.eval,
      variantEval: res.json,
    });
    const asked = askedOf(lineage, v.parentId !== null);
    const reserve = reserveOf(body, doc, b.closedThrough);
    return {
      ...base,
      status: 'ok',
      httpStatus: 200,
      errors: [],
      adjustments,
      metrics: summarizeEvaluation(res.json),
      diff,
      redLines: redLines({ approved: b.approved, partners: b.partners, irrPartnerIds, parentEval: parent.eval, draftEval: res.json, currency }),
      reconciliations: reconcile({
        parentBody: parent.body,
        draftBody: body,
        draftEval: res.json,
        diff,
        askedLineCodes: asked.lines,
        askedDrawSourceIds: asked.sources,
        currency,
      }),
      goalChecks: checkGoals(input.goals, {
        approved: b.approved,
        parentEval: parent.eval,
        draftEval: res.json,
        parentNetProfitMinor: parent.metrics.netProfitMinor,
        currency,
      }),
      changed: changedPaths({ parentBody: parent.body, draftBody: body, parentEval: parent.eval, draftEval: res.json, diff }),
      diffView: forecastDiffView({
        parentPlan: parent.body.plan,
        draftPlan: body.plan,
        approvedPlan: b.approvedPlan,
        parentEval: parent.eval,
        draftEval: res.json,
        diff,
        revenueGroups: REVENUE_GROUP_CODES,
      }),
      widgetInputs: { parent: widgetInputs(parent.eval), draft: widgetInputs(res.json) },
      touchesReserve: reserve.touches,
      reserveLeftMinor: reserve.leftMinor,
    };
  };

  const variants = await Promise.all(input.proposals.variants.map(scoreOne));
  const parentOf = (v: ScoredVariant) => (v.parentId === null ? activeSide : parents.get(v.parentId) ?? activeSide);
  const okVariants = variants.filter((v): v is ScoredVariant & { metrics: EvaluationMetrics } => v.metrics !== null);

  const dropped: Array<{ id: string; sameAs: string }> = [];
  for (const parentKey of new Set(okVariants.map((v) => v.parentId))) {
    const group = okVariants.filter((v) => v.parentId === parentKey);
    const first = group[0];
    if (first === undefined) continue;
    dropped.push(...sameAsEarlier(group.map((v) => ({ id: v.id, metrics: v.metrics })), parentOf(first).metrics));
  }
  const droppedIds = new Set(dropped.map((d) => d.id));
  const scores: DraftScore[] = okVariants
    .filter((v) => !droppedIds.has(v.id))
    .map((v) => ({
      id: v.id,
      metrics: v.metrics,
      parentMetrics: parentOf(v).metrics,
      leverCount: v.levers.length,
      touchesReserve: v.touchesReserve,
      reserveLeftMinor: v.reserveLeftMinor,
      addedBreaches: v.redLines.filter((l) => l.status === 'breach' && l.baseStatus !== 'breach').length,
      goalsMet: v.goalChecks.every((c) => c.draft === 'ok'),
    }));
  const firstParent = input.parents[0];
  const rankBase = (firstParent === undefined ? undefined : parents.get(firstParent.id)) ?? activeSide;
  const rankGoal = rankGoalOf(input.goals, rankBase.metrics.netProfitMinor);
  const ranked = rankDrafts(scores, b.approved, rankGoal);
  const ranking = [...ranked.ranking, ...variants.filter((v) => v.metrics === null).map((v) => v.id)];
  const redLinesById = Object.fromEntries(okVariants.map((v) => [v.id, v.redLines]));

  const answers = [...input.proposals.answers];
  // A draft dropped as a twin of its parent or of an earlier draft is not ranked, so it is never named as the closest.
  for (const v of okVariants.filter((x) => !droppedIds.has(x.id))) {
    const last = v.lineage.steps.at(-1);
    if (v.parentId === null || last === undefined || last.type !== 'levers') continue;
    const check = v.goalChecks.find((c) => c.goal === last.goal || JSON.stringify(c.goal) === JSON.stringify(last.goal));
    if (check !== undefined && check.draft !== 'ok') answers.push({ parentId: v.parentId, text: closestText(v.id) });
  }

  const rows = [
    { key: 'approved', metrics: b.approved },
    { key: 'active', metrics: b.active },
    ...[...parents.values()].map((p) => ({ key: p.key, metrics: p.metrics })),
    ...okVariants.map((v) => ({ key: v.id, metrics: v.metrics })),
  ];
  const facts = buildFacts(currency, b.approved, rows);
  for (const v of okVariants) {
    const parent = parentOf(v);
    if (v.diff !== null) Object.assign(facts, diffFacts(currency, v.id, parent.metrics, v.metrics, v.diff, parent.key));
    Object.assign(facts, allocationFacts(currency, v.id, parent.metrics, v.metrics));
    const parity = v.redLines.find((l) => l.key === 'parity');
    if (parity !== undefined) facts[`${v.id}.parity`] = parity.text;
  }
  return {
    variants,
    ranking,
    notRecommendable: ranked.notRecommendable,
    dropped,
    switches: switchesFor(scores, b.approved),
    matrix: criteriaMatrix(scores, b.approved, redLinesById, currency, rankGoal),
    rules: [RULE_RED_LINES, goalRule(rankGoal, b), RULE_LEVERS],
    answers,
    facts,
    approved: b.approved,
    active: b.active,
  };
}

export type KaironToolName =
  | 'kairon.baseline'
  | 'kairon.route'
  | 'kairon.structureScenario'
  | 'kairon.structureGoal'
  | 'kairon.proposeVariants'
  | 'kairon.buildGoalDrafts'
  | 'kairon.scoreVariants'
  | 'kairon.planWidgets'
  | 'kairon.explainVariants'
  | 'kairon.answerQuestion';

/** Input JSON schemas of the four tools, shown in the trace and set on the Tool definitions. */
export const kaironToolInputSchemas: Record<KaironToolName, Record<string, unknown>> = {
  'kairon.baseline': { type: 'object', properties: {}, additionalProperties: true },
  'kairon.route': zodToJsonSchema(RouteInput) as Record<string, unknown>,
  'kairon.structureScenario': zodToJsonSchema(StructureScenarioInput) as Record<string, unknown>,
  'kairon.structureGoal': zodToJsonSchema(StructureGoalInput) as Record<string, unknown>,
  'kairon.proposeVariants': zodToJsonSchema(ProposeInput) as Record<string, unknown>,
  'kairon.buildGoalDrafts': zodToJsonSchema(GoalDraftsInput) as Record<string, unknown>,
  'kairon.scoreVariants': zodToJsonSchema(ScoreInput) as Record<string, unknown>,
  'kairon.planWidgets': zodToJsonSchema(PlanWidgetsInput) as Record<string, unknown>,
  'kairon.explainVariants': zodToJsonSchema(ExplainInput) as Record<string, unknown>,
  'kairon.answerQuestion': zodToJsonSchema(AnswerInput) as Record<string, unknown>,
};

export function createKaironActivities(api: KaironApi): Record<KaironToolName, Activity> {
  const traced = (name: KaironToolName, kind: 'explicit' | 'latent', activity: Activity): Activity =>
    traceActivity(name, kind, kaironToolInputSchemas[name], activity);
  return {
    'kairon.baseline': traced('kairon.baseline', 'explicit', async (_input, ctx) =>
      readBaseline(traceKaironApi(api, ctx.onProgress)),
    ),
    'kairon.route': traced('kairon.route', 'latent', async (input, ctx) => route(input, ctx)),
    'kairon.structureScenario': traced('kairon.structureScenario', 'latent', async (input, ctx) =>
      structureScenario(traceKaironApi(api, ctx.onProgress), input, ctx),
    ),
    'kairon.structureGoal': traced('kairon.structureGoal', 'latent', async (input, ctx) => structureGoal(input, ctx)),
    'kairon.proposeVariants': traced('kairon.proposeVariants', 'latent', async (input, ctx) =>
      proposeVariants(traceKaironApi(api, ctx.onProgress), input, ctx),
    ),
    'kairon.buildGoalDrafts': traced('kairon.buildGoalDrafts', 'latent', async (input, ctx) =>
      buildGoalDrafts(traceKaironApi(api, ctx.onProgress), input, ctx),
    ),
    'kairon.scoreVariants': traced('kairon.scoreVariants', 'explicit', async (input, ctx) =>
      scoreVariants(traceKaironApi(api, ctx.onProgress), input),
    ),
    'kairon.planWidgets': traced('kairon.planWidgets', 'latent', async (input, ctx) => planWidgets(input, ctx)),
    'kairon.explainVariants': traced('kairon.explainVariants', 'latent', async (input, ctx) => explainVariants(input, ctx)),
    'kairon.answerQuestion': traced('kairon.answerQuestion', 'latent', async (input, ctx) => answerQuestion(input, ctx)),
  };
}
