// packages/reactor-service/src/kairon/explain.ts
//
// The LLM steps after scoring (DEV-1364 stage 4, DEV-1375 stage 5):
// - planWidgets: one call per batch picks declarative widget specs per draft;
//   the server keeps the mandatory matrix-diff and falls back to the defaults;
// - explainVariants: the recommendation overview, from the business answer
//   down to the figures, plus the verdict, gives, costs and stakeholders per
//   draft and why the other drafts rank lower; the server rules, switches,
//   criteria matrix and dropped twins are copied from the scoring;
// - answerQuestion: an answer to a question about the drafts.
// The LLM writes words and {{key}} placeholders; the server fills every figure
// and lists the numbers the LLM typed itself.

import { z } from 'zod';
import type { ActivityContext, LLMCompletionRequest } from '@kolosochek/reactor-core';
import { askStructured, zodErrors } from './conversation.js';
import { answerJsonSchema, explainJsonSchema, normalizeStrictAnswer, parseJsonObject, widgetsJsonSchema } from './llmSchemas.js';
import type { KaironLLMRequest } from './openrouter.js';
import {
  answerSystemPrompt,
  answerUserPrompt,
  explainSystemPrompt,
  explainUserPrompt,
  widgetsSystemPrompt,
  widgetsUserPrompt,
} from './prompts.js';
import { SWITCH_GOALS } from './ranking.js';
import { literalNumbers, renderPlaceholders } from './summary.js';
import { defaultWidgets, WidgetSpecSchema, withMandatory, type ChangedPath, type WidgetSpec } from './widgets.js';

type LLMMessage = LLMCompletionRequest['messages'][number];

const MAX_EXPLAIN_ATTEMPTS = 2;
const EXPLAIN_MAX_TOKENS = 8_000;

// ---------- planWidgets ----------

const PathChangeArg = z.object({ path: z.string(), cells: z.number() });

export const PlanWidgetsInput = z.object({
  scored: z.object({
    variants: z.array(z.object({ id: z.string(), status: z.string(), changed: z.array(PathChangeArg).default([]) })),
  }),
});

const WidgetsReply = z.object({
  widgets: z.array(z.object({ id: z.string(), specs: z.array(WidgetSpecSchema).default([]) })).default([]),
});

export async function planWidgets(raw: unknown, ctx: ActivityContext): Promise<{ widgets: Record<string, WidgetSpec[]> }> {
  const input = PlanWidgetsInput.parse(raw);
  const ok = input.scored.variants
    .filter((v) => v.status === 'ok')
    .map((v) => ({ id: v.id, changed: v.changed.map((c) => ({ path: c.path as ChangedPath, cells: c.cells })) }));
  if (ok.length === 0) return { widgets: {} };
  const ids = ok.map((v) => v.id);
  const schema = widgetsJsonSchema(ids);
  const answer = await askStructured<z.infer<typeof WidgetsReply>>(ctx, {
    system: widgetsSystemPrompt(),
    user: widgetsUserPrompt(ok),
    schemaName: 'draft_widgets',
    schema,
    relaxedSchema: schema,
    label: 'planWidgets',
    check: (normalized) => {
      const parsed = WidgetsReply.safeParse(normalized);
      return parsed.success ? { value: parsed.data, errors: [] } : { value: null, errors: zodErrors(parsed.error) };
    },
  });
  const chosen = new Map((answer.value?.widgets ?? []).map((w) => [w.id, w.specs]));
  const widgets: Record<string, WidgetSpec[]> = {};
  for (const v of ok) widgets[v.id] = withMandatory(chosen.get(v.id) ?? defaultWidgets(v.changed), v.changed);
  return { widgets };
}

// ---------- explainVariants ----------

export const ExplainInput = z.object({
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
        redLines: z.array(z.object({ label: z.string(), status: z.string(), text: z.string() })).default([]),
        goalChecks: z.array(z.object({ label: z.string(), parent: z.string(), draft: z.string() })).default([]),
        reconciliations: z.array(z.object({ key: z.string(), ok: z.boolean(), text: z.string() })).default([]),
      }),
    ),
    ranking: z.array(z.string()),
    facts: z.record(z.string()),
    rules: z.array(z.string()).default([]),
    switches: z.array(z.object({ label: z.string(), winner: z.string() })).default([]),
    matrix: z
      .array(z.object({ step: z.number().nullable(), label: z.string(), values: z.record(z.string()), best: z.string().nullable() }))
      .default([]),
    dropped: z.array(z.object({ id: z.string(), sameAs: z.string() })).default([]),
    /** The promise; its partner ids are the stakeholder parties besides the bank and the project. */
    approved: z.object({ partners: z.array(z.object({ partnerId: z.string() })) }).optional(),
  }),
});

const ExplainVariant = z.object({
  id: z.string(),
  whatWeDo: z.string().default(''),
  whatShifts: z.string().default(''),
  result: z.string().default(''),
  verdict: z.string().default(''),
  gives: z.array(z.string()).default([]),
  costs: z.array(z.string()).default([]),
  stakeholders: z.array(z.object({ party: z.string(), meaning: z.string() })).default([]),
});

const ExplainReply = z.object({
  headline: z.string().min(1),
  variants: z.array(ExplainVariant).default([]),
  whyRecommended: z.string().default(''),
  recommendation: z.string().default(''),
  departureReason: z.string().nullable().default(null),
  caveats: z.array(z.string()).default([]),
  whyNotOthers: z.array(z.object({ id: z.string(), reason: z.string() })).default([]),
});

type ExplainAnswer = z.infer<typeof ExplainReply>;

const NOTHING_SCORED = 'Ни один вариант не посчитан сервером, объяснять нечего. Причины отказов в таблице и в трассировке.';

/** null when the answer can stand: the recommendation is the top-ranked variant or carries a reason. */
export function departureError(answer: ExplainAnswer, topRanked: string): string | null {
  if (answer.recommendation === topRanked || (answer.departureReason ?? '') !== '') return null;
  return `The recommendation ${answer.recommendation} departs from the top-ranked variant ${topRanked} without a reason. Recommend ${topRanked}, or keep ${answer.recommendation} and write the reason in departureReason. Return the whole JSON again.`;
}

export async function explainVariants(raw: unknown, ctx: ActivityContext) {
  const input = ExplainInput.parse(raw);
  const { facts } = input.scored;
  const ids = input.scored.variants.filter((v) => v.status === 'ok').map((v) => v.id);
  const topRanked = input.scored.ranking.find((id) => ids.includes(id)) ?? '';
  const overview = {
    rules: input.scored.rules,
    switches: input.scored.switches.map((s) => ({
      label: s.label,
      goal: SWITCH_GOALS.find((g) => g.label === s.label)?.goal ?? null,
      winner: s.winner,
    })),
    matrix: input.scored.matrix,
    dropped: input.scored.dropped,
  };
  if (ids.length === 0) {
    return {
      headline: NOTHING_SCORED,
      variants: [],
      whyRecommended: '',
      caveats: [],
      recommendation: '',
      topRanked,
      departureReason: null,
      whyNotOthers: [],
      ...overview,
      unknownPlaceholders: [],
      literalNumbers: [],
    };
  }
  const parties = [...(input.scored.approved?.partners.map((p) => p.partnerId) ?? []), 'bank', 'project'];
  const responseSchema = { name: 'variant_explanation', schema: explainJsonSchema(ids, parties) };
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
          redLines: v.redLines,
          goalChecks: v.goalChecks,
          reconciliations: v.reconciliations,
        })),
        ranking: input.scored.ranking,
        topRanked,
        rules: input.scored.rules,
        switches: input.scored.switches,
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
      retry = `Return only the JSON object with the keys headline, variants, whyRecommended, recommendation, departureReason, caveats, whyNotOthers. Error: ${message}`;
    }
    if (retry !== null) messages.push({ role: 'assistant', content: resp.content }, { role: 'user', content: retry });
  }
  const final: ExplainAnswer = reply ??
    candidate ?? {
      headline: lastContent,
      variants: [],
      whyRecommended: '',
      recommendation: '',
      departureReason: null,
      caveats: [],
      whyNotOthers: [],
    };
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
      verdict: render(v.verdict),
      gives: v.gives.map(render),
      costs: v.costs.map(render),
      stakeholders: v.stakeholders.map((s) => ({ party: s.party, meaning: render(s.meaning) })),
    })),
    whyRecommended: render(final.whyRecommended),
    caveats: final.caveats.map(render),
    recommendation: final.recommendation,
    topRanked,
    departureReason: final.departureReason === null ? null : render(final.departureReason),
    whyNotOthers: final.whyNotOthers.map((w) => ({ id: w.id, reason: render(w.reason) })),
    ...overview,
    unknownPlaceholders: unknown,
    literalNumbers: literal,
  };
}

// ---------- answerQuestion ----------

export const AnswerInput = z.object({
  question: z.string().min(1),
  facts: z.record(z.string()).default({}),
  drafts: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
});

const NO_DRAFTS = 'Сначала опишите сценарий: вариантов ещё нет';

export async function answerQuestion(
  raw: unknown,
  ctx: ActivityContext,
): Promise<{ answer: string; unknownPlaceholders: string[]; literalNumbers: string[] }> {
  const input = AnswerInput.parse(raw);
  if (input.drafts.length === 0) return { answer: NO_DRAFTS, unknownPlaceholders: [], literalNumbers: [] };
  const schema = answerJsonSchema();
  const reply = await askStructured<string>(ctx, {
    system: answerSystemPrompt(),
    user: answerUserPrompt(input.question, input.drafts, input.facts),
    schemaName: 'question_answer',
    schema,
    relaxedSchema: schema,
    label: 'answerQuestion',
    check: (normalized) => {
      const parsed = z.object({ answer: z.string().min(1) }).safeParse(normalized);
      return parsed.success ? { value: parsed.data.answer, errors: [] } : { value: null, errors: zodErrors(parsed.error) };
    },
  });
  const template = reply.value ?? `Ответа нет: ${reply.errors.join('; ')}`;
  const out = renderPlaceholders(template, input.facts);
  return {
    answer: out.text,
    unknownPlaceholders: out.unknown,
    literalNumbers: reply.value === null ? [] : literalNumbers(template, [input.question, ...Object.values(input.facts)]),
  };
}
