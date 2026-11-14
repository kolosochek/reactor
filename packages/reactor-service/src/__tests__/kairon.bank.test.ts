// What an evaluate says about the senior bank (DEV-1377): its limit, what it has drawn, what it draws
// in the open months and whether Kairon's funding rule can start it. The facts feed the answers;
// the note tells the user why a funding plan shows no bank.

import { describe, expect, it } from 'vitest';
import { bankFacts, bankNote, bankOf } from '../kairon/bank.js';
import { readStage5 } from './_helpers/kaironFake.js';

const CZK = { decimals: 2, currencyCode: 'CZK' };
const BANK_ID = 'da6b7d98-53b3-41e9-b554-06ba4064df94';
const active = readStage5('eval-active.json') as {
  draws: Array<{ sourceId: string; period: string; amountMinor: string; provenance: string }>;
  walk: { sources: Array<Record<string, unknown>> };
  fundingShares: Record<string, unknown>;
};

describe('kairon bank state', () => {
  it('reads the bank of the active Rivergate forecast: a limit, a drawn part and no start', () => {
    // SCENARIO: Rivergate's bank states no «Available from» and «Forecast v3» pins no tranche, so the rule never starts it
    // INPUT: stage5/eval-active.json, closed through 2026-08
    // EXPECTED: limit 100 300 000 000, drawn 9 742 775 579, free 90 557 224 421, 0 in the open months, no first draw,
    //           no availability date, the project's target of 30 % equity and a final mix of 10,74 % bank
    expect(bankOf(active, '2026-08')).toEqual({
      sourceId: BANK_ID,
      name: 'Bank Financing',
      limitMinor: '100300000000',
      drawnMinor: '9742775579',
      freeMinor: '90557224421',
      openDrawsMinor: '0',
      firstDrawMonth: null,
      availableFrom: null,
      targetEquityShareBp: 3000,
      finalBankShareBp: 1074,
    });
  });

  it('sums the tranches the bank draws after the close and names the first month', () => {
    // SCENARIO: the same evaluate with two bank tranches after the close and the first draw month Kairon reports
    // INPUT: bank draws 1 771 000 000 in 2026-11 and 2 543 000 000 in 2026-12; one bank draw in the closed 2026-08
    // EXPECTED: 4 314 000 000 in the open months (the closed draw is not counted), first draw 2026-11
    const withBank = {
      ...active,
      draws: [
        ...active.draws,
        { sourceId: BANK_ID, period: '2026-08-01', amountMinor: '500000000', provenance: 'pinned' },
        { sourceId: BANK_ID, period: '2026-11-01', amountMinor: '1771000000', provenance: 'proposed' },
        { sourceId: BANK_ID, period: '2026-12-01', amountMinor: '2543000000', provenance: 'proposed' },
      ],
      fundingShares: { ...active.fundingShares, bankFirstDrawMonth: '2026-11' },
    };
    const bank = bankOf(withBank, '2026-08');
    expect([bank?.openDrawsMinor, bank?.firstDrawMonth]).toEqual(['4314000000', '2026-11']);
  });

  it('reads no bank when the evaluate has no bank source', () => {
    // SCENARIO: a project funded by its partners only
    // INPUT: the active evaluate without its bank source
    // EXPECTED: null
    const partnersOnly = { ...active, walk: { ...active.walk, sources: active.walk.sources.filter((s) => s.kind !== 'bank') } };
    expect(bankOf(partnersOnly, '2026-08')).toBeNull();
  });
});

describe('kairon bank facts and note', () => {
  it('states the bank as facts for the answers', () => {
    // SCENARIO: «А где банк в этом плане финансирования?» needs figures the LLM can cite by placeholder
    // INPUT: the bank of the active Rivergate forecast under the key «active»
    // EXPECTED: limit 1 003,0, drawn 97,4, free 905,6, 0,0 in the open months, start «не задан», shares 10,74 % against 70,00 %
    const bank = bankOf(active, '2026-08');
    expect(bank === null ? null : bankFacts(CZK, 'active', bank)).toEqual({
      'active.bank.limit': '1 003,0 млн CZK',
      'active.bank.drawn': '97,4 млн CZK',
      'active.bank.free': '905,6 млн CZK',
      'active.bank.openDraws': '0,0 млн CZK',
      'active.bank.start': 'не задан',
      'active.bank.share': '10,74 %',
      'active.bank.targetShare': '70,00 %',
    });
  });

  it('says why a funding plan shows no bank when the bank has no start', () => {
    // SCENARIO: the owner asked why the bank is missing from the funding plan (14.11.2026)
    // INPUT: the bank of the active Rivergate forecast: no «Available from», no tranche after the close
    // EXPECTED: one sentence naming both missing starts and what the rule does without them, then the three figures
    const bank = bankOf(active, '2026-08');
    expect(bank === null ? null : bankNote(bank, CZK)).toBe(
      'Банк «Bank Financing» в открытых месяцах не выбирается: в Kairon у него нет даты «Доступен с» и нет закреплённого транша, а без старта правило финансирования отдаёт всю потребность партнёрам. Лимит 1 003,0 млн CZK, выбрано 97,4 млн CZK, свободно 905,6 млн CZK.',
    );
  });

  it('says nothing about a bank that draws in the open months', () => {
    // SCENARIO: the bank participates, so there is nothing to explain
    // INPUT: the bank with 4 314 000 000 drawn after the close from 2026-11
    // EXPECTED: null
    const bank = bankOf(active, '2026-08');
    expect(bank === null ? 'no bank' : bankNote({ ...bank, openDrawsMinor: '4314000000', firstDrawMonth: '2026-11' }, CZK)).toBeNull();
  });

  it('states a plain fact when a bank with an availability date draws nothing', () => {
    // SCENARIO: the bank has a start and the rule still gives it nothing; the cause is not known here, so none is claimed
    // INPUT: the bank with «Available from» 2026-01-01 and 0 after the close
    // EXPECTED: the sentence without a cause, with the three figures
    const bank = bankOf(active, '2026-08');
    expect(bank === null ? null : bankNote({ ...bank, availableFrom: '2026-01-01' }, CZK)).toBe(
      'Банк «Bank Financing» в открытых месяцах траншей не получает. Лимит 1 003,0 млн CZK, выбрано 97,4 млн CZK, свободно 905,6 млн CZK.',
    );
  });
});
