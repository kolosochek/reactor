// The canned provider behind the page's free sample run (DEV-1364 stage 4):
// its proposals pass the server checks and its explanation follows the ranking.

import { describe, expect, it } from 'vitest';
import type { ProgressEvent } from '@kolosochek/reactor-core';
import { checkPatch } from '../kairon/checks.js';
import { explainJsonSchema, normalizeStrictAnswer } from '../kairon/llmSchemas.js';
import { ForecastPatchSchema } from '../kairon/patch.js';
import { createSampleLLM, SAMPLE_MODEL } from '../kairon/sampleLlm.js';
import { fixtureDoc } from './_helpers/kaironFake.js';

describe('kairon createSampleLLM', () => {
  it('proposes three variants that pass the patch checks, v1 without levers', async () => {
    // SCENARIO: the page runs the sample for Rivergate's kolaudace +3
    // INPUT: a proposeVariants request
    // EXPECTED: ids v1..v3, v1 levers []; every patch checks clean on Forecast v3 closed through 2026-08; events request -> done
    const events: ProgressEvent[] = [];
    const llm = createSampleLLM({ emit: (e) => events.push(e) });
    const res = await llm.complete({ messages: [{ role: 'user', content: 's' }], label: 'proposeVariants, attempt 1' } as never);
    const answer = normalizeStrictAnswer(JSON.parse(res.content)) as { variants: Array<{ id: string; levers?: string[]; patch: object }> };

    expect(answer.variants.map((v) => [v.id, v.levers ?? []])).toEqual([
      ['v1', []],
      ['v2', ['Цены квартир +1,5 %']],
      ['v3', ['Первая очередь на месяц раньше']],
    ]);
    const errors = answer.variants.map(
      (v) => checkPatch(fixtureDoc, { closedThrough: '2026-08', derivedLineCodes: [] }, ForecastPatchSchema.parse({ ...v.patch, name: v.id })).errors,
    );
    expect(errors).toEqual([[], [], []]);
    expect([res.model, events.map((e) => e.type)]).toEqual([SAMPLE_MODEL, ['llm.request', 'llm.done']]);
  });

  it('recommends the top-ranked variant named in the prompt and covers every scored id', async () => {
    // SCENARIO: the server ranks v2 first; v1 and v2 were scored
    // INPUT: an explainVariants request with the explain schema for [v1, v2] and "TOP-RANKED VARIANT: v2"
    // EXPECTED: recommendation v2, variant entries v1 and v2, departureReason null
    const llm = createSampleLLM({ emit: () => undefined });
    const res = await llm.complete({
      messages: [{ role: 'user', content: 'USER\'S SCENARIO:\nx\n\nTOP-RANKED VARIANT: v2\n\nVARIANTS' }],
      label: 'explainVariants, attempt 1',
      responseSchema: { name: 'variant_explanation', schema: explainJsonSchema(['v1', 'v2']) },
    } as never);
    const answer = JSON.parse(res.content) as { recommendation: string; departureReason: null; variants: Array<{ id: string }> };
    expect([answer.recommendation, answer.departureReason, answer.variants.map((v) => v.id)]).toEqual(['v2', null, ['v1', 'v2']]);
  });
});
