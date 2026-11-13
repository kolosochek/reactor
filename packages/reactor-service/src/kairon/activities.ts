// packages/reactor-service/src/kairon/activities.ts
//
// Reactor activities of the forecast prototype (DEV-1364; stage 5 adds the
// router and structuring steps of conversation.ts, DEV-1375). One chat turn is a
// batch plan of four calls: baseline (explicit) -> proposeVariants (LLM) ->
// scoreVariants (explicit, Kairon evaluate) -> explainVariants (LLM). A server
// refusal is returned as the variant's result, never thrown, because batch
// mode aborts the whole plan on the first throw.
//
// Stage 3: the LLM steps send a strict JSON schema built from the baseline,
// and every tool call and Kairon call is traced through ctx.onProgress.

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Activity, ActivityContext, LLMCompletionRequest } from '@kolosochek/reactor-core';
import { loadDocument, readBaseline, type Baseline } from './baseline.js';
import { checkPatch, type PatchRules } from './checks.js';
import type { KaironApi } from './client.js';
import { route, RouteInput, StructureGoalInput, structureGoal, StructureScenarioInput, structureScenario } from './conversation.js';
import { diffVariant, type VariantDiff } from './diff.js';
import {
  CUT_OFF_ERROR,
  explainJsonSchema,
  normalizeStrictAnswer,
  openMonths,
  parseJsonObject,
  proposalJsonSchema,
} from './llmSchemas.js';
import type { KaironLLMRequest } from './openrouter.js';
import { ForecastPatchSchema, type ForecastDocument } from './patch.js';
import {
  explainSystemPrompt,
  explainUserPrompt,
  proposeSystemPrompt,
  proposeUserPrompt,
} from './prompts.js';
import {
  buildFacts,
  diffFacts,
  literalNumbers,
  rankVariants,
  renderPlaceholders,
  summarizeEvaluation,
  type EvaluationMetrics,
} from './summary.js';
import { traceActivity, traceKaironApi } from './trace.js';

type LLMMessage = LLMCompletionRequest['messages'][number];

const MAX_PROPOSE_ATTEMPTS = 3;
const MAX_EXPLAIN_ATTEMPTS = 2;
/** Reasoning models spent 7 677 of 8 000 tokens thinking in the live run of 13.11 and cut the JSON off. */
const PROPOSE_MAX_TOKENS = 32_000;
/** The structured explanation runs about 1 500 tokens; reasoning models spend more before it. */
const EXPLAIN_MAX_TOKENS = 8_000;
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

function rulesOf(b: Baseline): PatchRules {
  return { closedThrough: b.closedThrough, derivedLineCodes: b.derivedLineCodes };
}

interface Judgement {
  errors: string[];
  accepted: Variant[];
  rejected: Array<{ id: string; title: string; errors: string[] }>;
  openQuestions: string[];
}

function judgeProposal(content: string, doc: ForecastDocument, rules: PatchRules): Judgement {
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
    const leversInV1 = variant.id === 'v1' && (variant.levers.length > 0 || variant.patch.shareTarget !== undefined);
    const errors = [
      ...(leversInV1 ? [V1_LEVERS_ERROR] : []),
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

const ProposeInput = z.object({
  scenario: z.string().min(1),
  baseline: BaselineArg,
  history: z.array(z.object({ user: z.string(), summary: z.string() })).default([]),
  count: z.number().int().min(1).max(4).default(3),
});

async function proposeVariants(api: KaironApi, raw: unknown, ctx: ActivityContext) {
  const input = ProposeInput.parse(raw);
  const b = input.baseline;
  const doc = await loadDocument(api, b.forecastVersion.id);
  const codes = b.lines.map((l) => l.code);
  const months = openMonths(b.closedThrough, b.monthRange.to, 24);
  const responseSchema = {
    name: 'forecast_variants',
    schema: proposalJsonSchema(codes, months),
    relaxedSchema: proposalJsonSchema(codes, months, { relaxed: true }),
  };
  const messages: LLMMessage[] = [
    { role: 'system', content: proposeSystemPrompt(b, input.count) },
    { role: 'user', content: proposeUserPrompt(input.scenario, b, input.history) },
  ];
  const attempts: Array<{ attempt: number; errors: string[] }> = [];
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
      : judgeProposal(resp.content, doc, rulesOf(b));
    attempts.push({ attempt, errors: last.errors });
    ctx.onProgress?.({ type: 'kairon.propose.attempt', payload: { attempt, errors: last.errors } });
    if (last.errors.length === 0) break;
    messages.push(
      { role: 'assistant', content: resp.content },
      {
        role: 'user',
        content: cutOff
          ? `Your answer was cut off at the token limit before the JSON closed. Return the whole JSON again with all ${input.count} variants; keep each rationale to 2 sentences.`
          : `The server would refuse parts of this answer. Fix every error below and return the whole JSON again with all ${input.count} variants:\n${last.errors.map((e) => `- ${e}`).join('\n')}`,
      },
    );
  }
  return { variants: last.accepted, rejected: last.rejected, openQuestions: last.openQuestions, attempts, model };
}

const ScoreInput = z.object({
  baseline: BaselineArg,
  proposals: z.object({ variants: z.array(VariantSchema) }),
});

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
  title: string;
  rationale: string;
  levers: string[];
  patch: Variant['patch'];
  status: 'ok' | 'refused' | 'invalid';
  httpStatus: number | null;
  errors: string[];
  adjustments: string[];
  metrics: EvaluationMetrics | null;
  /** What the variant changes against the active forecast; null unless Kairon scored it. */
  diff: VariantDiff | null;
}

async function scoreOne(
  api: KaironApi,
  b: Baseline,
  doc: ForecastDocument,
  activeEval: unknown,
  v: Variant,
): Promise<ScoredVariant> {
  const base = { id: v.id, title: v.title, rationale: v.rationale, levers: v.levers, patch: v.patch, diff: null };
  const check = checkPatch(doc, rulesOf(b), { ...v.patch, name: v.id });
  if (check.body === null) {
    return { ...base, status: 'invalid', httpStatus: null, errors: check.errors, adjustments: [], metrics: null };
  }
  const res = await api.evaluate(b.forecastVersion.id, check.body);
  if (res.status !== 200) {
    return {
      ...base,
      status: 'refused',
      httpStatus: res.status,
      errors: [refusalMessage(res.json)],
      adjustments: check.adjustments,
      metrics: null,
    };
  }
  return {
    ...base,
    status: 'ok',
    httpStatus: 200,
    errors: [],
    adjustments: check.adjustments,
    metrics: summarizeEvaluation(res.json),
    diff: diffVariant({
      currency: currencyOf(b),
      closedThrough: b.closedThrough,
      derivedLineCodes: b.derivedLineCodes,
      activePlan: doc.plan,
      variantPlan: check.body.plan,
      activeEval,
      variantEval: res.json,
    }),
  };
}

function currencyOf(b: Baseline) {
  return { decimals: b.project.decimals, currencyCode: b.project.currencyCode };
}

async function scoreVariants(api: KaironApi, raw: unknown) {
  const input = ScoreInput.parse(raw);
  const b = input.baseline;
  const doc = await loadDocument(api, b.forecastVersion.id);
  const activeRes = await api.evaluate(b.forecastVersion.id, {});
  if (activeRes.status !== 200) throw new Error(`Active forecast evaluate failed: ${activeRes.status}`);
  const variants = await Promise.all(input.proposals.variants.map((v) => scoreOne(api, b, doc, activeRes.json, v)));
  const ranking = rankVariants(
    b.approved.partners,
    variants.map((v) => ({ id: v.id, metrics: v.metrics })),
  );
  const rows = [
    { key: 'approved', metrics: b.approved },
    { key: 'active', metrics: b.active },
    ...variants.flatMap((v) => (v.metrics === null ? [] : [{ key: v.id, metrics: v.metrics }])),
  ];
  const facts = buildFacts(currencyOf(b), b.approved, rows);
  for (const v of variants) {
    if (v.metrics !== null && v.diff !== null) Object.assign(facts, diffFacts(currencyOf(b), v.id, b.active, v.metrics, v.diff));
  }
  return { variants, ranking, facts, approved: b.approved, active: b.active };
}

const ExplainInput = z.object({
  scenario: z.string(),
  scored: z.object({
    variants: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        rationale: z.string().default(''),
        levers: z.array(z.string()).default([]),
        errors: z.array(z.string()).default([]),
        diff: z
          .object({
            events: z.array(z.object({ label: z.string(), active: z.string().nullable(), variant: z.string().nullable() })),
          })
          .nullable()
          .default(null),
      }),
    ),
    ranking: z.array(z.string()),
    facts: z.record(z.string()),
  }),
});

const ExplainVariant = z.object({
  id: z.string(),
  whatWeDo: z.string().default(''),
  whatShifts: z.string().default(''),
  result: z.string().default(''),
});

const ExplainReply = z.object({
  headline: z.string().min(1),
  variants: z.array(ExplainVariant).default([]),
  whyRecommended: z.string().default(''),
  recommendation: z.string().default(''),
  departureReason: z.string().nullable().default(null),
  caveats: z.array(z.string()).default([]),
});

type ExplainAnswer = z.infer<typeof ExplainReply>;

/** null when the answer can stand: the recommendation is the top-ranked variant or carries a reason. */
function departureError(answer: ExplainAnswer, topRanked: string): string | null {
  if (answer.recommendation === topRanked || (answer.departureReason ?? '') !== '') return null;
  return `The recommendation ${answer.recommendation} departs from the top-ranked variant ${topRanked} without a reason. Recommend ${topRanked}, or keep ${answer.recommendation} and write the reason in departureReason. Return the whole JSON again.`;
}

async function explainVariants(raw: unknown, ctx: ActivityContext) {
  const input = ExplainInput.parse(raw);
  const { facts } = input.scored;
  const ids = input.scored.variants.filter((v) => v.status === 'ok').map((v) => v.id);
  const topRanked = input.scored.ranking.find((id) => ids.includes(id)) ?? '';
  if (ids.length === 0) {
    return {
      headline: 'Ни один вариант не посчитан сервером, объяснять нечего. Причины отказов в таблице и в трассировке.',
      variants: [],
      whyRecommended: '',
      caveats: [],
      recommendation: '',
      topRanked,
      departureReason: null,
      unknownPlaceholders: [],
      literalNumbers: [],
    };
  }
  const responseSchema = { name: 'variant_explanation', schema: explainJsonSchema(ids) };
  const messages: LLMMessage[] = [
    { role: 'system', content: explainSystemPrompt() },
    {
      role: 'user',
      content: explainUserPrompt({
        scenario: input.scenario,
        facts,
        variants: input.scored.variants.map((v) => ({
          id: v.id,
          title: v.title,
          status: v.status,
          rationale: v.rationale,
          levers: v.levers,
          errors: v.errors,
          shifts: v.diff?.events ?? [],
        })),
        ranking: input.scored.ranking,
        topRanked,
      }),
    },
  ];
  let reply: ExplainAnswer | null = null;
  let candidate: ExplainAnswer | null = null;
  let lastContent = '';
  for (let attempt = 1; attempt <= MAX_EXPLAIN_ATTEMPTS && reply === null; attempt++) {
    const request: KaironLLMRequest = {
      messages: [...messages],
      temperature: 0.3,
      maxTokens: EXPLAIN_MAX_TOKENS,
      jsonMode: true,
      responseSchema,
      label: `explainVariants, attempt ${attempt}`,
      signal: ctx.signal,
    };
    const resp = await ctx.llm.complete(request);
    lastContent = resp.content;
    let retry: string | null;
    try {
      candidate = ExplainReply.parse(normalizeStrictAnswer(parseJsonObject(resp.content)));
      retry = departureError(candidate, topRanked);
      if (retry === null) reply = candidate;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      retry = `Return only the JSON object with the keys headline, variants, whyRecommended, recommendation, departureReason, caveats. Error: ${message}`;
    }
    if (retry !== null) messages.push({ role: 'assistant', content: resp.content }, { role: 'user', content: retry });
  }
  const final = reply ??
    candidate ?? { headline: lastContent, variants: [], whyRecommended: '', recommendation: '', departureReason: null, caveats: [] };
  const eventMonths = input.scored.variants.flatMap((v) => (v.diff?.events ?? []).flatMap((e) => [e.active ?? '', e.variant ?? '']));
  const allowed = [input.scenario, ...Object.values(facts), ...eventMonths];
  const unknown: string[] = [];
  const literal: string[] = [];
  const render = (template: string): string => {
    const out = renderPlaceholders(template, facts);
    unknown.push(...out.unknown);
    literal.push(...literalNumbers(template, allowed));
    return out.text;
  };
  return {
    headline: render(final.headline),
    variants: final.variants.map((v) => ({
      id: v.id,
      whatWeDo: render(v.whatWeDo),
      whatShifts: render(v.whatShifts),
      result: render(v.result),
    })),
    whyRecommended: render(final.whyRecommended),
    caveats: final.caveats.map(render),
    recommendation: final.recommendation,
    topRanked,
    departureReason: final.departureReason === null ? null : render(final.departureReason),
    unknownPlaceholders: unknown,
    literalNumbers: literal,
  };
}

export type KaironToolName =
  | 'kairon.baseline'
  | 'kairon.route'
  | 'kairon.structureScenario'
  | 'kairon.structureGoal'
  | 'kairon.proposeVariants'
  | 'kairon.scoreVariants'
  | 'kairon.explainVariants';

/** Input JSON schemas of the four tools, shown in the trace and set on the Tool definitions. */
export const kaironToolInputSchemas: Record<KaironToolName, Record<string, unknown>> = {
  'kairon.baseline': { type: 'object', properties: {}, additionalProperties: true },
  'kairon.route': zodToJsonSchema(RouteInput) as Record<string, unknown>,
  'kairon.structureScenario': zodToJsonSchema(StructureScenarioInput) as Record<string, unknown>,
  'kairon.structureGoal': zodToJsonSchema(StructureGoalInput) as Record<string, unknown>,
  'kairon.proposeVariants': zodToJsonSchema(ProposeInput) as Record<string, unknown>,
  'kairon.scoreVariants': zodToJsonSchema(ScoreInput) as Record<string, unknown>,
  'kairon.explainVariants': zodToJsonSchema(ExplainInput) as Record<string, unknown>,
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
    'kairon.scoreVariants': traced('kairon.scoreVariants', 'explicit', async (input, ctx) =>
      scoreVariants(traceKaironApi(api, ctx.onProgress), input),
    ),
    'kairon.explainVariants': traced('kairon.explainVariants', 'latent', async (input, ctx) =>
      explainVariants(input, ctx),
    ),
  };
}
