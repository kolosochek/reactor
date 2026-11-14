// Draft lineage (DEV-1375, spec 5.2): a draft is the active forecast plus its
// scenario, its lever patch and its goal steps. The server replays the lineage
// on every message and on the save click, so the card and the saved version
// come from the same body.

import { describe, expect, it } from 'vitest';
import { checkPatch } from '../kairon/checks.js';
import { childId, planHash, replayLineage, type DraftLineage } from '../kairon/lineage.js';
import type { ManualDraw } from '../kairon/goals.js';
import { ForecastPatchSchema, type ForecastDocument } from '../kairon/patch.js';
import { fixtureDoc, readFixture, readStage5 } from './_helpers/kaironFake.js';

const RULES = { closedThrough: '2026-08', derivedLineCodes: [] as string[] };
const HASH = planHash(fixtureDoc);
const CONSTRUCTION = { type: 'cost_change' as const, lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 };
const COVER_GOAL = { type: 'funding_cover' as const, partnerId: 'cedar', fromMonth: '2026-09', months: 6 };
const coverDraws = (readStage5('cover-cedar.body.json') as { draws: ManualDraw[] }).draws;
const releaseU2 = ['2026-11', '2027-06', '2028-01', '2028-06'].map((month) => ({ code: 'U2', month, amountMinor: '0' }));

function lineage(over: Partial<DraftLineage>): DraftLineage {
  return { activePlanHash: HASH, scenario: { type: 'free' }, leverPatch: null, steps: [], ...over };
}

describe('kairon planHash', () => {
  it('ignores key order and server-owned keys', () => {
    // SCENARIO: the live API and the stage 4 fixture order keys differently; the fixture carries forecastTotalMinor
    // INPUT: fixtureDoc; the same plan with reversed keys, monthRange {to, from} and no forecastTotalMinor
    // EXPECTED: the same hash; a changed cell gives a different one
    const reordered: ForecastDocument = {
      plan: {
        monthRange: { to: fixtureDoc.plan.monthRange.to, from: fixtureDoc.plan.monthRange.from },
        lines: fixtureDoc.plan.lines.map(({ forecastTotalMinor: _dropped, ...line }) => ({
          monthlyForecast: line.monthlyForecast,
          groupCode: line.groupCode,
          name: line.name,
          code: line.code,
        })),
      },
    };
    expect(planHash(reordered)).toBe(HASH);
    expect(HASH).toHaveLength(64);
    const changed = structuredClone(fixtureDoc);
    const d5 = changed.plan.lines.find((l) => l.code === 'D5');
    if (d5 !== undefined) d5.monthlyForecast['2026-09'] = '1';
    expect(planHash(changed)).not.toBe(HASH);
  });
});

describe('kairon replayLineage', () => {
  it('replays scenario 2 v2 to the recorded body', () => {
    // SCENARIO: construction +8 % plus the U2 reserve release
    // INPUT: cost_change scenario, lever patch setting every open U2 cell to 0
    // EXPECTED: no errors; the body equals s2-v2.body.json
    const out = replayLineage(fixtureDoc, RULES, lineage({ scenario: CONSTRUCTION, leverPatch: { name: 'v2', set: releaseU2 } }));
    expect(out.errors).toEqual([]);
    expect(out.body).toEqual(readStage5('s2-v2.body.json'));
  });

  it('replays a stage 4 lever patch exactly as checkPatch scored it', () => {
    // SCENARIO: the saved draft must equal the scored body; checkPatch may adjust monthRange.to
    // INPUT: free scenario, patch-delay-3 as the lever patch
    // EXPECTED: the body equals bodies/body-delay-3.json and checkPatch's own body
    const patch = ForecastPatchSchema.parse(readFixture('patches/patch-delay-3.json'));
    const out = replayLineage(fixtureDoc, RULES, lineage({ leverPatch: patch }));
    expect(out).toEqual({ body: readFixture('bodies/body-delay-3.json'), errors: [] });
    expect(out.body).toEqual(checkPatch(fixtureDoc, RULES, patch).body);
  });

  it('appends a cover step as manual draws on the active forecast', () => {
    // SCENARIO: «Cedar покрывает все затраты 6 месяцев» on the active forecast
    // INPUT: free scenario, no levers, one cover step with the recorded draws
    // EXPECTED: the body equals cover-cedar.body.json
    const out = replayLineage(fixtureDoc, RULES, lineage({ steps: [{ type: 'cover', goal: COVER_GOAL, draws: coverDraws }] }));
    expect(out).toEqual({ body: readStage5('cover-cedar.body.json'), errors: [] });
  });

  it('lets a later cover draw replace an earlier one for the same source and month', () => {
    // SCENARIO: a second cover goal on a child draft re-pins October
    // INPUT: the recorded cover draws, then one draw for the same source and 2026-10 with 1 CZK
    // EXPECTED: 6 draws; October holds 100 minor in its original place
    const later: ManualDraw = { sourceId: '7c1962e8-a12d-42ca-82cc-4bea10338044', date: '2026-10-01', amountMinor: '100', origin: 'manual' };
    const out = replayLineage(
      fixtureDoc,
      RULES,
      lineage({
        steps: [
          { type: 'cover', goal: COVER_GOAL, draws: coverDraws },
          { type: 'cover', goal: COVER_GOAL, draws: [later] },
        ],
      }),
    );
    expect(out.body?.draws).toEqual([coverDraws[0], later, ...coverDraws.slice(2)]);
  });

  it('refuses a lever outside the ±3 % bound', () => {
    // SCENARIO: an LLM lever that scales prices by 5 %
    // INPUT: leverPatch scale R1 × 1 050 000 on top of construction +8 %
    // EXPECTED: no body; checkPatch's bound error
    const out = replayLineage(
      fixtureDoc,
      RULES,
      lineage({
        scenario: CONSTRUCTION,
        leverPatch: { name: 'v3', scale: [{ lineCodes: ['R1'], fromMonth: '2026-09', factorPpm: 1_050_000 }] },
      }),
    );
    expect(out).toEqual({
      body: null,
      errors: ['scale: factorPpm 1050000 is outside 970000..1030000 (at most 3 % either way)'],
    });
  });

  it('refuses a lineage built on another active forecast', () => {
    // SCENARIO: Review Focus 2, the active forecast changed between two messages
    // INPUT: activePlanHash 'stale'
    // EXPECTED: no body; the Russian refusal
    expect(replayLineage(fixtureDoc, RULES, lineage({ activePlanHash: 'stale' }))).toEqual({
      body: null,
      errors: ['Активный прогноз изменился, начните новый сценарий'],
    });
  });
});

describe('kairon staleness beyond the plan', () => {
  const shares = (solstice: number, cedar: number) => ({
    partners: [
      { id: 'solstice', name: 'Solstice Sponsor', sharePct: solstice },
      { id: 'cedar', name: 'Cedar Partners', sharePct: cedar },
    ],
  });
  const state: ForecastDocument = { ...fixtureDoc, fundingRevision: 3, fundingSettings: shares(0.3, 0.7) };
  const STALE = { body: null, errors: ['Активный прогноз изменился, начните новый сценарий'] };

  it('refuses a lineage when the funding section of the active version was saved since', () => {
    // SCENARIO: DEV-1377, someone saved the active version's draws between two messages; the plan did not change
    // INPUT: a lineage hashed on fundingRevision 3; replay on revision 4, then on revision 3
    // EXPECTED: stale on 4; replayed without errors on 3
    const built = lineage({ activePlanHash: planHash(state) });
    expect(replayLineage({ ...state, fundingRevision: 4 }, RULES, built)).toEqual(STALE);
    expect(replayLineage(state, RULES, built).errors).toEqual([]);
  });

  it('refuses a lineage when the project funding settings changed since', () => {
    // SCENARIO: DEV-1377, the partners' agreed shares moved from 30 / 70 to 40 / 60 between two messages
    // INPUT: a lineage hashed on shares 0.3 / 0.7; replay on 0.4 / 0.6; then on 0.3 / 0.7 with the keys in another order
    // EXPECTED: stale on the changed shares; key order alone does not make it stale
    const built = lineage({ activePlanHash: planHash(state) });
    expect(replayLineage({ ...state, fundingSettings: shares(0.4, 0.6) }, RULES, built)).toEqual(STALE);
    const reordered = { partners: shares(0.3, 0.7).partners.map((p) => ({ sharePct: p.sharePct, name: p.name, id: p.id })) };
    expect(replayLineage({ ...state, fundingSettings: reordered }, RULES, built).errors).toEqual([]);
  });

  it('reads a document without funding state as revision 0 and no settings', () => {
    // SCENARIO: the recorded stage 4 document carries only the plan
    // INPUT: fixtureDoc; the same with fundingRevision 0 and fundingSettings null
    // EXPECTED: the same hash
    expect(planHash({ ...fixtureDoc, fundingRevision: 0, fundingSettings: null })).toBe(HASH);
  });
});

describe('kairon childId', () => {
  it('numbers children under the root draft', () => {
    // SCENARIO: goals on v2, then on its child
    // INPUT: (v2, []), (v2.1, [v2.1]), (v2, [v2.1, v2.2])
    // EXPECTED: v2.1, v2.2, v2.3
    expect(childId('v2', [])).toBe('v2.1');
    expect(childId('v2.1', ['v2.1'])).toBe('v2.2');
    expect(childId('v2', ['v2.1', 'v2.2'])).toBe('v2.3');
  });
});
