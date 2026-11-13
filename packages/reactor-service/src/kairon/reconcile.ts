// packages/reactor-service/src/kairon/reconcile.ts
//
// Four reconciliations per draft (DEV-1375, spec 5.4.5): the draft agrees with
// itself and with Kairon. They answer "does this forecast JSON give adequate
// numbers" with checks a CFO can repeat:
// - draws equal need: in every open month the draws sum to what Kairon counts
//   toward the need, and no need is left uncovered;
// - only the asked change: every plan cell the draft changed belongs to an
//   asked line, every draw it added or changed belongs to an asked source;
// - the profit bridge closes: the residual group is within 1 unit of currency;
// - debts repaid at exit: Kairon's exit settlement pays each source's
//   outstanding principal in full. The walk's principalMinor at the exit month
//   is the balance before that settlement, so it is not 0; the settlement
//   (exit.bySource) is where the repayment shows.

import { z } from 'zod';
import type { VariantDiff } from './diff.js';
import type { EvaluateBody } from './patch.js';
import { formatMillions, signedMillions, type CurrencyFormat } from './summary.js';

export interface Reconciliation {
  key: 'drawsEqualNeed' | 'onlyAsked' | 'bridgeCloses' | 'repaidAtExit';
  ok: boolean;
  text: string;
  source: string;
}

const ReconcileShape = z.object({
  factBoundary: z.object({ month: z.string().nullable() }).nullable(),
  draws: z.array(z.object({ period: z.string(), amountMinor: z.string() })),
  walk: z.object({
    months: z.array(z.string()),
    drawsTowardNeedMinor: z.record(z.string()),
    uncoveredNeedMinor: z.record(z.string()),
    sources: z.array(z.object({ id: z.string(), name: z.string(), principalMinor: z.record(z.string()) })),
  }),
  exit: z
    .object({
      month: z.string().nullable(),
      bySource: z.record(z.object({ principalPaidMinor: z.string(), cutMinor: z.string() })),
    })
    .nullable(),
});

const BodyDraw = z.object({ sourceId: z.string(), date: z.string(), amountMinor: z.string() });

type Evaluation = z.infer<typeof ReconcileShape>;

function drawsEqualNeed(e: Evaluation, money: (minor: bigint) => string): Reconciliation {
  const source = 'Σ draws[period] − walk.drawsTowardNeedMinor[period] · walk.uncoveredNeedMinor';
  const closed = e.factBoundary?.month ?? '';
  const byMonth = new Map<string, bigint>();
  for (const d of e.draws) byMonth.set(d.period.slice(0, 7), (byMonth.get(d.period.slice(0, 7)) ?? 0n) + BigInt(d.amountMinor));
  const open = e.walk.months.filter((m) => m > closed);
  const uncovered = Object.values(e.walk.uncoveredNeedMinor).reduce((s, v) => s + BigInt(v), 0n);
  const off = open.find((m) => (byMonth.get(m) ?? 0n) !== BigInt(e.walk.drawsTowardNeedMinor[m] ?? '0'));
  if (off !== undefined) {
    const toward = BigInt(e.walk.drawsTowardNeedMinor[off] ?? '0');
    return { key: 'drawsEqualNeed', ok: false, text: `${off}: транши ${money(byMonth.get(off) ?? 0n)} при покрытии потребности ${money(toward)}.`, source };
  }
  if (uncovered > 0n) return { key: 'drawsEqualNeed', ok: false, text: `Непокрыто ${money(uncovered)}.`, source };
  const total = open.reduce((s, m) => s + (byMonth.get(m) ?? 0n), 0n);
  return {
    key: 'drawsEqualNeed',
    ok: true,
    text: `Транши равны потребности в каждом из ${open.length} открытых месяцев: ${money(total)}, непокрыто 0.`,
    source,
  };
}

function changedCells(parent: EvaluateBody, draft: EvaluateBody): Map<string, number> {
  const before = new Map(parent.plan.lines.map((l) => [l.code, l.monthlyForecast]));
  const changed = new Map<string, number>();
  for (const line of draft.plan.lines) {
    const old = before.get(line.code) ?? {};
    const months = new Set([...Object.keys(old), ...Object.keys(line.monthlyForecast)]);
    let n = 0;
    for (const m of months) if (BigInt(old[m] ?? '0') !== BigInt(line.monthlyForecast[m] ?? '0')) n++;
    if (n > 0) changed.set(line.code, n);
  }
  return changed;
}

function onlyAsked(
  parent: EvaluateBody,
  draft: EvaluateBody,
  askedLineCodes: string[],
  askedDrawSourceIds: string[],
): Reconciliation {
  const source = 'diff(parentBody, draftBody): plan cells, draws';
  const cells = changedCells(parent, draft);
  const parentDraws = new Set(z.array(BodyDraw).parse(parent.draws ?? []).map((d) => `${d.sourceId}|${d.date}|${d.amountMinor}`));
  const newDraws = z
    .array(BodyDraw)
    .parse(draft.draws ?? [])
    .filter((d) => !parentDraws.has(`${d.sourceId}|${d.date}|${d.amountMinor}`));
  const outsideLines = [...cells.keys()].filter((code) => !askedLineCodes.includes(code));
  const outsideSources = [...new Set(newDraws.map((d) => d.sourceId))].filter((id) => !askedDrawSourceIds.includes(id));
  if (outsideLines.length > 0 || outsideSources.length > 0) {
    const parts = [...outsideLines, ...outsideSources.map((id) => `транши ${id}`)];
    return { key: 'onlyAsked', ok: false, text: `Изменено вне запроса: ${parts.join(', ')}.`, source };
  }
  const parts: string[] = [];
  const cellCount = [...cells.values()].reduce((s, n) => s + n, 0);
  if (cells.size > 0) parts.push(`строки ${[...cells.keys()].join(', ')} (${cellCount} ячеек)`);
  if (newDraws.length > 0) parts.push(`${newDraws.length} траншей`);
  const text = parts.length === 0 ? 'Ничего не изменено.' : `Изменено только заказанное: ${parts.join(', ')}.`;
  return { key: 'onlyAsked', ok: true, text, source };
}

function bridgeCloses(diff: VariantDiff, currency: CurrencyFormat): Reconciliation {
  const other = BigInt(diff.bridge.find((b) => b.key === 'other')?.minor ?? '0');
  const unit = 10n ** BigInt(currency.decimals);
  const abs = other < 0n ? -other : other;
  const change = BigInt(diff.profit.variantNetMinor) - BigInt(diff.profit.activeNetMinor);
  const ok = abs <= unit;
  const text = ok
    ? `Изменение чистой прибыли ${signedMillions(change, currency)} разложено по группам, остаток ${abs === 0n ? '0' : `${other} минорных единиц`}.`
    : `Остаток моста ${signedMillions(other, currency)}: больше 1 ${currency.currencyCode}.`;
  return { key: 'bridgeCloses', ok, text, source: 'diff.bridge.other' };
}

function repaidAtExit(e: Evaluation, money: (minor: bigint) => string): Reconciliation {
  const source = 'exit.bySource[].principalPaidMinor = walk.sources[].principalMinor[exit.month] · cutMinor';
  const month = e.exit?.month ?? null;
  if (e.exit === null || month === null) return { key: 'repaidAtExit', ok: false, text: 'Выхода в прогнозе нет.', source };
  const bySource = e.exit.bySource;
  const short = e.walk.sources.filter((s) => {
    const settled = bySource[s.id];
    return settled === undefined || settled.principalPaidMinor !== (s.principalMinor[month] ?? '0') || settled.cutMinor !== '0';
  });
  const first = short[0];
  if (first !== undefined) {
    const paid = BigInt(bySource[first.id]?.principalPaidMinor ?? '0');
    const owed = BigInt(first.principalMinor[month] ?? '0');
    return { key: 'repaidAtExit', ok: false, text: `${first.name}: при выходе ${month} выплачено ${money(paid)} из ${money(owed)}.`, source };
  }
  return {
    key: 'repaidAtExit',
    ok: true,
    text: `Тело долга погашено при выходе ${month} у всех ${e.walk.sources.length} источников, списаний 0.`,
    source,
  };
}

export function reconcile(input: {
  parentBody: EvaluateBody;
  draftBody: EvaluateBody;
  draftEval: unknown;
  diff: VariantDiff;
  askedLineCodes: string[];
  askedDrawSourceIds: string[];
  currency: CurrencyFormat;
}): Reconciliation[] {
  const e = ReconcileShape.parse(input.draftEval);
  const money = (minor: bigint) => formatMillions(String(minor), input.currency.decimals, input.currency.currencyCode);
  return [
    drawsEqualNeed(e, money),
    onlyAsked(input.parentBody, input.draftBody, input.askedLineCodes, input.askedDrawSourceIds),
    bridgeCloses(input.diff, input.currency),
    repaidAtExit(e, money),
  ];
}
