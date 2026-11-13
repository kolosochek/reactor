// packages/reactor-service/src/kairon/conversation.ts
//
// The conversation steps of stage 5 (DEV-1375, spec 5.1). Every message runs
// a planning run first: kairon.route picks the kind (generate, goal change,
// question) and the drafts it is about. A generate message is then structured
// by kairon.structureScenario, a goal change by kairon.structureGoal. Each step
// sends a strict JSON schema whose enums come from the session (draft ids) or
// the baseline (line codes, open months, partner ids), checks the answer on
// the server and asks once more with the errors. A step that still fails
// returns its errors as data: batch mode aborts the plan on a throw.

import { z } from 'zod';
import type { ActivityContext, LLMCompletionRequest } from '@kolosochek/reactor-core';
import { loadDocument, type Baseline } from './baseline.js';
import type { KaironApi } from './client.js';
import { GoalSchema, type Goal } from './goals.js';
import {
  CUT_OFF_ERROR,
  goalJsonSchema,
  normalizeStrictAnswer,
  openMonths,
  planMonths,
  parseJsonObject,
  routeJsonSchema,
  scenarioJsonSchema,
} from './llmSchemas.js';
import type { KaironLLMRequest } from './openrouter.js';
import {
  goalSystemPrompt,
  routeSystemPrompt,
  routeUserPrompt,
  scenarioSystemPrompt,
} from './prompts.js';
import { applyScenario, ScenarioSpecSchema, type ScenarioSpec } from './scenario.js';

type LLMMessage = LLMCompletionRequest['messages'][number];

/** Reasoning models think before a short JSON answer; 8 000 tokens leaves room for both. */
const STRUCTURE_MAX_TOKENS = 8_000;
const STRUCTURE_ATTEMPTS = 2;

const BaselineArg = z.custom<Baseline>(
  (v) => typeof v === 'object' && v !== null && 'closedThrough' in v && 'forecastVersion' in v,
  'baseline must be the output of kairon.baseline',
);

export function zodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

/**
 * One structured LLM step: ask with a strict schema, check the normalized
 * answer on the server, ask once more with the errors. Returns the last errors
 * when no answer passes.
 */
export async function askStructured<T>(
  ctx: ActivityContext,
  opts: {
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
    relaxedSchema: Record<string, unknown>;
    label: string;
    check: (normalized: unknown) => Promise<{ value: T | null; errors: string[] }> | { value: T | null; errors: string[] };
  },
): Promise<{ value: T | null; errors: string[] }> {
  const messages: LLMMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  let errors: string[] = [];
  for (let attempt = 1; attempt <= STRUCTURE_ATTEMPTS; attempt++) {
    const request: KaironLLMRequest = {
      messages: [...messages],
      temperature: 0,
      maxTokens: STRUCTURE_MAX_TOKENS,
      jsonMode: true,
      responseSchema: { name: opts.schemaName, schema: opts.schema, relaxedSchema: opts.relaxedSchema },
      label: `${opts.label}, attempt ${attempt}`,
      signal: ctx.signal,
    };
    const resp = await ctx.llm.complete(request);
    let result: { value: T | null; errors: string[] };
    if (resp.finishReason === 'length') {
      result = { value: null, errors: [CUT_OFF_ERROR] };
    } else {
      try {
        result = await opts.check(normalizeStrictAnswer(parseJsonObject(resp.content)));
      } catch (err) {
        result = { value: null, errors: [`reply: ${err instanceof Error ? err.message : String(err)}`] };
      }
    }
    if (result.errors.length === 0 && result.value !== null) return result;
    errors = result.errors;
    messages.push(
      { role: 'assistant', content: resp.content },
      { role: 'user', content: `The server cannot use this answer. Fix every error below and return the whole JSON again:\n${errors.map((e) => `- ${e}`).join('\n')}` },
    );
  }
  return { value: null, errors };
}

// ---------- kairon.route ----------

export const RouteInput = z.object({
  message: z.string().min(1),
  drafts: z.array(z.object({ id: z.string().min(1), title: z.string() })).default([]),
  selected: z.string().nullable().default(null),
});

const RouteReply = z.object({
  kind: z.enum(['generate', 'goal_change', 'question']),
  scope: z.array(z.string()).default([]),
});

export interface Route {
  kind: 'generate' | 'goal_change' | 'question';
  scope: string[];
  error: string | null;
}

export async function route(raw: unknown, ctx: ActivityContext): Promise<Route> {
  const input = RouteInput.parse(raw);
  const ids = input.drafts.map((d) => d.id);
  const allowed = [...ids, 'all'];
  const out = await askStructured(ctx, {
    system: routeSystemPrompt(),
    user: routeUserPrompt(input.message, input.drafts, input.selected),
    schemaName: 'message_route',
    schema: routeJsonSchema(ids),
    relaxedSchema: routeJsonSchema(ids, { relaxed: true }),
    label: 'route',
    check: (normalized) => {
      const parsed = RouteReply.safeParse(normalized);
      if (!parsed.success) return { value: null, errors: zodErrors(parsed.error) };
      const unknown = parsed.data.scope.filter((id) => !allowed.includes(id));
      if (unknown.length > 0) {
        return { value: null, errors: [`scope: unknown draft ${unknown.join(', ')}; known: ${allowed.join(', ')}`] };
      }
      return { value: parsed.data, errors: [] };
    },
  });
  if (out.value === null) return { kind: 'question', scope: [], error: out.errors.join('; ') };
  const scope = out.value.scope.length === 0 && input.selected !== null ? [input.selected] : out.value.scope;
  return { kind: out.value.kind, scope, error: null };
}

// ---------- kairon.structureScenario ----------

export const StructureScenarioInput = z.object({ message: z.string().min(1), baseline: BaselineArg });

export async function structureScenario(
  api: KaironApi,
  raw: unknown,
  ctx: ActivityContext,
): Promise<{ spec: ScenarioSpec; errors: string[] }> {
  const input = StructureScenarioInput.parse(raw);
  const b = input.baseline;
  const doc = await loadDocument(api, b.forecastVersion.id);
  const rules = { closedThrough: b.closedThrough, derivedLineCodes: b.derivedLineCodes };
  const codes = b.lines
    .filter((l) => Object.keys(l.openCells).length > 0 && !b.derivedLineCodes.includes(l.code))
    .map((l) => l.code);
  const months = openMonths(b.closedThrough, b.monthRange.to, 0);
  const out = await askStructured(ctx, {
    system: scenarioSystemPrompt(b),
    user: input.message,
    schemaName: 'scenario_spec',
    schema: scenarioJsonSchema(codes, months),
    relaxedSchema: scenarioJsonSchema(codes, months, { relaxed: true }),
    label: 'structureScenario',
    check: (normalized) => {
      const parsed = ScenarioSpecSchema.safeParse(normalized);
      if (!parsed.success) return { value: null, errors: zodErrors(parsed.error) };
      const errors = applyScenario(doc, rules, parsed.data).errors;
      return { value: errors.length === 0 ? parsed.data : null, errors };
    },
  });
  return out.value === null ? { spec: { type: 'free' }, errors: out.errors } : { spec: out.value, errors: [] };
}

// ---------- kairon.structureGoal ----------

export const StructureGoalInput = z.object({
  message: z.string().min(1),
  baseline: BaselineArg,
  scope: z.array(z.string()).default([]),
});

export async function structureGoal(raw: unknown, ctx: ActivityContext): Promise<{ goal: Goal | null; errors: string[] }> {
  const input = StructureGoalInput.parse(raw);
  const b = input.baseline;
  const partnerIds = (b.partners.length > 0 ? b.partners : b.approved.partners).map((p) => p.partnerId);
  // The whole plan range: a window the user starts in a closed month comes back as said, and buildGoalDrafts
  // refuses it with the month named (Review Focus 4). An open-months enum would move it silently.
  const months = planMonths(b.monthRange.from, b.monthRange.to);
  const out = await askStructured(ctx, {
    system: goalSystemPrompt(b),
    user: input.message,
    schemaName: 'goal',
    schema: goalJsonSchema(partnerIds, months),
    relaxedSchema: goalJsonSchema(partnerIds, months, { relaxed: true }),
    label: 'structureGoal',
    check: (normalized) => {
      const parsed = GoalSchema.safeParse(normalized);
      return parsed.success ? { value: parsed.data, errors: [] } : { value: null, errors: zodErrors(parsed.error) };
    },
  });
  return { goal: out.value, errors: out.value === null ? out.errors : [] };
}
