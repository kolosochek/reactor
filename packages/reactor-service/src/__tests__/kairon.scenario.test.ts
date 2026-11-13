// Structured scenario (DEV-1375): a stated change such as «стройка +8 %» is
// built by the server from the LLM's structuring answer and applied outside the
// ±3 % lever bounds.

import { describe, expect, it } from 'vitest';
import { applyScenario, type ScenarioSpec } from '../kairon/scenario.js';
import { fixtureDoc, readStage5 } from './_helpers/kaironFake.js';

const RULES = { closedThrough: '2026-08', derivedLineCodes: [] as string[] };

function spec(override: Partial<Extract<ScenarioSpec, { type: 'cost_change' }>>): ScenarioSpec {
  return { type: 'cost_change', lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000, ...override };
}

describe('kairon applyScenario', () => {
  it('builds construction +8 % exactly as the recorded body', () => {
    // SCENARIO: «Стройка дорожает на 8 % с 2026-09», structured by the LLM step
    // INPUT: cost_change D5, D8, 2026-09, 1 080 000 ppm on fixtureDoc
    // EXPECTED: no errors; the plan equals s2-v1.body.json's plan; ops is the scale op
    const out = applyScenario(fixtureDoc, RULES, spec({}));
    expect(out.errors).toEqual([]);
    expect(out.doc.plan).toEqual((readStage5('s2-v1.body.json') as { plan: unknown }).plan);
    expect(out.ops).toEqual({
      name: 'scenario',
      scale: [{ lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 }],
    });
  });

  it('refuses a closed month, an unknown code and a line with nothing to change', () => {
    // SCENARIO: bad structuring output
    // INPUT: fromMonth 2026-08; code ZZ; R10 (no open cells)
    // EXPECTED: one error each, naming the month or the code
    expect(applyScenario(fixtureDoc, RULES, spec({ fromMonth: '2026-08' })).errors).toEqual([
      '2026-08: closed through 2026-08; the scenario starts at 2026-09 or later',
    ]);
    expect(applyScenario(fixtureDoc, RULES, spec({ lineCodes: ['ZZ'] })).errors).toEqual(['ZZ: unknown line code']);
    expect(applyScenario(fixtureDoc, RULES, spec({ lineCodes: ['R10'] })).errors).toEqual([
      'R10: no cell from 2026-09 to change',
    ]);
  });

  it('refuses a line the server derives', () => {
    // SCENARIO: the LLM names an interest line that Kairon derives
    // INPUT: lineCodes F2 with derivedLineCodes ['F2']
    // EXPECTED: the derived-line error; the doc is returned unchanged with ops null
    const out = applyScenario(fixtureDoc, { ...RULES, derivedLineCodes: ['F2'] }, spec({ lineCodes: ['F2'] }));
    expect(out).toEqual({ doc: fixtureDoc, ops: null, errors: ['F2: the server derives this line'] });
  });

  it('leaves a free scenario to the LLM', () => {
    // SCENARIO: the stage 4 kolaudace phrase is not a cost change
    // INPUT: {type: 'free'}
    // EXPECTED: doc unchanged, ops null, no errors
    expect(applyScenario(fixtureDoc, RULES, { type: 'free' })).toEqual({ doc: fixtureDoc, ops: null, errors: [] });
  });
});
