// packages/reactor-service/src/kairon/llmSchemas.ts
//
// JSON schemas sent to the LLM as response_format json_schema with strict: true
// (DEV-1364 stage 3). Strict mode demands that every object is closed and every
// key is required, so an op the variant does not use is an empty array and an
// absent value is null. The schemas are built per run from the baseline: line
// codes and open months are enums, so the model cannot name a line the plan
// lacks. normalizeStrictAnswer maps the answer back to the patch format before
// the zod and Kairon checks run. The relaxed variant drops the month enums and
// the integer bounds (Gemini refuses schemas with too many states); the server
// checks still enforce both.

import { addMonths, monthsBetween } from './patch.js';

type JsonSchema = Record<string, unknown>;

/** Every month from..to, both included. */
export function planMonths(from: string, to: string): string[] {
  const count = monthsBetween(from, to) + 1;
  return Array.from({ length: Math.max(count, 0) }, (_, i) => addMonths(from, i));
}

export function openMonths(closedThrough: string, planEnd: string, marginMonths: number): string[] {
  return planMonths(addMonths(closedThrough, 1), addMonths(planEnd, marginMonths));
}

function closed(properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return {
    type: 'object',
    ...(description === undefined ? {} : { description }),
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function arrayOf(items: JsonSchema, description: string): JsonSchema {
  return { type: 'array', description, items };
}

function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: 'null' }] };
}

export interface ProposalJsonSchema extends JsonSchema {
  properties: Record<string, JsonSchema>;
}

function int(min: number, max: number, relaxed: boolean, description: string): JsonSchema {
  return relaxed
    ? { type: 'integer', description: `${description}; allowed ${min}..${max}` }
    : { type: 'integer', minimum: min, maximum: max, description };
}

export function proposalJsonSchema(
  lineCodes: string[],
  months: string[],
  options: { relaxed?: boolean } = {},
): ProposalJsonSchema {
  const relaxed = options.relaxed === true;
  const codes = arrayOf({ type: 'string', enum: lineCodes }, 'Plan line codes from the baseline');
  const range = `YYYY-MM, ${months[0] ?? ''}..${months[months.length - 1] ?? ''}`;
  const month = (description: string): JsonSchema =>
    relaxed ? { type: 'string', description: `${description} (${range})` } : { type: 'string', enum: months, description };
  const shiftBy = int(-24, 24, relaxed, 'Months; positive = later');
  const patch = closed(
    {
      stretch: arrayOf(
        closed({ lineCodes: codes, fromMonth: month('First month to spread from'), byMonths: shiftBy }),
        'Spread non-zero cells from fromMonth over (span + byMonths) months, total kept. [] when unused.',
      ),
      shift: arrayOf(
        closed({
          lineCodes: codes,
          fromMonth: month('First month to move'),
          toMonth: nullable(month('Last month to move; null = to the end')),
          byMonths: shiftBy,
        }),
        'Move cells in fromMonth..toMonth by byMonths, amounts kept. [] when unused.',
      ),
      extend: arrayOf(
        closed({ lineCodes: codes, months: int(1, 24, relaxed, 'Extra months') }),
        'Repeat the last non-zero monthly amount for N more months. [] when unused.',
      ),
      scale: arrayOf(
        closed({
          lineCodes: codes,
          fromMonth: month('First month to scale'),
          factorPpm: int(970000, 1030000, relaxed, '1010000 = +1 %'),
        }),
        'Multiply cells from fromMonth by factorPpm / 1000000. [] when unused.',
      ),
      set: arrayOf(
        closed({
          code: { type: 'string', enum: lineCodes },
          month: month('Cell month'),
          amountMinor: { type: 'string', description: 'Minor units as a decimal string; costs negative' },
        }),
        'Write single cells. [] when unused.',
      ),
      monthRangeTo: nullable(month('New last month of the plan; null = unchanged')),
      shareTarget: nullable(
        closed({ equityShareBp: int(0, 10000, relaxed, 'Basis points') }, 'Partners share of funding'),
      ),
    },
    'The forecast patch; the server applies it and computes every figure',
  );
  return closed({
    variants: arrayOf(
      closed({
        id: { type: 'string', description: 'v1, v2, ...' },
        title: { type: 'string', description: 'Russian, short' },
        rationale: { type: 'string', description: 'Russian, 2-3 sentences' },
        levers: arrayOf({ type: 'string' }, 'Russian lever names'),
        patch,
      }),
      'The variants, each with its own levers',
    ),
    openQuestions: arrayOf({ type: 'string' }, 'Russian; assumptions the user should confirm'),
  }) as ProposalJsonSchema;
}

export function explainJsonSchema(variantIds: string[], parties: string[] = ['bank', 'project']): ProposalJsonSchema {
  const text = (description: string): JsonSchema => ({ type: 'string', description });
  return closed({
    headline: text('Russian, one sentence for the CFO: does the promise hold and at what cost; figures only as {{key}}'),
    variants: arrayOf(
      closed({
        id: { type: 'string', enum: variantIds },
        whatWeDo: text('Russian, 1 sentence: the business decision in a developer\'s terms; no figures'),
        whatShifts: text('Russian, 1-2 sentences: what moves in time (sales, construction, exit, funding); months allowed'),
        result: text('Russian, 1-2 sentences: partner IRR against the promise, net profit change, cash trough; figures only as {{key}}'),
        verdict: text('Russian, one sentence: does the variant meet the goal, and the deciding figure as {{key}}'),
        gives: arrayOf(text('Russian; figures only as {{key}}'), 'What the variant gives the client: 1-3 items'),
        costs: arrayOf(text('Russian; figures only as {{key}}'), 'What it costs and who pays: 1-3 items'),
        stakeholders: arrayOf(
          closed({ party: { type: 'string', enum: parties }, meaning: text('Russian, one sentence: what the variant means for this party') }),
          'One row per party the variant affects',
        ),
      }),
      'One entry per scored variant, in ranking order',
    ),
    whyRecommended: text('Russian, 1-2 sentences: why the recommended variant; figures only as {{key}}'),
    recommendation: { type: 'string', enum: variantIds },
    departureReason: nullable({
      type: 'string',
      description: 'Russian; why the recommendation is not the top-ranked variant; null when it is',
    }),
    caveats: arrayOf({ type: 'string' }, 'Russian; may use {{key}} placeholders'),
    whyNotOthers: arrayOf(
      closed({ id: { type: 'string', enum: variantIds }, reason: text('Russian, one sentence; figures only as {{key}}') }),
      'One entry per variant that is not recommended',
    ),
  }) as ProposalJsonSchema;
}

const literal = (value: string): JsonSchema => ({ type: 'string', enum: [value] });

/** kairon.planWidgets: per variant id, the declarative widget specs (widgets.ts WidgetSpecSchema). */
export function widgetsJsonSchema(variantIds: string[]): ProposalJsonSchema {
  const title: JsonSchema = { type: 'string', description: 'Russian widget title' };
  const specs: JsonSchema[] = [
    closed({
      widget: literal('matrix-diff'),
      title,
      rows: literal('draws[].sourceId'),
      cols: literal('draws[].period'),
      value: literal('amountMinor'),
      highlight: literal('changed'),
      delta: literal('cell, row'),
    }),
    closed({
      widget: literal('bars-before-after'),
      title,
      x: literal('period'),
      stack: literal('sourceId'),
      y: literal('amountMinor'),
      compare: arrayOf({ type: 'string' }, 'Two sides: ["parent", "draft"]'),
      label: { type: 'string', description: 'Russian label of the delta' },
    }),
    closed({ widget: literal('condition-check'), title, goals: literal('active') }),
    closed({ widget: literal('stakeholder-table'), title, rows: arrayOf({ type: 'string' }, 'Party names') }),
  ];
  return closed({
    widgets: arrayOf(
      closed({ id: { type: 'string', enum: variantIds }, specs: arrayOf({ anyOf: specs }, 'Widgets for the changed paths') }),
      'One entry per variant',
    ),
  }) as ProposalJsonSchema;
}

/** kairon.answerQuestion: one Russian answer citing figures as {{key}}. */
export function answerJsonSchema(): ProposalJsonSchema {
  return closed({
    answer: { type: 'string', description: 'Russian, 1-4 sentences; figures only as {{key}}' },
  }) as ProposalJsonSchema;
}

/** Drop nulls and empty arrays at every depth, so a strict answer reads as the optional-key patch format. */
export function normalizeStrictAnswer(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStrictAnswer);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null || (Array.isArray(v) && v.length === 0)) continue;
    out[key] = normalizeStrictAnswer(v);
  }
  return out;
}

/** The first {...} block of an LLM reply, parsed; throws when there is none. */
export function parseJsonObject(content: string): unknown {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(content.slice(start, end + 1));
}

export const CUT_OFF_ERROR = 'reply: cut off at the token limit (finish_reason length) before the JSON closed';

/** kairon.route: the message kind and the draft ids it is about. */
export function routeJsonSchema(draftIds: string[], options: { relaxed?: boolean } = {}): ProposalJsonSchema {
  const id: JsonSchema =
    options.relaxed === true ? { type: 'string', description: `A draft id or "all": ${[...draftIds, 'all'].join(', ')}` } : { type: 'string', enum: [...draftIds, 'all'] };
  return closed({
    kind: { type: 'string', enum: ['generate', 'goal_change', 'question'] },
    scope: arrayOf(id, '[] = the selected card; ["all"] = every variant'),
  }) as ProposalJsonSchema;
}

/** kairon.structureScenario: a stated cost change, or free for anything else. */
export function scenarioJsonSchema(lineCodes: string[], months: string[], options: { relaxed?: boolean } = {}): ProposalJsonSchema {
  const relaxed = options.relaxed === true;
  const month: JsonSchema = relaxed
    ? { type: 'string', description: `YYYY-MM, ${months[0] ?? ''}..${months[months.length - 1] ?? ''}` }
    : { type: 'string', enum: months };
  return closed({
    type: { type: 'string', enum: ['cost_change', 'free'] },
    lineCodes: arrayOf(relaxed ? { type: 'string' } : { type: 'string', enum: lineCodes }, 'Lines the change applies to; [] for free'),
    fromMonth: nullable(month),
    factorPpm: nullable(int(500000, 2000000, relaxed, '1080000 = +8 %')),
  }) as ProposalJsonSchema;
}

/** kairon.structureGoal: one of the three goal types; unused keys are null or []. */
export function goalJsonSchema(partnerIds: string[], months: string[], options: { relaxed?: boolean } = {}): ProposalJsonSchema {
  const relaxed = options.relaxed === true;
  const partner: JsonSchema = relaxed ? { type: 'string', description: partnerIds.join(', ') } : { type: 'string', enum: partnerIds };
  const month: JsonSchema = relaxed
    ? { type: 'string', description: `YYYY-MM, ${months[0] ?? ''}..${months[months.length - 1] ?? ''}` }
    : { type: 'string', enum: months };
  return closed({
    type: { type: 'string', enum: ['funding_cover', 'irr_floor', 'net_profit_target'] },
    partnerId: nullable(partner),
    fromMonth: nullable(month),
    months: nullable(int(1, 24, relaxed, 'Months in the window')),
    partnerIds: arrayOf(partner, 'irr_floor only; [] otherwise'),
    amountMinor: nullable({ type: 'string', description: 'net_profit_target only: minor units as a decimal string, signed' }),
    basis: nullable({ type: 'string', enum: ['delta', 'absolute'] }),
  }) as ProposalJsonSchema;
}
