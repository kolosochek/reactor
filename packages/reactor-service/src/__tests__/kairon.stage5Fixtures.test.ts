// Stage 5 fixtures (DEV-1375): the recorded Rivergate evaluates behind spec
// section 5.7 (construction +8 %) and the Cedar cover goal, and the fake API
// that serves them by body.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

describe('the stage 5 demo session recording (DEV-1381)', () => {
  const LIMIT_PER_DRAFT = 100 * 1024;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

  it('holds no widget data and each draft\'s instances once, within 100 KB per draft', () => {
    // SCENARIO: with 14 widgets a run added up to 2.8 MB to a recording; the trace now writes the instances
    //           once, in run.done, and widget data as byte counts
    // INPUT: demo-session.ndjson, recorded with the sample model on the widgets build with cash-line version 2 (DEV-1388)
    // EXPECTED: 12 runs; no widgetData key; no full instance outside the output of run.done; 114 instances for
    //           9 drafts, all of one build; no draft over 100 KB
    const file = fileURLToPath(new URL('./fixtures/kairon/stage5/demo-session.ndjson', import.meta.url));
    const events = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { type: string; payload: unknown });
    let widgetDataKeys = 0;
    let fullOutsideRunDone = 0;
    const drafts: Array<{ bytes: number; count: number }> = [];
    const builds = new Set<unknown>();
    const walk = (value: unknown, inRunDoneOutput: boolean): void => {
      if (Array.isArray(value)) return value.forEach((item) => walk(item, inRunDoneOutput));
      if (!isRecord(value)) return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'widgetData' && isRecord(child)) widgetDataKeys += 1;
        if (key === 'instances' && isRecord(child) && 'widgets' in value) {
          for (const list of Object.values(child)) {
            const full = (list as Array<Record<string, unknown>>).filter((instance) => 'data' in instance);
            if (!inRunDoneOutput) fullOutsideRunDone += full.length;
            if (inRunDoneOutput && full.length > 0) drafts.push({ bytes: bytes(full), count: full.length });
            if (inRunDoneOutput) full.forEach((instance) => builds.add(instance['buildId']));
          }
          continue;
        }
        walk(child, inRunDoneOutput);
      }
    };
    for (const event of events) {
      const solution = event.type === 'run.done' && isRecord(event.payload) && isRecord(event.payload['solution']) ? event.payload['solution'] : null;
      if (solution === null) {
        walk(event.payload, false);
        continue;
      }
      const { output, ...rest } = solution;
      walk(rest, false);
      walk(output, true);
    }
    expect({
      runs: events.filter((event) => event.type === 'run.done').length,
      widgetDataKeys,
      fullOutsideRunDone,
      drafts: drafts.length,
      instances: drafts.reduce((sum, draft) => sum + draft.count, 0),
      builds: [...builds],
      overLimit: drafts.filter((draft) => draft.bytes > LIMIT_PER_DRAFT).map((draft) => draft.bytes),
    }).toEqual({ runs: 12, widgetDataKeys: 0, fullOutsideRunDone: 0, drafts: 9, instances: 114, builds: ['2026-11-15T12:23:27.706Z'], overLimit: [] });
  });

  it('gives no draft milestones of its own and names no undated milestone', () => {
    // SCENARIO: no patch op moves a milestone, so a draft states none and the package says the shift is unknown;
    //           Rivergate's 10 milestones all have a due date (review I1, M1)
    // INPUT: demo-session.ndjson
    // EXPECTED: 3 milestone-band instances, each with 0 draft milestones and the active version's 10; the 5 runs
    //           that scored drafts name no undated milestone
    const file = fileURLToPath(new URL('./fixtures/kairon/stage5/demo-session.ndjson', import.meta.url));
    const outputs = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { type: string; payload: { solution?: { output?: Record<string, unknown> } } })
      .filter((event) => event.type === 'run.done')
      .map((event) => event.payload.solution?.output ?? {});
    const bands = outputs.flatMap((output) => {
      const widgets = output['widgets'] as { instances?: Record<string, Array<{ widget: string; data: { milestones: unknown[]; baselineMilestones: unknown[] } }>> } | undefined;
      return Object.values(widgets?.instances ?? {})
        .flat()
        .filter((instance) => instance.widget === 'milestone-band')
        .map((instance) => [instance.data.milestones.length, instance.data.baselineMilestones.length]);
    });
    const undated = outputs.flatMap((output) => (isRecord(output['scored']) ? [output['scored']['undatedMilestones']] : []));
    expect([bands, undated]).toEqual([
      [
        [0, 10],
        [0, 10],
        [0, 10],
      ],
      [[], [], [], [], []],
    ]);
  });

  it('holds cash-line at version 2, the active forecast in slot 0 and a draft in slot 1', () => {
    // SCENARIO: cash-line version 2 carries series { subject, slot, read, points }; the reactor sets no slot (DEV-1388)
    // INPUT: demo-session.ndjson
    // EXPECTED: 8 cash-line instances at version 2, every series loaded, no other series; 7 drafts of the active
    //           forecast as [draft 1, active 0] and the one child draft v1.1 as [draft 1, v1 1]
    const file = fileURLToPath(new URL('./fixtures/kairon/stage5/demo-session.ndjson', import.meta.url));
    type Series = { subject: { id: string }; slot: number; read: string };
    type Cash = { widget: string; version: number; data: { current: Series; baseline: Series[]; others: Series[] } };
    const cash = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { type: string; payload: { solution?: { output?: { widgets?: { instances?: Record<string, Cash[]> } } } } })
      .filter((event) => event.type === 'run.done')
      .flatMap((event) => Object.values(event.payload.solution?.output?.widgets?.instances ?? {}).flat())
      .filter((instance) => instance.widget === 'cash-line');
    const pair = (instance: Cash) => [instance.data.current, ...instance.data.baseline].map((series) => `${series.subject.id} ${series.slot}`).join(', ');
    expect({
      versions: [...new Set(cash.map((instance) => instance.version))],
      reads: [...new Set(cash.flatMap((instance) => [instance.data.current, ...instance.data.baseline].map((series) => series.read)))],
      others: cash.reduce((sum, instance) => sum + instance.data.others.length, 0),
      pairs: cash.map(pair),
    }).toEqual({
      versions: [2],
      reads: ['loaded'],
      others: 0,
      pairs: ['v1 1, active 0', 'v2 1, active 0', 'v3 1, active 0', 'v1 1, active 0', 'v2 1, active 0', 'v3 1, active 0', 'v4 1, active 0', 'v1.1 1, v1 1'],
    });
  });
});
