// packages/reactor-service/src/kairon/redLines.ts
//
// The 7 red lines a draft must not cross (DEV-1375, spec 5.4.3): cash gaps,
// each partner's frame, partner parity, IRR against the promise, the bank's
// LTC and LTV. Every line carries the parent's status too: Rivergate's
// partners are over their frames already in the active forecast, and a breach
// the parent had is not one the draft adds. Frames are read from partnerFrames
// as Kairon serves them, never recomputed. Parity counts only the draws the
// draft changes against its parent, split by the agreed shares in
// settings.funding.partners; it warns (needs a human decision) and never
// breaches.

import { z } from 'zod';
import type { Mark } from './goals.js';
import {
  formatMillions,
  formatPercent,
  summarizeEvaluation,
  type CurrencyFormat,
  type EvaluationMetrics,
  type PartnerShare,
} from './summary.js';
import { floorDiv } from './patch.js';

export interface RedLine {
  key: 'cashGap' | `frame.${string}` | 'parity' | 'irr' | 'ltc' | 'ltv';
  label: string;
  status: Mark;
  baseStatus: Mark;
  text: string;
  source: string;
  /** Frame rows: track = planned frame, fill = the draft's allocated, tick = the parent's allocated. */
  bar: { trackMinor: string; fillMinor: string; tickMinor: string } | null;
  /** Parity row: the leading partner's cumulative gap per month. */
  series: Array<{ month: string; minor: string }> | null;
}

const Covenant = z.object({ ratioBp: z.number().nullable(), limitBp: z.number().nullable(), breached: z.boolean().nullable() });

const RedLineShape = z.object({
  walk: z.object({ uncoveredNeedMinor: z.record(z.string()), cashBalanceMinor: z.record(z.string()) }),
  partnerFrames: z
    .array(
      z.object({
        partnerId: z.string(),
        plannedFrameMinor: z.string(),
        allocatedMinor: z.string(),
        headroomMinor: z.string(),
      }),
    )
    .optional(),
  sourceGroups: z.array(z.object({ sourceId: z.string(), partnerId: z.string().optional() })),
  draws: z.array(z.object({ sourceId: z.string(), period: z.string(), amountMinor: z.string() })),
  covenants: z.array(z.object({ ltv: Covenant.optional(), ltc: Covenant.optional() })),
});

type Evaluation = z.infer<typeof RedLineShape>;
type LineBody = Omit<RedLine, 'key' | 'label' | 'baseStatus' | 'source'>;

const PPM = 1_000_000n;

/** 1 million in major units: the gap between partners a draft may add without a human decision. */
export function parityToleranceMinor(decimals: number): bigint {
  return PPM * 10n ** BigInt(decimals);
}

function sortedEntries(record: Record<string, string>): Array<[string, bigint]> {
  return Object.keys(record)
    .sort()
    .map((month): [string, bigint] => [month, BigInt(record[month] ?? '0')]);
}

function cashGap(e: Evaluation, money: (minor: bigint) => string): LineBody {
  const uncovered = sortedEntries(e.walk.uncoveredNeedMinor);
  const gaps = uncovered.filter(([, v]) => v > 0n);
  const first = gaps[0];
  if (first !== undefined) {
    const total = gaps.reduce((s, [, v]) => s + v, 0n);
    return { status: 'breach', text: `Непокрытая потребность ${money(total)}: первый разрыв в ${first[0]}.`, bar: null, series: null };
  }
  const balances = sortedEntries(e.walk.cashBalanceMinor);
  const low = balances.reduce<[string, bigint] | null>((min, cur) => (min === null || cur[1] < min[1] ? cur : min), null);
  const lowText = low === null ? '' : ` Минимальный остаток ${money(low[1])} в ${low[0]}.`;
  return {
    status: 'ok',
    text: `Непокрытая потребность 0 во всех ${uncovered.length} месяцах.${lowText}`,
    bar: null,
    series: null,
  };
}

function frameOf(e: Evaluation, partnerId: string) {
  return (e.partnerFrames ?? []).find((f) => f.partnerId === partnerId);
}

function frame(draft: Evaluation, parent: Evaluation, partnerId: string, money: (minor: bigint) => string): LineBody {
  const f = frameOf(draft, partnerId);
  if (f === undefined) return { status: 'unchecked', text: 'Рамка партнёра не задана в Kairon.', bar: null, series: null };
  const headroom = BigInt(f.headroomMinor);
  const tail = headroom >= 0n ? `запас ${money(headroom)}` : `сверх рамки ${money(-headroom)}`;
  return {
    status: headroom < 0n ? 'breach' : 'ok',
    text: `Вносит ${money(BigInt(f.allocatedMinor))} при рамке ${money(BigInt(f.plannedFrameMinor))}: ${tail}.`,
    bar: {
      trackMinor: f.plannedFrameMinor,
      fillMinor: f.allocatedMinor,
      tickMinor: frameOf(parent, partnerId)?.allocatedMinor ?? f.allocatedMinor,
    },
    series: null,
  };
}

/** Draws per partner id and month; the bank is left out. */
function partnerDraws(e: Evaluation): Map<string, Map<string, bigint>> {
  const partnerOf = new Map(e.sourceGroups.flatMap((g) => (g.partnerId === undefined ? [] : [[g.sourceId, g.partnerId]])));
  const out = new Map<string, Map<string, bigint>>();
  for (const d of e.draws) {
    const partnerId = partnerOf.get(d.sourceId);
    if (partnerId === undefined) continue;
    const months = out.get(partnerId) ?? new Map<string, bigint>();
    const month = d.period.slice(0, 7);
    months.set(month, (months.get(month) ?? 0n) + BigInt(d.amountMinor));
    out.set(partnerId, months);
  }
  return out;
}

function parity(
  draft: Evaluation,
  parent: Evaluation,
  partners: PartnerShare[],
  money: (minor: bigint) => string,
  tolerance: bigint,
): LineBody {
  if (partners.length < 2) {
    return { status: 'unchecked', text: 'Доли партнёров не заданы в настройках проекта.', bar: null, series: null };
  }
  const d = partnerDraws(draft);
  const p = partnerDraws(parent);
  const months = [...new Set([...d.values(), ...p.values()].flatMap((m) => [...m.keys()]))].sort();
  const cum = new Map(partners.map((x) => [x.partnerId, 0n]));
  const gaps = new Map(partners.map((x) => [x.partnerId, [] as Array<{ month: string; gap: bigint }>]));
  for (const month of months) {
    for (const x of partners) {
      const delta = (d.get(x.partnerId)?.get(month) ?? 0n) - (p.get(x.partnerId)?.get(month) ?? 0n);
      cum.set(x.partnerId, (cum.get(x.partnerId) ?? 0n) + delta);
    }
    const all = [...cum.values()].reduce((s, v) => s + v, 0n);
    for (const x of partners) {
      const share = BigInt(Math.round(x.sharePct * 1_000_000));
      const gap = (cum.get(x.partnerId) ?? 0n) - floorDiv(all * share, PPM);
      gaps.get(x.partnerId)?.push({ month, gap });
    }
  }
  const peak = (id: string) => (gaps.get(id) ?? []).reduce((max, g) => (g.gap > max ? g.gap : max), 0n);
  const trough = (id: string) => (gaps.get(id) ?? []).reduce((min, g) => (g.gap < min ? g.gap : min), 0n);
  const leader = partners.reduce((best, x) => (peak(x.partnerId) > peak(best.partnerId) ? x : best));
  const others = partners.filter((x) => x.partnerId !== leader.partnerId);
  const lagger = others.reduce((low, x) => (trough(x.partnerId) < trough(low.partnerId) ? x : low));
  const top = peak(leader.partnerId);
  const shares = partners.map((x) => Math.round(x.sharePct * 100)).join(' / ');
  if (top < tolerance) {
    return {
      status: 'ok',
      text: `Доли ${shares} не сдвигаются: наибольшее расхождение ${money(top)} при допуске ${money(tolerance)}.`,
      bar: null,
      series: null,
    };
  }
  const leaderGaps = gaps.get(leader.partnerId) ?? [];
  const reached = leaderGaps.find((g) => g.gap >= tolerance)?.month ?? '';
  const firstMoved = leaderGaps.findIndex((g) => g.gap !== 0n);
  return {
    status: 'warn',
    text: `${leader.name} обгоняет ${lagger.name} сверх своей доли на ${money(top)} с ${reached}`,
    bar: null,
    series: leaderGaps.slice(firstMoved).map((g) => ({ month: g.month, minor: String(g.gap) })),
  };
}

function irr(metrics: EvaluationMetrics, approved: EvaluationMetrics, partnerIds: string[]): LineBody {
  let ok = true;
  const parts = partnerIds.map((id) => {
    const promised = approved.partners.find((x) => x.partnerId === id);
    const value = metrics.partners.find((x) => x.partnerId === id)?.irr ?? null;
    const name = promised?.name ?? id;
    if (value === null || promised?.irr === null || promised?.irr === undefined || value < promised.irr) ok = false;
    const valueText = value === null ? 'нет IRR' : formatPercent(value);
    const promiseText = promised?.irr === null || promised?.irr === undefined ? 'нет' : formatPercent(promised.irr);
    return `${name} ${valueText} при обещании ${promiseText}`;
  });
  return { status: ok ? 'ok' : 'breach', text: parts.join('; '), bar: null, series: null };
}

function covenant(e: Evaluation, kind: 'ltc' | 'ltv'): LineBody {
  const c = e.covenants[0]?.[kind];
  const name = kind.toUpperCase();
  if (c === undefined || c.limitBp === null || c.ratioBp === null) {
    return { status: 'unchecked', text: `Лимит ${name} в условиях банка не задан, проверять не с чем.`, bar: null, series: null };
  }
  return {
    status: c.breached === true ? 'breach' : 'ok',
    text: `${name} ${formatPercent(c.ratioBp / 10_000)} при лимите ${formatPercent(c.limitBp / 10_000)}.`,
    bar: null,
    series: null,
  };
}

export function redLines(input: {
  approved: EvaluationMetrics;
  partners: PartnerShare[];
  irrPartnerIds: string[] | null;
  parentEval: unknown;
  draftEval: unknown;
  currency: CurrencyFormat;
}): RedLine[] {
  const parent = RedLineShape.parse(input.parentEval);
  const draft = RedLineShape.parse(input.draftEval);
  const money = (minor: bigint) => formatMillions(String(minor), input.currency.decimals, input.currency.currencyCode);
  const tolerance = parityToleranceMinor(input.currency.decimals);
  const irrIds = input.irrPartnerIds ?? input.approved.partners.map((x) => x.partnerId);
  const line = (key: RedLine['key'], label: string, source: string, d: LineBody, base: LineBody): RedLine => ({
    key,
    label,
    status: d.status,
    baseStatus: base.status,
    text: d.text,
    source,
    bar: d.bar,
    series: d.series,
  });
  return [
    line('cashGap', 'Кассовые разрывы', 'walk.uncoveredNeedMinor · walk.cashBalanceMinor', cashGap(draft, money), cashGap(parent, money)),
    ...input.partners.map((x) =>
      line(
        `frame.${x.partnerId}`,
        `Рамка партнёра ${x.name}`,
        `partnerFrames[${x.partnerId}].headroomMinor`,
        frame(draft, parent, x.partnerId, money),
        frame(parent, parent, x.partnerId, money),
      ),
    ),
    line(
      'parity',
      'Паритет партнёров',
      'draws · sourceGroups[].partnerId · settings.funding.partners[].sharePct',
      parity(draft, parent, input.partners, money, tolerance),
      parity(parent, parent, input.partners, money, tolerance),
    ),
    line(
      'irr',
      'IRR не ниже обещания',
      'exit.partners[].irr · approved exit.partners[].irr',
      irr(summarizeEvaluation(input.draftEval), input.approved, irrIds),
      irr(summarizeEvaluation(input.parentEval), input.approved, irrIds),
    ),
    line('ltc', 'Ковенант банка LTC', 'covenants[bank].ltc.ratioBp · limitBp', covenant(draft, 'ltc'), covenant(parent, 'ltc')),
    line('ltv', 'Ковенант банка LTV', 'covenants[bank].ltv.ratioBp · limitBp', covenant(draft, 'ltv'), covenant(parent, 'ltv')),
  ];
}
