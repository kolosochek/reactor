// Red lines (DEV-1375): the 7 lines a draft must not cross, each with the
// parent's status beside it, so a breach the parent already had is told apart
// from a breach the draft adds.

import { describe, expect, it } from 'vitest';
import { parityToleranceMinor, redLines } from '../kairon/redLines.js';
import { summarizeEvaluation } from '../kairon/summary.js';
import { readStage5, RIVERGATE_PARTNERS } from './_helpers/kaironFake.js';

const CZK = { decimals: 2, currencyCode: 'CZK' };
const active = readStage5('eval-active.json');
const approved = summarizeEvaluation(readStage5('eval-approved.json'));
const input = {
  approved,
  partners: RIVERGATE_PARTNERS,
  irrPartnerIds: null,
  parentEval: active,
  draftEval: readStage5('s2-v1.eval.json'),
  currency: CZK,
};

describe('kairon redLines', () => {
  it('keeps scenario 2 v1 inside every new red line', () => {
    // SCENARIO: construction +8 %; partners were over their frames already
    // INPUT: parent eval-active, draft s2-v1.eval
    // EXPECTED: statuses [ok, breach, breach, ok, ok, unchecked, unchecked]; both frames already breached in the base
    const lines = redLines(input);
    expect(lines.map((l) => [l.key, l.status, l.baseStatus])).toEqual([
      ['cashGap', 'ok', 'ok'],
      ['frame.solstice', 'breach', 'breach'],
      ['frame.cedar', 'breach', 'breach'],
      ['parity', 'ok', 'ok'],
      ['irr', 'ok', 'ok'],
      ['ltc', 'unchecked', 'unchecked'],
      ['ltv', 'unchecked', 'unchecked'],
    ]);
  });

  it('draws the frame bar from partnerFrames as served', () => {
    // SCENARIO: Solstice's frame row for construction +8 %
    // INPUT: parent eval-active, draft s2-v1.eval
    // EXPECTED: track = planned frame 87,21 млн; fill = draft allocated; tick = parent allocated 307,98 млн; text from served headroom
    const frame = redLines(input).find((l) => l.key === 'frame.solstice');
    const draftAllocated = summarizeEvaluation(readStage5('s2-v1.eval.json')).partnerAllocatedMinor.solstice;
    expect(frame?.bar).toEqual({ trackMinor: '8721000000', fillMinor: draftAllocated, tickMinor: '30798138449' });
    expect(frame?.label).toBe('Рамка партнёра Solstice Sponsor');
    expect(frame?.source).toBe('partnerFrames[solstice].headroomMinor');
  });

  it('warns when Cedar covers everything for six months', () => {
    // SCENARIO: the cover goal moves Solstice's share onto Cedar
    // INPUT: parent eval-active, draft cover-cedar.eval
    // EXPECTED: parity warn; text names Cedar, Solstice, 33,1 млн CZK and 2026-10; the series starts at Cedar's 2026-10 gap
    const parity = redLines({ ...input, draftEval: readStage5('cover-cedar.eval.json') }).find((l) => l.key === 'parity');
    expect(parity?.status).toBe('warn');
    expect(parity?.baseStatus).toBe('ok');
    expect(parity?.text).toBe('Cedar Partners обгоняет Solstice Sponsor сверх своей доли на 33,1 млн CZK с 2026-10');
    expect(parity?.series?.slice(0, 2)).toEqual([
      { month: '2026-10', minor: '267846617' },
      { month: '2026-11', minor: '1145742283' },
    ]);
  });

  it('checks only the partners an IRR floor names', () => {
    // SCENARIO: irr_floor for Solstice only, a draft that keeps Solstice above the promise
    // INPUT: irrPartnerIds ['solstice'], draft s2-v1
    // EXPECTED: irr ok; the text names Solstice only
    const irr = redLines({ ...input, irrPartnerIds: ['solstice'] }).find((l) => l.key === 'irr');
    expect(irr?.status).toBe('ok');
    expect(irr?.text).toBe('Solstice Sponsor 20,71 % при обещании 18,91 %');
  });

  it('sets the parity tolerance at 1 million in major units', () => {
    // SCENARIO: CZK has 2 decimals
    // INPUT: 2
    // EXPECTED: 100 000 000 minor units
    expect(parityToleranceMinor(2)).toBe(100_000_000n);
  });
});
