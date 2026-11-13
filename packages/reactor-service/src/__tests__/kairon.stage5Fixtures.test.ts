// Stage 5 fixtures (DEV-1375): the recorded Rivergate evaluates behind spec
// section 5.7 (construction +8 %) and the Cedar cover goal, and the fake API
// that serves them by body.

import { describe, expect, it } from 'vitest';
import { formatMillions, summarizeEvaluation } from '../kairon/summary.js';
import { applyPatch } from '../kairon/patch.js';
import { fakeKaironApi, fixtureDoc, readStage5, RIVERGATE_PARTNERS, stage5Evaluate } from './_helpers/kaironFake.js';

describe('stage 5 fixtures', () => {
  it('records the numbers the spec quotes for scenario 2 and the cover goal', () => {
    // SCENARIO: the recorded fixtures match the 13.11 probes behind spec section 5.7
    // INPUT: stage5 eval files through summarizeEvaluation
    // EXPECTED: net profit and IRR per the spec table; cover moves Solstice to 0 in the window
    const m = (f: string) => summarizeEvaluation(readStage5(f));
    expect(formatMillions(m('s2-v1.eval.json').netProfitMinor, 2, 'CZK')).toBe('333,4 млн CZK');
    expect(formatMillions(m('s2-v4.eval.json').netProfitMinor, 2, 'CZK')).toBe('387,0 млн CZK');
    expect(m('s2-v1.eval.json').partners.map((p) => (p.irr ?? 0).toFixed(4))).toEqual(['0.2071', '0.2357']);
    expect(m('s2-bank60.eval.json')).toEqual({ ...m('s2-v1.eval.json'), versionId: m('s2-bank60.eval.json').versionId });
    expect(m('cover-cedar.eval.json').partners.map((p) => (p.irr ?? 0).toFixed(4))).toEqual(['0.2383', '0.2696']);
  });

  it('serves a recorded evaluate for a body built from the stage 4 fixture document', () => {
    // SCENARIO: tests build bodies from fixtureDoc, whose key order differs from the live API's
    // INPUT: construction +8 % applied to fixtureDoc; an unrecorded body
    // EXPECTED: s2-v1.eval.json for the first; an 'unrecorded body' error for the second
    const body = applyPatch(fixtureDoc, {
      name: 'scenario',
      scale: [{ lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 }],
    });
    expect(stage5Evaluate('solstice-forecast-3', body)).toEqual({ status: 200, json: readStage5('s2-v1.eval.json') });
    expect(stage5Evaluate('solstice-forecast-3', {})).toEqual({ status: 200, json: readStage5('eval-active.json') });
    expect(() => stage5Evaluate('solstice-forecast-3', { plan: fixtureDoc.plan, draws: [] })).toThrow('unrecorded body');
  });

  it('returns the partners on getProject when asked', async () => {
    // SCENARIO: stage 5 reads settings.funding.partners from the project
    // INPUT: fakeKaironApi with and without { partners: true }
    // EXPECTED: the recorded partners with their shares; absent without the option
    const withPartners = await fakeKaironApi(stage5Evaluate, { partners: true }).getProject();
    const without = await fakeKaironApi(stage5Evaluate).getProject();
    expect(RIVERGATE_PARTNERS).toEqual([
      { partnerId: 'solstice', name: 'Solstice Sponsor', sharePct: 0.3 },
      { partnerId: 'cedar', name: 'Cedar Partners', sharePct: 0.7 },
    ]);
    expect(withPartners).toEqual({ ...without, settings: (readStage5('project.json') as { settings: unknown }).settings });
    expect('settings' in without).toBe(false);
  });
});
