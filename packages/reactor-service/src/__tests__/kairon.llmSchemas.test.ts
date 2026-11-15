// Strict JSON schemas sent to the LLM as response_format (DEV-1364 stage 3),
// and the normaliser that maps a strict-shaped answer back to the patch format.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkPatch } from '../kairon/checks.js';
import {
  explainJsonSchema,
  normalizeStrictAnswer,
  openMonths,
  proposalJsonSchema,
  widgetsJsonSchema,
} from '../kairon/llmSchemas.js';
import { ForecastPatchSchema, type ForecastDocument } from '../kairon/patch.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kairon');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, path), 'utf8'));
}

const doc = readJson('forecast-document.active.json') as ForecastDocument;
const lineCodes = doc.plan.lines.map((l) => l.code);
const months = openMonths('2026-08', '2028-07', 24);

/** Every object closed and every property required: what strict structured outputs demand. */
function strictViolations(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => strictViolations(n, `${path}[${i}]`));
  if (typeof node !== 'object' || node === null) return [];
  const n = node as Record<string, unknown>;
  const out: string[] = [];
  if (n.type === 'object') {
    const keys = Object.keys((n.properties as Record<string, unknown> | undefined) ?? {}).sort();
    const required = [...((n.required as string[] | undefined) ?? [])].sort();
    if (n.additionalProperties !== false) out.push(`${path}: additionalProperties is not false`);
    if (JSON.stringify(keys) !== JSON.stringify(required)) out.push(`${path}: required != properties`);
  }
  for (const [k, v] of Object.entries(n)) out.push(...strictViolations(v, `${path}.${k}`));
  return out;
}

describe('kairon openMonths', () => {
  it('lists the months after the closed one up to the plan end plus a margin', () => {
    // SCENARIO: the month enum a patch may name
    // INPUT: closed through 2026-08, plan ends 2028-07, margin 24 months
    // EXPECTED: 2026-09 .. 2030-07, 47 months
    expect(months[0]).toBe('2026-09');
    expect(months.at(-1)).toBe('2030-07');
    expect(months).toHaveLength(47);
  });
});

describe('kairon proposalJsonSchema', () => {
  const schema = proposalJsonSchema(lineCodes, months);

  it('passes the strict-mode rules at every depth', () => {
    // SCENARIO: OpenRouter json_schema with strict: true refuses open objects and optional keys
    // INPUT: the proposal schema for Rivergate's 45 lines
    // EXPECTED: no violations
    expect(strictViolations(schema)).toEqual([]);
  });

  it('limits line codes and months to enums built from the baseline', () => {
    // SCENARIO: the model cannot invent a line or a closed month as an op start
    // INPUT: the stretch op item schema
    // EXPECTED: lineCodes items enum = the 45 codes; fromMonth enum = the open months
    const variant = (schema.properties.variants as { items: { properties: { patch: { properties: Record<string, { items: { properties: Record<string, { enum?: unknown; items?: { enum: unknown } }> } }> } } } }).items;
    const stretch = variant.properties.patch.properties.stretch?.items.properties;
    expect(stretch?.lineCodes?.items?.enum).toEqual(lineCodes);
    expect(stretch?.fromMonth?.enum).toEqual(months);
  });
});

describe('kairon proposalJsonSchema, relaxed', () => {
  it('drops month enums and integer bounds, keeps line codes and strict shape', () => {
    // SCENARIO: the fallback sent after a provider refuses the full schema
    // INPUT: relaxed: true
    // EXPECTED: strict rules hold; no minimum/maximum anywhere; fromMonth has no enum; lineCodes enum kept
    const relaxed = proposalJsonSchema(lineCodes, months, { relaxed: true });
    const text = JSON.stringify(relaxed);
    expect(strictViolations(relaxed)).toEqual([]);
    expect([text.includes('"minimum"'), text.includes('"maximum"')]).toEqual([false, false]);
    const stretch = (relaxed.properties.variants as { items: { properties: { patch: { properties: { stretch: { items: { properties: { fromMonth: Record<string, unknown>; lineCodes: { items: { enum: string[] } } } } } } } } } }).items.properties.patch.properties.stretch.items.properties;
    expect(stretch.fromMonth).toEqual({ type: 'string', description: 'First month to spread from (YYYY-MM, 2026-09..2030-07)' });
    expect(stretch.lineCodes.items.enum).toEqual(lineCodes);
  });
});

describe('kairon explainJsonSchema', () => {
  it('passes the strict-mode rules and restricts the recommendation to variant ids', () => {
    // SCENARIO: the explanation names a variant that exists
    // INPUT: ids v1, v2; parties solstice, cedar, bank, project
    // EXPECTED: no strict violations; keys from the headline down to whyNotOthers; recommendation, variant and whyNotOthers ids enum ["v1", "v2"];
    //           departureReason is a string or null; a variant carries verdict, gives, costs, stakeholders with the party enum
    const schema = explainJsonSchema(['v1', 'v2'], ['solstice', 'cedar', 'bank', 'project']);
    expect(strictViolations(schema)).toEqual([]);
    expect((schema.properties.recommendation as { enum: string[] }).enum).toEqual(['v1', 'v2']);
    expect((schema.properties.departureReason as { anyOf: Array<{ type: string }> }).anyOf.map((s) => s.type)).toEqual(['string', 'null']);
    expect(Object.keys(schema.properties)).toEqual([
      'headline',
      'variants',
      'whyRecommended',
      'recommendation',
      'departureReason',
      'caveats',
      'whyNotOthers',
    ]);
    type Items = { items: { properties: Record<string, { enum?: string[]; items?: { properties: Record<string, { enum?: string[] }> } }> } };
    const item = (schema.properties.variants as Items).items;
    expect(Object.keys(item.properties)).toEqual(['id', 'whatWeDo', 'whatShifts', 'result', 'verdict', 'gives', 'costs', 'stakeholders']);
    expect(item.properties.id?.enum).toEqual(['v1', 'v2']);
    expect(item.properties.stakeholders?.items?.properties.party?.enum).toEqual(['solstice', 'cedar', 'bank', 'project']);
    expect((schema.properties.whyNotOthers as Items).items.properties.id?.enum).toEqual(['v1', 'v2']);
  });

  it('defaults the parties to the bank and the project', () => {
    // SCENARIO: a project without partners
    // INPUT: ids v1 only, no parties
    // EXPECTED: party enum ["bank", "project"]
    type Items = { items: { properties: { stakeholders: { items: { properties: { party: { enum: string[] } } } } } } };
    const schema = explainJsonSchema(['v1']);
    expect((schema.properties.variants as Items).items.properties.stakeholders.items.properties.party.enum).toEqual(['bank', 'project']);
  });
});

describe('kairon widgetsJsonSchema', () => {
  it('passes the strict-mode rules and offers the goal check per variant id', () => {
    // SCENARIO: the widgets step names a widget, never HTML or figures; the figures are catalog widgets (DEV-1381)
    // INPUT: ids v2.1, v2.2
    // EXPECTED: no strict violations; id enum ["v2.1", "v2.2"]; the one spec alternative is condition-check
    const schema = widgetsJsonSchema(['v2.1', 'v2.2']);
    expect(strictViolations(schema)).toEqual([]);
    type Widgets = {
      items: {
        properties: {
          id: { enum: string[] };
          specs: { items: { anyOf: Array<{ properties: { widget: { enum: string[] } } }> } };
        };
      };
    };
    const item = (schema.properties.widgets as Widgets).items;
    expect(item.properties.id.enum).toEqual(['v2.1', 'v2.2']);
    expect(item.properties.specs.items.anyOf.map((s) => s.properties.widget.enum[0])).toEqual(['condition-check']);
  });
});

describe('kairon normalizeStrictAnswer', () => {
  it('turns a strict-shaped delay-3 variant back into the golden evaluate body', () => {
    // SCENARIO: a strict answer carries every op, empty ones as [] and absent values as null
    // INPUT: delay-3 with scale: [], set: [], shareTarget: null, shift toMonth: null
    // EXPECTED: the normalised patch checks clean and builds bodies/body-delay-3.json
    const strict = {
      variants: [
        {
          id: 'v1',
          title: 't',
          rationale: 'r',
          levers: [],
          patch: {
            stretch: [{ lineCodes: ['D5', 'D8'], fromMonth: '2026-09', byMonths: 3 }],
            shift: [{ lineCodes: ['R1', 'R4', 'C1', 'C2', 'O4', 'U2', 'F7'], fromMonth: '2028-03', toMonth: null, byMonths: 3 }],
            extend: [{ lineCodes: ['O3', 'O5', 'F1', 'F2', 'F3'], months: 3 }],
            scale: [],
            set: [],
            monthRangeTo: '2028-10',
            shareTarget: null,
          },
        },
      ],
      openQuestions: [],
    };
    const normal = normalizeStrictAnswer(strict) as { variants: Array<{ patch: unknown }> };
    const patch = ForecastPatchSchema.parse({ ...(normal.variants[0]?.patch as object), name: 'v1' });
    const result = checkPatch(doc, { closedThrough: '2026-08', derivedLineCodes: [] }, patch);
    expect(result.errors).toEqual([]);
    expect(result.body).toEqual(readJson('bodies/body-delay-3.json'));
  });
});
