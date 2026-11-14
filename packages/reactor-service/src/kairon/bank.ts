// packages/reactor-service/src/kairon/bank.ts
//
// What an evaluate says about the senior bank (DEV-1377): its limit, what it has drawn by the closed
// month, what it draws after it, and whether Kairon's funding rule can start it. Under the bank rule a
// senior bank starts at «Available from» or at its first pinned tranche; a bank that states neither
// never starts, and the rule gives the whole need to the partners (Kairon `bankStartMonthOf`).
// Nothing here plans a tranche: the figures are read off the evaluate.

import { z } from 'zod';
import { formatMillions, type CurrencyFormat } from './summary.js';

const BankEvalShape = z.object({
  draws: z.array(z.object({ sourceId: z.string(), period: z.string(), amountMinor: z.string() })).default([]),
  walk: z.object({
    sources: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        name: z.string(),
        limitMinor: z.string().nullable().optional(),
        availableFrom: z.string().nullable().optional(),
        principalMinor: z.record(z.string()),
      }),
    ),
  }),
  fundingShares: z
    .object({
      bankSourceIds: z.array(z.string()).default([]),
      bankFirstDrawMonth: z.string().nullable().optional(),
      targetEquityShareBp: z.number().nullable().optional(),
      mix: z.array(z.object({ bankShareBp: z.number().nullable() })).default([]),
    })
    .optional(),
});

export interface BankState {
  sourceId: string;
  name: string;
  /** The facility's limit; null when the source states none. */
  limitMinor: string | null;
  /** The principal at the closed month. */
  drawnMinor: string;
  /** The limit minus the drawn part; null without a limit. */
  freeMinor: string | null;
  /** The sum of the bank's tranches after the closed month. */
  openDrawsMinor: string;
  /** The first month after the close in which the bank draws, as Kairon reports it. */
  firstDrawMonth: string | null;
  availableFrom: string | null;
  /** The equity share Kairon aims at (the version's, the project's or its default of 2 500). */
  targetEquityShareBp: number | null;
  /** The bank's share of equity plus bank in the last month of the mix. */
  finalBankShareBp: number | null;
}

/** The senior bank of an evaluate: the first source Kairon counts as the bank, else the first of kind `bank`. */
export function bankOf(evalJson: unknown, closedThrough: string): BankState | null {
  const e = BankEvalShape.parse(evalJson);
  const seniorId = e.fundingShares?.bankSourceIds[0];
  const source = e.walk.sources.find((s) => (seniorId === undefined ? s.kind === 'bank' : s.id === seniorId));
  if (source === undefined || source.kind !== 'bank') return null;
  const drawn = BigInt(source.principalMinor[closedThrough] ?? '0');
  const limit = source.limitMinor ?? null;
  const openDraws = e.draws
    .filter((d) => d.sourceId === source.id && d.period.slice(0, 7) > closedThrough)
    .reduce((sum, d) => sum + BigInt(d.amountMinor), 0n);
  return {
    sourceId: source.id,
    name: source.name,
    limitMinor: limit,
    drawnMinor: String(drawn),
    freeMinor: limit === null ? null : String(BigInt(limit) - drawn),
    openDrawsMinor: String(openDraws),
    firstDrawMonth: e.fundingShares?.bankFirstDrawMonth ?? null,
    availableFrom: source.availableFrom ?? null,
    targetEquityShareBp: e.fundingShares?.targetEquityShareBp ?? null,
    finalBankShareBp: e.fundingShares?.mix.at(-1)?.bankShareBp ?? null,
  };
}

const percentOfBp = (bp: number) => `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bp / 100)} %`;

/** The bank as facts for the LLM's placeholders, under `key` (`active`, `v1`, ...). */
export function bankFacts(currency: CurrencyFormat, key: string, bank: BankState): Record<string, string> {
  const money = (minor: string) => formatMillions(minor, currency.decimals, currency.currencyCode);
  const facts: Record<string, string> = {
    [`${key}.bank.drawn`]: money(bank.drawnMinor),
    [`${key}.bank.openDraws`]: money(bank.openDrawsMinor),
    [`${key}.bank.start`]: bank.firstDrawMonth ?? bank.availableFrom?.slice(0, 7) ?? 'не задан',
  };
  if (bank.limitMinor !== null) facts[`${key}.bank.limit`] = money(bank.limitMinor);
  if (bank.freeMinor !== null) facts[`${key}.bank.free`] = money(bank.freeMinor);
  if (bank.finalBankShareBp !== null) facts[`${key}.bank.share`] = percentOfBp(bank.finalBankShareBp);
  if (bank.targetEquityShareBp !== null) facts[`${key}.bank.targetShare`] = percentOfBp(10_000 - bank.targetEquityShareBp);
  return facts;
}

/**
 * Why a funding plan shows no bank; null when the bank draws after the close. The cause is stated only
 * for a bank with no start, where Kairon's rule is known; any other zero is reported without one.
 */
export function bankNote(bank: BankState, currency: CurrencyFormat): string | null {
  if (BigInt(bank.openDrawsMinor) !== 0n) return null;
  const money = (minor: string) => formatMillions(minor, currency.decimals, currency.currencyCode);
  const figures = [
    ...(bank.limitMinor === null ? [] : [`Лимит ${money(bank.limitMinor)}`]),
    `выбрано ${money(bank.drawnMinor)}`,
    ...(bank.freeMinor === null ? [] : [`свободно ${money(bank.freeMinor)}`]),
  ].join(', ');
  const sentence = figures.charAt(0).toUpperCase() + figures.slice(1);
  const noStart = bank.availableFrom === null && bank.firstDrawMonth === null;
  return noStart
    ? `Банк «${bank.name}» в открытых месяцах не выбирается: в Kairon у него нет даты «Доступен с» и нет закреплённого транша, а без старта правило финансирования отдаёт всю потребность партнёрам. ${sentence}.`
    : `Банк «${bank.name}» в открытых месяцах траншей не получает. ${sentence}.`;
}
