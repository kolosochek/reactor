// The canned provider behind the page's free sample run (DEV-1364 stage 4,
// DEV-1375 stage 5): its proposals pass the server checks, its explanation
// follows the ranking, and every demo phrase gets an answer the step's strict
// schema accepts.

import { describe, expect, it } from 'vitest';
import type { ProgressEvent } from '@kolosochek/reactor-core';
import { checkPatch } from '../kairon/checks.js';
import { planHash, replayLineage } from '../kairon/lineage.js';
import {
  answerJsonSchema,
  explainJsonSchema,
  goalJsonSchema,
  normalizeStrictAnswer,
  openMonths,
  proposalJsonSchema,
  routeJsonSchema,
  scenarioJsonSchema,
  widgetsJsonSchema,
} from '../kairon/llmSchemas.js';
import { ForecastPatchSchema } from '../kairon/patch.js';
import { routeUserPrompt } from '../kairon/prompts.js';
import { createSampleLLM, DEMO_PHRASES, SAMPLE_MODEL } from '../kairon/sampleLlm.js';
import { fixtureDoc, readStage5 } from './_helpers/kaironFake.js';

interface Schema {
  type?: string;
  enum?: unknown[];
  anyOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
}

/** What a strict json_schema response format would refuse in this value: the subset of JSON Schema llmSchemas.ts uses. */
function violations(schema: Schema, value: unknown, path = '$'): string[] {
  if (schema.anyOf !== undefined) {
    return schema.anyOf.some((s) => violations(s, value, path).length === 0) ? [] : [`${path}: matches no anyOf branch`];
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} not in the enum`];
  if (schema.type === 'null') return value === null ? [] : [`${path}: not null`];
  if (schema.type === 'string') return typeof value === 'string' ? [] : [`${path}: not a string`];
  if (schema.type === 'integer') {
    const ok =
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= (schema.minimum ?? -Infinity) &&
      value <= (schema.maximum ?? Infinity);
    return ok ? [] : [`${path}: not an integer in range`];
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path}: not an array`];
    return value.flatMap((v, i) => violations(schema.items ?? {}, v, `${path}[${i}]`));
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: not an object`];
    const props = schema.properties ?? {};
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    return [
      ...keys.filter((k) => !(k in props)).map((k) => `${path}.${k}: not allowed`),
      ...(schema.required ?? []).filter((k) => !keys.includes(k)).map((k) => `${path}.${k}: missing`),
      ...keys.flatMap((k) => violations(props[k] ?? {}, record[k], `${path}.${k}`)),
    ];
  }
  return [];
}

const [STAGE4 = '', COVER = '', WHY = '', CONSTRUCTION_PHRASE = '', PROFIT = '', SOLSTICE_ONLY = ''] = DEMO_PHRASES;
const UNKNOWN = 'Что будет, если банк поднимет ставку?';
const FIXED = 'В образце нет ответа на эту фразу, выберите модель с ключом';
const CODES = fixtureDoc.plan.lines.map((l) => l.code);
const MONTHS = openMonths('2026-08', '2028-07', 24);
const DRAFTS = [
  { id: 'v1', title: 'Только заявленное изменение' },
  { id: 'v2', title: 'Резерв U2' },
  { id: 'v3', title: 'Цены' },
];
const RULES = { closedThrough: '2026-08', derivedLineCodes: [] as string[] };
const CONSTRUCTION = { type: 'cost_change' as const, lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 };

async function ask(label: string, user: string, schema: Record<string, unknown>, system = 'system'): Promise<unknown> {
  const llm = createSampleLLM({ emit: () => undefined });
  const res = await llm.complete({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    label: `${label}, attempt 1`,
    responseSchema: { name: label, schema },
  } as never);
  return JSON.parse(res.content);
}

describe('kairon createSampleLLM, stage 4', () => {
  it('proposes three variants that pass the patch checks, v1 without levers', async () => {
    // SCENARIO: the page runs the sample for Rivergate's kolaudace +3
    // INPUT: a proposeVariants request carrying the stage 4 phrase
    // EXPECTED: ids v1..v3, v1 levers []; every patch checks clean on Forecast v3 closed through 2026-08; events request -> done
    const events: ProgressEvent[] = [];
    const llm = createSampleLLM({ emit: (e) => events.push(e) });
    const res = await llm.complete({ messages: [{ role: 'user', content: `USER'S SCENARIO:\n${STAGE4}` }], label: 'proposeVariants, attempt 1' } as never);
    const answer = normalizeStrictAnswer(JSON.parse(res.content)) as { variants: Array<{ id: string; levers?: string[]; patch: object }> };

    expect(answer.variants.map((v) => [v.id, v.levers ?? []])).toEqual([
      ['v1', []],
      ['v2', ['Цены квартир +1,5 %']],
      ['v3', ['Первая очередь на месяц раньше']],
    ]);
    const errors = answer.variants.map((v) => checkPatch(fixtureDoc, RULES, ForecastPatchSchema.parse({ ...v.patch, name: v.id })).errors);
    expect(errors).toEqual([[], [], []]);
    expect([res.model, events.map((e) => e.type)]).toEqual([SAMPLE_MODEL, ['llm.request', 'llm.done']]);
  });

  it('recommends the top-ranked variant named in the prompt and covers every scored id', async () => {
    // SCENARIO: the server ranks v2 first; v1 and v2 were scored
    // INPUT: an explainVariants request with the explain schema for [v1, v2] and "TOP-RANKED VARIANT: v2"
    // EXPECTED: recommendation v2, variant entries v1 and v2, departureReason null, the strict schema accepts it
    const schema = explainJsonSchema(['v1', 'v2']);
    const answer = (await ask('explainVariants', `USER'S SCENARIO:\n${STAGE4}\n\nTOP-RANKED VARIANT: v2\n\nVARIANTS`, schema)) as {
      recommendation: string;
      departureReason: null;
      variants: Array<{ id: string }>;
    };
    expect([answer.recommendation, answer.departureReason, answer.variants.map((v) => v.id)]).toEqual(['v2', null, ['v1', 'v2']]);
    expect(violations(schema, answer)).toEqual([]);
  });
});

describe('kairon createSampleLLM, stage 5 demo phrases', () => {
  it('lists the six demo phrases', () => {
    // SCENARIO: the page offers the phrases the sample can answer
    // INPUT: DEMO_PHRASES
    // EXPECTED: the stage 4 textarea text, then the five stage 5 phrases, verbatim
    expect(DEMO_PHRASES).toEqual([
      'Разрешение на ввод в эксплуатацию (kolaudace) сдвигается на 3 месяца: с декабря 2027 на март 2028. Достройка растягивается, передача квартир и выход тоже сдвигаются. Как сохранить партнёрам IRR, обещанный в утверждённом бюджете?',
      'Хочу, чтобы ближайшие 6 месяцев все затраты покрывал Cedar',
      'Почему v2 выше v3?',
      'Стройка дорожает на 8 % с 2026-09',
      'Хочу добиться чистой прибыли в +10 000 000',
      'Хочу сохранить IRR только для Solstice',
    ]);
  });

  it('routes every phrase to its message kind', async () => {
    // SCENARIO: the router step for each phrase, drafts v1..v3 on the page
    // INPUT: routeUserPrompt(phrase, drafts, 'v2') for the six phrases and one unknown phrase
    // EXPECTED: generate, goal_change [], question, generate, goal_change [], goal_change ['all'], question; every answer valid
    const schema = routeJsonSchema(DRAFTS.map((d) => d.id));
    const answers = await Promise.all(
      [...DEMO_PHRASES, UNKNOWN].map((phrase) => ask('route', routeUserPrompt(phrase, DRAFTS, 'v2'), schema)),
    );
    expect(answers).toEqual([
      { kind: 'generate', scope: [] },
      { kind: 'goal_change', scope: [] },
      { kind: 'question', scope: [] },
      { kind: 'generate', scope: [] },
      { kind: 'goal_change', scope: [] },
      { kind: 'goal_change', scope: ['all'] },
      { kind: 'question', scope: [] },
    ]);
    expect(answers.flatMap((a) => violations(schema, a))).toEqual([]);
  });

  it('routes the profit phrase by the message when a draft title repeats the construction phrase', async () => {
    // SCENARIO: section S2 holds v1 titled with the construction phrase; the user types the profit phrase
    // INPUT: routeUserPrompt(profit phrase, [{ v1: construction phrase }], 'v1')
    // EXPECTED: goal_change with scope [] (the selected card), the draft list never picks the phrase
    const drafts = [{ id: 'v1', title: 'Стройка дорожает на 8 % с 2026-09' }];
    const schema = routeJsonSchema(drafts.map((d) => d.id));
    const answer = await ask('route', routeUserPrompt('Хочу добиться чистой прибыли в +10 000 000', drafts, 'v1'), schema);
    expect(answer).toEqual({ kind: 'goal_change', scope: [] });
  });

  it('structures the construction phrase as a cost change and the stage 4 phrase as free', async () => {
    // SCENARIO: the structuring step for the two generate phrases
    // INPUT: «Стройка дорожает на 8 % с 2026-09» and the stage 4 phrase
    // EXPECTED: cost_change D5, D8 from 2026-09 × 1 080 000; free with null keys; both valid
    const schema = scenarioJsonSchema(CODES, MONTHS);
    const answers = await Promise.all([CONSTRUCTION_PHRASE, STAGE4].map((p) => ask('structureScenario', `MESSAGE:\n${p}`, schema)));
    expect(answers).toEqual([
      { type: 'cost_change', lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 },
      { type: 'free', lineCodes: [], fromMonth: null, factorPpm: null },
    ]);
    expect(answers.flatMap((a) => violations(schema, a))).toEqual([]);
  });

  it('structures the three goal phrases', async () => {
    // SCENARIO: the goal step for the cover, profit and Solstice-only phrases
    // INPUT: the three phrases
    // EXPECTED: funding_cover cedar 2026-09 × 6; net_profit_target 1 000 000 000 minor delta; irr_floor [solstice]; all valid
    const schema = goalJsonSchema(['solstice', 'cedar'], MONTHS);
    const answers = await Promise.all([COVER, PROFIT, SOLSTICE_ONLY].map((p) => ask('structureGoal', `MESSAGE:\n${p}`, schema)));
    expect(answers).toEqual([
      { type: 'funding_cover', partnerId: 'cedar', fromMonth: '2026-09', months: 6, partnerIds: [], amountMinor: null, basis: null },
      { type: 'net_profit_target', partnerId: null, fromMonth: null, months: null, partnerIds: [], amountMinor: '1000000000', basis: 'delta' },
      { type: 'irr_floor', partnerId: null, fromMonth: null, months: null, partnerIds: ['solstice'], amountMinor: null, basis: null },
    ]);
    expect(answers.flatMap((a) => violations(schema, a))).toEqual([]);
  });

  it('proposes the construction levers that replay to the recorded scenario 2 bodies', async () => {
    // SCENARIO: the server built v1 (the scenario alone) and asks for v2..v4
    // INPUT: system "Return exactly 3 variants with ids v2, v3, v4."; user scenario «Стройка дорожает на 8 % с 2026-09»
    // EXPECTED: valid; v2 U2 release, v3 R1 × 1 030 000, v4 both with R1 × 1 023 000; on top of the scenario each replays to s2-vN.body.json
    const schema = proposalJsonSchema(CODES, MONTHS);
    const answer = await ask(
      'proposeVariants',
      `USER'S SCENARIO:\n${CONSTRUCTION_PHRASE}`,
      schema,
      'OUTPUT: ...\nReturn exactly 3 variants with ids v2, v3, v4. Write title, rationale',
    );
    expect(violations(schema, answer)).toEqual([]);
    const normalized = normalizeStrictAnswer(answer) as { variants: Array<{ id: string; patch: object }> };
    const bodies = normalized.variants.map((v) => {
      const leverPatch = ForecastPatchSchema.parse({ ...v.patch, name: v.id });
      const lineage = { activePlanHash: planHash(fixtureDoc), scenario: CONSTRUCTION, leverPatch, steps: [] };
      return [v.id, replayLineage(fixtureDoc, RULES, lineage).body];
    });
    expect(bodies).toEqual([
      ['v2', readStage5('s2-v2.body.json')],
      ['v3', readStage5('s2-v3.body.json')],
      ['v4', readStage5('s2-v4.body.json')],
    ]);
  });

  it('answers the profit goal with one price lever even after the construction turn', async () => {
    // SCENARIO: the profit goal on v2 after scenario 2; the history names the construction phrase first
    // INPUT: system "Return exactly 1 variants with ids v2.1."; user: an earlier turn with phrase 4, then the profit phrase
    // EXPECTED: valid; one variant v2.1 with scale R1 × 1 030 000 from 2026-09
    const schema = proposalJsonSchema(CODES, MONTHS);
    const answer = await ask(
      'proposeVariants',
      `EARLIER TURNS OF THIS CHAT (oldest first):\n1. User: ${CONSTRUCTION_PHRASE}\n   Result: x\n\nUSER'S SCENARIO:\n${PROFIT}`,
      schema,
      'Return exactly 1 variants with ids v2.1. Write title',
    );
    expect(violations(schema, answer)).toEqual([]);
    const variants = (answer as { variants: Array<{ id: string; patch: { scale: unknown[] } }> }).variants;
    expect(variants.map((v) => [v.id, v.patch.scale])).toEqual([['v2.1', [{ lineCodes: ['R1'], fromMonth: '2026-09', factorPpm: 1_030_000 }]]]);
  });

  it('names no widget, so the server decides which catalog widgets a draft gets', async () => {
    // SCENARIO: the widgets step for the cover draft
    // INPUT: planWidgets request with the schema for v2.1
    // EXPECTED: { widgets: [] }, valid
    const schema = widgetsJsonSchema(['v2.1']);
    const answer = await ask('planWidgets', 'DRAFTS:\nv2.1: funding.draws (14)', schema);
    expect(answer).toEqual({ widgets: [] });
    expect(violations(schema, answer)).toEqual([]);
  });

  it('explains the cover draft by IRR and interest, never by profit', async () => {
    // SCENARIO: the explanation after the Cedar cover goal; v2.1 is the cover child of v2
    // INPUT: explain schema for [v2, v2.1] with parties solstice, cedar, bank, project; top-ranked v2.1
    // EXPECTED: valid; recommendation v2.1; the cover's costs cite {{v2.1.d.irr.cedar}} and {{v2.1.d.interest}}
    const schema = explainJsonSchema(['v2', 'v2.1'], ['solstice', 'cedar', 'bank', 'project']);
    const answer = await ask('explainVariants', `USER'S SCENARIO:\n${COVER}\n\nTOP-RANKED VARIANT: v2.1\n\nVARIANTS`, schema);
    expect(violations(schema, answer)).toEqual([]);
    const explanation = answer as { recommendation: string; variants: Array<{ id: string; costs: string[] }> };
    expect(explanation.recommendation).toBe('v2.1');
    expect(explanation.variants.find((v) => v.id === 'v2.1')?.costs).toEqual([
      'Cedar вносит больше: IRR Cedar {{v2.1.d.irr.cedar}} к родителю.',
      'Проценты по источникам {{v2.1.d.interest}} к родителю.',
    ]);
  });

  it('answers «Почему v2 выше v3?» with server figures', async () => {
    // SCENARIO: a question about the ranking
    // INPUT: answerQuestion request with the question
    // EXPECTED: valid; v2 is higher on Solstice IRR, the server ranks v3 above v2 (closer to the promise, not below it)
    const schema = answerJsonSchema();
    const answer = await ask('answerQuestion', `QUESTION:\n${WHY}`, schema);
    expect(answer).toEqual({
      answer:
        'По IRR Solstice v2 выше v3: {{v2.irr.solstice}} против {{v3.irr.solstice}}, чистая прибыль {{v2.d.netProfit}} против {{v3.d.netProfit}}. В ранжировании сервера v3 стоит выше v2: правило берёт IRR не ниже обещания {{approved.irr.solstice}} и ближайший к нему, у v3 он ближе.',
    });
    expect(violations(schema, answer)).toEqual([]);
  });

  it('answers an unknown phrase with the fixed text', async () => {
    // SCENARIO: the user types a phrase the sample has no answer for
    // INPUT: «Что будет, если банк поднимет ставку?» to answerQuestion and explainVariants
    // EXPECTED: the answer and the headline carry the fixed text; both valid
    const answerSchema = answerJsonSchema();
    const explainSchema = explainJsonSchema(['v1']);
    const answer = await ask('answerQuestion', `QUESTION:\n${UNKNOWN}`, answerSchema);
    const explanation = await ask('explainVariants', `USER'S SCENARIO:\n${UNKNOWN}\n\nTOP-RANKED VARIANT: v1`, explainSchema);
    expect([answer, (explanation as { headline: string }).headline]).toEqual([{ answer: FIXED }, FIXED]);
    expect([...violations(answerSchema, answer), ...violations(explainSchema, explanation)]).toEqual([]);
  });
});
