// Reconciliations (DEV-1375, spec 5.4.5): the draft agrees with itself and
// with Kairon. Draws equal the need, only the asked cells and draws changed,
// the profit bridge closes, every debt is repaid at the exit.

import { describe, expect, it } from 'vitest';
import { diffVariant } from '../kairon/diff.js';
import { applyPatch, type EvaluateBody } from '../kairon/patch.js';
import { reconcile } from '../kairon/reconcile.js';
import { fixtureDoc, readStage5 } from './_helpers/kaironFake.js';

const CZK = { decimals: 2, currencyCode: 'CZK' };
const CEDAR_SOURCE = '7c1962e8-a12d-42ca-82cc-4bea10338044';
const active = readStage5('eval-active.json');
const parentBody = applyPatch(fixtureDoc, { name: 'active' });

function inputFor(file: string, askedLineCodes: string[], askedDrawSourceIds: string[]) {
  const draftBody = readStage5(`${file}.body.json`) as EvaluateBody;
  const draftEval = readStage5(`${file}.eval.json`);
  const diff = diffVariant({
    currency: CZK,
    closedThrough: '2026-08',
    derivedLineCodes: [],
    activePlan: parentBody.plan,
    variantPlan: draftBody.plan,
    activeEval: active,
    variantEval: draftEval,
  });
  return { parentBody, draftBody, draftEval, diff, askedLineCodes, askedDrawSourceIds, currency: CZK };
}

describe('kairon reconcile', () => {
  it('passes all four for construction +8 % asked on D5 and D8', () => {
    // SCENARIO: scenario 2 v1, the server-built cost change
    // INPUT: s2-v1 body and eval against the active body; asked lines D5, D8
    // EXPECTED: 4 × ok in key order; the repayment text names the exit month and the 3 sources
    const out = reconcile(inputFor('s2-v1', ['D5', 'D8'], []));
    expect(out.map((r) => [r.key, r.ok])).toEqual([
      ['drawsEqualNeed', true],
      ['onlyAsked', true],
      ['bridgeCloses', true],
      ['repaidAtExit', true],
    ]);
    expect(out[3]?.text).toBe('Тело долга погашено при выходе 2028-07 у всех 3 источников, списаний 0.');
  });

  it('names a changed line the request did not ask for', () => {
    // SCENARIO: the same draft, but only D5 was asked
    // INPUT: asked lines ['D5']
    // EXPECTED: onlyAsked false; the text names D8
    const only = reconcile(inputFor('s2-v1', ['D5'], [])).find((r) => r.key === 'onlyAsked');
    expect(only?.ok).toBe(false);
    expect(only?.text).toBe('Изменено вне запроса: D8.');
  });

  it('passes all four for the Cedar cover asked on the Cedar source', () => {
    // SCENARIO: the cover goal pins Cedar's draws to the need for 6 months
    // INPUT: cover-cedar body and eval against the active body; asked draw source = Cedar
    // EXPECTED: 4 × ok; onlyAsked counts 6 draws and no plan cell
    const out = reconcile(inputFor('cover-cedar', [], [CEDAR_SOURCE]));
    expect(out.map((r) => r.ok)).toEqual([true, true, true, true]);
    expect(out[1]?.text).toBe('Изменено только заказанное: 6 траншей.');
  });

  it('flags draws to a source the request did not name', () => {
    // SCENARIO: the cover's draws checked against an empty asked-source list
    // INPUT: cover-cedar, askedDrawSourceIds []
    // EXPECTED: onlyAsked false, naming the Cedar source id
    const only = reconcile(inputFor('cover-cedar', [], [])).find((r) => r.key === 'onlyAsked');
    expect(only?.ok).toBe(false);
    expect(only?.text).toBe(`Изменено вне запроса: транши ${CEDAR_SOURCE}.`);
  });
});
