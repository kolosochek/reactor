// Golden tests for the forecast patch applier: the TypeScript port must
// reproduce every evaluate body the Python discovery applier wrote (DEV-1364).

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  applyPatch,
  floorDiv,
  ForecastPatchSchema,
  type ForecastDocument,
} from '../kairon/patch.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kairon');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const doc = readJson(join(FIXTURES, 'forecast-document.active.json')) as ForecastDocument;
const names = readdirSync(join(FIXTURES, 'patches'))
  .filter((f) => f.startsWith('patch-') && f.endsWith('.json'))
  .map((f) => f.slice('patch-'.length, -'.json'.length))
  .sort();

describe('kairon patch: date and integer helpers', () => {
  it('adds months across year boundaries in both directions', () => {
    // SCENARIO: month arithmetic used by every op
    // INPUT: 2028-11 + 3, 2028-03 - 3, 2024-12 + 0
    // EXPECTED: 2029-02, 2027-12, 2024-12
    expect(addMonths('2028-11', 3)).toBe('2029-02');
    expect(addMonths('2028-03', -3)).toBe('2027-12');
    expect(addMonths('2024-12', 0)).toBe('2024-12');
  });

  it('floors toward minus infinity like Python //', () => {
    // SCENARIO: scale on a negative cost cell must round like the Python applier
    // INPUT: -7 // 2, 7 // 2, -6 // 3
    // EXPECTED: -4, 3, -2
    expect(floorDiv(-7n, 2n)).toBe(-4n);
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(-6n, 3n)).toBe(-2n);
  });
});

describe('kairon patch: golden bodies from the discovery run', () => {
  it('finds all 15 recorded patches', () => {
    // SCENARIO: the fixture folder holds the whole recorded run
    // INPUT: fixtures/kairon/patches
    // EXPECTED: 15 patch names
    expect(names).toHaveLength(15);
  });

  it.each(names)('reproduces body-%s.json', (name) => {
    // SCENARIO: a recorded patch applied to Forecast v3
    // INPUT: forecast-document.active.json + patches/patch-<name>.json
    // EXPECTED: deep-equal to bodies/body-<name>.json written by apply_patch.py
    const patch = ForecastPatchSchema.parse(readJson(join(FIXTURES, 'patches', `patch-${name}.json`)));
    const expected = readJson(join(FIXTURES, 'bodies', `body-${name}.json`));
    expect(applyPatch(doc, patch)).toEqual(expected);
  });

  it('leaves the input document unchanged', () => {
    // SCENARIO: the document is re-used for every variant of a run
    // INPUT: the delay-6 patch applied once
    // EXPECTED: the document still equals a fresh read of the fixture
    const patch = ForecastPatchSchema.parse(readJson(join(FIXTURES, 'patches', 'patch-delay-6.json')));
    applyPatch(doc, patch);
    expect(doc).toEqual(readJson(join(FIXTURES, 'forecast-document.active.json')));
  });

  it('rejects a misspelled op key instead of dropping it', () => {
    // SCENARIO: an LLM writes "shifts" for "shift"; a dropped op would score the undelayed forecast
    // INPUT: { name: "v1", shifts: [...] } and a shift op with "toMonths"
    // EXPECTED: both fail with zod "unrecognized_keys" naming the bad key
    const top = ForecastPatchSchema.safeParse({
      name: 'v1',
      shifts: [{ lineCodes: ['R1'], fromMonth: '2028-03', byMonths: 3 }],
    });
    const inner = ForecastPatchSchema.safeParse({
      name: 'v1',
      shift: [{ lineCodes: ['R1'], fromMonth: '2028-03', toMonths: '2028-04', byMonths: 3 }],
    });
    expect(top.success ? [] : top.error.issues.map((i) => [i.code, 'keys' in i ? i.keys : []])).toEqual([
      ['unrecognized_keys', ['shifts']],
    ]);
    expect(inner.success ? [] : inner.error.issues.map((i) => [i.code, 'keys' in i ? i.keys : []])).toEqual([
      ['unrecognized_keys', ['toMonths']],
    ]);
  });

  it('refuses a patch naming a line the plan does not have', () => {
    // SCENARIO: an LLM invents a line code
    // INPUT: shift on line "Z9"
    // EXPECTED: Error "Unknown line code: Z9"
    const patch = ForecastPatchSchema.parse({
      name: 'bad',
      shift: [{ lineCodes: ['Z9'], fromMonth: '2028-01', byMonths: 1 }],
    });
    expect(() => applyPatch(doc, patch)).toThrow('Unknown line code: Z9');
  });
});
