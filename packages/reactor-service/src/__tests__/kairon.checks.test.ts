// Patch checks before a variant is sent to Kairon evaluate (DEV-1364):
// closed-month writes, derived-line writes, unknown lines, lever bounds and
// the month-range fit.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkPatch, patchOpCount, runningCost } from '../kairon/checks.js';
import { ForecastPatchSchema, type ForecastDocument } from '../kairon/patch.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kairon');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const doc = readJson(join(FIXTURES, 'forecast-document.active.json')) as ForecastDocument;
const rules = { closedThrough: '2026-08', derivedLineCodes: [] as string[] };

describe('kairon checkPatch', () => {
  it('accepts the recorded delay-3 patch and returns the golden body', () => {
    // SCENARIO: a patch the server accepted in the discovery run
    // INPUT: patches/patch-delay-3.json, closed through 2026-08, no derived lines
    // EXPECTED: no errors, no adjustments, body equal to bodies/body-delay-3.json
    const patch = ForecastPatchSchema.parse(readJson(join(FIXTURES, 'patches', 'patch-delay-3.json')));
    const result = checkPatch(doc, rules, patch);
    expect(result.errors).toEqual([]);
    expect(result.adjustments).toEqual([]);
    expect(result.body).toEqual(readJson(join(FIXTURES, 'bodies', 'body-delay-3.json')));
  });

  it('refuses a write into a closed month', () => {
    // SCENARIO: the LLM shifts R1 starting inside the closed period
    // INPUT: shift R1 from 2026-07 by 3 months, closed through 2026-08
    // EXPECTED: one error naming R1 and the closed month; no body
    const patch = ForecastPatchSchema.parse({
      name: 'v1',
      shift: [{ lineCodes: ['R1'], fromMonth: '2026-07', byMonths: 3 }],
      monthRangeTo: '2028-10',
    });
    const result = checkPatch(doc, rules, patch);
    expect(result.errors).toEqual([
      'R1: the patch changes closed months 2026-07, 2026-08 (closed through 2026-08); start the change at 2026-09 or later',
    ]);
    expect(result.body).toBeNull();
  });

  it('refuses a write into a line the server derives', () => {
    // SCENARIO: a project where F2 is derived; the LLM extends it
    // INPUT: extend F2 by 3 months, derivedLineCodes ["F2"]
    // EXPECTED: one error naming F2 as derived; no body
    const patch = ForecastPatchSchema.parse({
      name: 'v1',
      extend: [{ lineCodes: ['F2'], months: 3 }],
      monthRangeTo: '2028-10',
    });
    const result = checkPatch(doc, { closedThrough: '2026-08', derivedLineCodes: ['F2'] }, patch);
    expect(result.errors).toEqual(['F2: the server derives this line; leave it out of the patch']);
    expect(result.body).toBeNull();
  });

  it('reports an unknown line as an error instead of throwing', () => {
    // SCENARIO: the LLM invents a line code
    // INPUT: scale on line "Z9"
    // EXPECTED: one error "Z9: unknown line code"; no body
    const patch = ForecastPatchSchema.parse({
      name: 'v1',
      scale: [{ lineCodes: ['Z9'], fromMonth: '2028-01', factorPpm: 1_010_000 }],
    });
    const result = checkPatch(doc, rules, patch);
    expect(result.errors).toEqual(['Z9: unknown line code']);
    expect(result.body).toBeNull();
  });

  it('refuses a price change outside plus or minus 3 %', () => {
    // SCENARIO: the LLM raises prices by 5 %
    // INPUT: scale R1 from 2028-03 with factorPpm 1 050 000
    // EXPECTED: one error about the scale bound; no body
    const patch = ForecastPatchSchema.parse({
      name: 'v1',
      scale: [{ lineCodes: ['R1'], fromMonth: '2028-03', factorPpm: 1_050_000 }],
    });
    const result = checkPatch(doc, rules, patch);
    expect(result.errors).toEqual(['scale: factorPpm 1050000 is outside 970000..1030000 (at most 3 % either way)']);
    expect(result.body).toBeNull();
  });

  it('refuses a patch that changes nothing', () => {
    // SCENARIO: an LLM returns an empty patch; scored, it would look like the undelayed forecast
    // INPUT: { name: "v1" } and a shift of a line with no cells in the window
    // EXPECTED: one "changes nothing" error each; no body
    const empty = checkPatch(doc, rules, ForecastPatchSchema.parse({ name: 'v1' }));
    const idle = checkPatch(
      doc,
      rules,
      ForecastPatchSchema.parse({ name: 'v1', shift: [{ lineCodes: ['A1'], fromMonth: '2027-01', byMonths: 2 }] }),
    );
    const expected = ['the patch changes nothing: no cell, no monthRangeTo and no shareTarget differ from the forecast'];
    expect(empty.errors).toEqual(expected);
    expect(empty.body).toBeNull();
    expect(idle.errors).toEqual(expected);
    expect(idle.body).toBeNull();
  });

  it('refuses extend on a revenue line', () => {
    // SCENARIO: the live run of 13.11 extended R4 «Land, front gardens» and invented 3 months of income
    // INPUT: the delay-3 patch with R4 moved from shift to extend (last open cell +3 863 656)
    // EXPECTED: one error naming R4; the running costs pass; no body
    const delay3 = readJson(join(FIXTURES, 'patches', 'patch-delay-3.json')) as object;
    const patch = ForecastPatchSchema.parse({
      ...delay3,
      shift: [{ lineCodes: ['R1', 'C1', 'C2', 'O4', 'U2', 'F7'], fromMonth: '2028-03', byMonths: 3 }],
      extend: [{ lineCodes: ['O3', 'O5', 'F1', 'F2', 'F3', 'R4'], months: 3 }],
    });
    const result = checkPatch(doc, rules, patch);
    expect(result.errors).toEqual([
      'R4: extend repeats the last monthly revenue and invents income; move revenue with shift',
    ]);
    expect(result.body).toBeNull();
  });

  it('refuses a delay that leaves running overheads ending where they did', () => {
    // SCENARIO: the live run of 13.11 moved the plan end by 3 months and left O3 and O5 ending 2028-03
    // INPUT: the delay-3 patch with O3 and O5 dropped from extend; plan end 2028-07 -> 2028-10
    // EXPECTED: one error each for O3 and O5 with the monthly amount and the old end; no body
    const patch = ForecastPatchSchema.parse({
      ...(readJson(join(FIXTURES, 'patches', 'patch-delay-3.json')) as object),
      extend: [{ lineCodes: ['F1', 'F2', 'F3'], months: 3 }],
    });
    const result = checkPatch(doc, rules, patch);
    expect(result.errors).toEqual([
      'O3: runs at -4953630 a month and still ends 2028-03, while the plan now ends 3 months later (2028-10); move it with the delay: extend, stretch or shift',
      'O5: runs at -84174990 a month and still ends 2028-03, while the plan now ends 3 months later (2028-10); move it with the delay: extend, stretch or shift',
    ]);
    expect(result.body).toBeNull();
  });

  it('refuses a delay that leaves typed interest ending where it did', () => {
    // SCENARIO: the owner's rule of 13.11: a delay keeps the loans 3 months longer, so typed interest runs longer
    // INPUT: the delay-3 patch with F2 and F3 dropped from extend; no derived lines
    // EXPECTED: one error each for F2 and F3; no body
    const patch = ForecastPatchSchema.parse({
      ...(readJson(join(FIXTURES, 'patches', 'patch-delay-3.json')) as object),
      extend: [{ lineCodes: ['O3', 'O5', 'F1'], months: 3 }],
    });
    const result = checkPatch(doc, rules, patch);
    expect(result.errors).toEqual([
      'F2: typed interest still ends 2028-07, while the plan now ends 3 months later (2028-10); the loans run until the exit: extend it',
      'F3: typed interest still ends 2028-07, while the plan now ends 3 months later (2028-10); the loans run until the exit: extend it',
    ]);
    expect(result.body).toBeNull();
  });

  it('does not ask to extend interest lines the server derives', () => {
    // SCENARIO: a project where Kairon derives F2 and F3 from the funding sources
    // INPUT: the delay-3 patch without F2/F3 in extend; derivedLineCodes ["F2", "F3"]
    // EXPECTED: no errors
    const patch = ForecastPatchSchema.parse({
      ...(readJson(join(FIXTURES, 'patches', 'patch-delay-3.json')) as object),
      extend: [{ lineCodes: ['O3', 'O5', 'F1'], months: 3 }],
    });
    expect(checkPatch(doc, { closedThrough: '2026-08', derivedLineCodes: ['F2', 'F3'] }, patch).errors).toEqual([]);
  });

  it('accepts a sales-only delay that keeps construction and fees as planned', () => {
    // SCENARIO: buyers take the units 3 months later; construction finishes on time; loans run until the exit
    // INPUT: shift R1, C1, C2 from 2028-03 by 3; extend the overheads O3, O5 and the interest F2, F3 by 3; monthRangeTo 2028-10
    // EXPECTED: no errors; D5, D8, F1 end 2028-07 as planned
    const patch = ForecastPatchSchema.parse({
      name: 'v1',
      shift: [{ lineCodes: ['R1', 'C1', 'C2'], fromMonth: '2028-03', byMonths: 3 }],
      extend: [{ lineCodes: ['O3', 'O5', 'F2', 'F3'], months: 3 }],
      monthRangeTo: '2028-10',
    });
    const result = checkPatch(doc, rules, patch);
    expect(result.errors).toEqual([]);
    expect(result.body?.plan.monthRange).toEqual({ from: '2024-12', to: '2028-10' });
  });

  it('stretches the month range to the last non-zero cell', () => {
    // SCENARIO: the LLM shifts the exit but forgets monthRangeTo
    // INPUT: shift R1 from 2028-03 by 3 months, extend O3/O5/F2/F3 by 2, no monthRangeTo (range ends 2028-07)
    // EXPECTED: no errors, one adjustment, body monthRange.to = 2028-09
    const patch = ForecastPatchSchema.parse({
      name: 'v1',
      shift: [{ lineCodes: ['R1'], fromMonth: '2028-03', byMonths: 3 }],
      extend: [{ lineCodes: ['O3', 'O5', 'F2', 'F3'], months: 2 }],
    });
    const result = checkPatch(doc, rules, patch);
    expect(result.errors).toEqual([]);
    expect(result.adjustments).toEqual(['monthRange.to moved 2028-07 -> 2028-09 to cover the last non-zero cell']);
    expect(result.body?.plan.monthRange).toEqual({ from: '2024-12', to: '2028-09' });
  });
});

describe('kairon runningCost', () => {
  it('finds a cost that repeats the same amount in its last three consecutive months', () => {
    // SCENARIO: which lines must move with a delay
    // INPUT: O5 open cells (-84 174 990 a month through 2028-03), R4 (revenue), F2 (interest that changes), U2 (gaps)
    // EXPECTED: O5 -> { monthlyMinor -84174990, lastMonth 2028-03 }; R4, F2 and U2 -> null
    const cells = (code: string) => doc.plan.lines.find((l) => l.code === code)?.monthlyForecast ?? {};
    expect(runningCost(cells('O5'))).toEqual({ monthlyMinor: '-84174990', lastMonth: '2028-03' });
    expect([runningCost(cells('R4')), runningCost(cells('F2')), runningCost(cells('U2'))]).toEqual([null, null, null]);
  });
});

describe('kairon patchOpCount', () => {
  it('counts every op entry, the month range and the share target', () => {
    // SCENARIO: DEV-1377, the lever count of a draft is the size of its own lever patch
    // INPUT: 1 stretch, 2 shifts, 1 extend, 1 scale, 2 set cells, monthRangeTo and shareTarget; then a patch with a name only
    // EXPECTED: 9; 0
    const patch = ForecastPatchSchema.parse({
      name: 'v2',
      stretch: [{ lineCodes: ['D5'], fromMonth: '2026-09', byMonths: 3 }],
      shift: [
        { lineCodes: ['R1'], fromMonth: '2026-09', byMonths: 3 },
        { lineCodes: ['R2'], fromMonth: '2026-09', byMonths: 3 },
      ],
      extend: [{ lineCodes: ['O3'], months: 3 }],
      scale: [{ lineCodes: ['R1'], fromMonth: '2026-09', factorPpm: 1_030_000 }],
      set: [
        { code: 'U2', month: '2026-11', amountMinor: '0' },
        { code: 'U2', month: '2027-06', amountMinor: '0' },
      ],
      monthRangeTo: '2028-10',
      shareTarget: { equityShareBp: 6000 },
    });
    expect(patchOpCount(patch)).toBe(9);
    expect(patchOpCount({ name: 'v1' })).toBe(0);
  });
});
