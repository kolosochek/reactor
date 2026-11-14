// packages/reactor-service/web/kairon-render.mjs
//
// Card renderers of the forecast prototype page (DEV-1376, spec 5.4). Pure
// functions: server result in, HTML string out, no DOM access, so vitest runs
// them in node. Every text is escaped. Every status shows an icon and a word,
// so color never carries a status alone. Figures come only from the server
// result: red line texts, reconciliation texts and the rendered LLM text.
// The page imports this module from GET /kairon/assets/kairon-render.mjs and
// injects CARD_CSS once.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  let out = '';
  for (const ch of String(value ?? '')) out += ESC[ch] ?? ch;
  return out;
}

const ICON = { ok: '✓', warn: '⚠', breach: '✗', unchecked: '○' };
const COLOR = { ok: 'c-ok', warn: 'c-warn', breach: 'c-bad', unchecked: 'c-none' };
const WORD = { ok: 'в норме', warn: 'нужно согласие', breach: 'нарушено', unchecked: 'не проверено' };
const PARTY = { bank: 'Банк', project: 'Проект' };
const RECONCILIATION = {
  drawsEqualNeed: 'Транши = потребность',
  onlyAsked: 'Изменено только заказанное',
  bridgeCloses: 'Мост прибыли сходится',
  repaidAtExit: 'Долги погашены при выходе',
};
const CZK = { decimals: 2 };

/** Minor units as millions with one decimal and a comma: "33,1"; signed when asked. */
export function millions(minor, currency = CZK, signed = false) {
  const value = Number(minor) / 10 ** currency.decimals / 1e6;
  const text = value.toFixed(1).replace('.', ',');
  return signed && value > 0 ? `+${text}` : text;
}

/** An IRR fraction as "26,96 %". */
export function percent(fraction) {
  return `${(fraction * 100).toFixed(2).replace('.', ',')} %`;
}

const list = (items) => items.map((item) => `<li>${esc(item)}</li>`).join('');

function chip(mod, icon, iconClass, name, detail) {
  return `<span class="k-vchip${mod === '' ? '' : ` ${mod}`}"><span class="${iconClass}">${icon}</span> <b>${name}</b> · ${esc(detail)}</span>`;
}

function textOf(explanation, id) {
  const found = (explanation?.variants ?? []).find((v) => v.id === id);
  return { verdict: found?.verdict ?? '', gives: found?.gives ?? [], costs: found?.costs ?? [], stakeholders: found?.stakeholders ?? [] };
}

// ---------- verdict (b4 top) ----------

function goalChip(checks) {
  if (checks.length === 0) return chip('', '○', 'i-none', 'Цель', 'не задана');
  const monthly = checks.every((c) => c.months.length > 0);
  const hit = monthly ? checks.flatMap((c) => c.months).filter((m) => m.draft).length : checks.filter((c) => c.draft === 'ok').length;
  const total = monthly ? checks.flatMap((c) => c.months).length : checks.length;
  const detail = `${hit} из ${total}${monthly ? ' мес' : ''}`;
  return hit === total ? chip('', '✓', 'i-ok', 'Цель', detail) : chip('bad', '✗', 'i-bad', 'Цель', detail);
}

function redLineCounts(lines) {
  const count = (pred) => lines.filter(pred).length;
  return {
    ok: count((l) => l.status === 'ok'),
    warn: count((l) => l.status === 'warn'),
    added: count((l) => l.status === 'breach' && l.baseStatus !== 'breach'),
    inBase: count((l) => l.status === 'breach' && l.baseStatus === 'breach'),
    unchecked: count((l) => l.status === 'unchecked'),
  };
}

function redLineChip(lines) {
  const c = redLineCounts(lines);
  const parts = [
    [c.ok, `✓ ${c.ok}`],
    [c.warn, `⚠ ${c.warn}`],
    [c.added, `✗ ${c.added}`],
    [c.inBase, `✗ ${c.inBase} в базе`],
    [c.unchecked, `○ ${c.unchecked}`],
  ]
    .filter(([n]) => n > 0)
    .map(([, text]) => text)
    .join(' · ');
  if (c.added > 0) return chip('bad', '✗', 'i-bad', 'Красные линии', parts);
  if (c.warn > 0) return chip('warn', '⚠', 'i-warn', 'Красные линии', parts);
  return chip('', '✓', 'i-ok', 'Красные линии', parts);
}

function reconciliationChip(recs) {
  const ok = recs.filter((r) => r.ok).length;
  const detail = `${ok} из ${recs.length}`;
  return ok === recs.length ? chip('', '✓', 'i-ok', 'Сверки', detail) : chip('bad', '✗', 'i-bad', 'Сверки', detail);
}

function uncheckedChip(lines) {
  const unchecked = lines.filter((l) => l.status === 'unchecked');
  const detail = unchecked.length === 0 ? '0' : `${unchecked.length}: ${unchecked.map((l) => l.label).join(', ')}`;
  return chip('', '○', 'i-none', 'Не проверено', detail);
}

export function renderVerdict(explanation, variant) {
  const lines = variant.redLines ?? [];
  const text = textOf(explanation, variant.id);
  const chips = [goalChip(variant.goalChecks ?? []), redLineChip(lines), reconciliationChip(variant.reconciliations ?? []), uncheckedChip(lines)];
  const say = text.verdict === '' ? '' : `<div class="k-say">${esc(text.verdict)}</div>`;
  const gc =
    text.gives.length === 0 && text.costs.length === 0
      ? ''
      : `<div class="k-gc"><div><h4>Даёт</h4><ul>${list(text.gives)}</ul></div><div><h4>Стоит</h4><ul>${list(text.costs)}</ul></div></div>`;
  return `<div class="k-verdict-row">${chips.join('')}</div>${say}${gc}`;
}

// ---------- who gets what (b4) ----------

export function renderStakeholders(variant, explanation) {
  const rows = textOf(explanation, variant.id).stakeholders.map((s) => {
    const partner = (variant.metrics?.partners ?? []).find((p) => p.partnerId === s.party);
    const name = partner === undefined ? (PARTY[s.party] ?? s.party) : partner.name;
    const irr = partner === undefined || partner.irr === null ? '—' : percent(partner.irr);
    return `<tr><td>${esc(name)}</td><td>${esc(irr)}</td><td>${esc(s.meaning)}</td></tr>`;
  });
  if (rows.length === 0) return '<div class="k-muted">Стороны не названы.</div>';
  return `<table class="k-t k-stake"><tr><th>Сторона</th><th>IRR</th><th>Что это значит</th></tr>${rows.join('')}</table>`;
}

// ---------- red lines ----------

function frameBar(line, currency) {
  const track = Number(line.bar.trackMinor);
  const fill = Number(line.bar.fillMinor);
  const tick = Number(line.bar.tickMinor);
  const max = Math.max(track, fill, tick, 1);
  const w = (v) => ((300 * Math.max(v, 0)) / max).toFixed(1);
  const x = (v) => (1 + (300 * Math.max(v, 0)) / max).toFixed(1);
  const label = `${line.label}: вносит ${millions(line.bar.fillMinor, currency)} при рамке ${millions(line.bar.trackMinor, currency)} млн`;
  return (
    `<svg viewBox="0 0 302 18" width="302" height="18" role="img" aria-label="${esc(label)}">` +
    `<rect x="1" y="4" width="${w(track)}" height="10" rx="3" fill="var(--border)"/>` +
    `<rect x="1" y="6" width="${w(fill)}" height="6" rx="2" fill="${fill > track ? '#d03b3b' : '#1baf7a'}"/>` +
    `<line x1="${x(tick)}" x2="${x(tick)}" y1="1" y2="17" stroke="var(--text-primary)" stroke-width="1.5" stroke-dasharray="2 2"/></svg>` +
    '<div class="k-legend"><span>серое: рамка</span><span>цвет: вносит черновик</span><span>пунктир: родитель</span></div>'
  );
}

function parityBars(series, currency) {
  if (series.length === 0) return '';
  const values = series.map((p) => Number(p.minor));
  const max = Math.max(...values.map(Math.abs), 1);
  const peak = values.indexOf(Math.max(...values));
  const slot = 300 / series.length;
  const width = Math.max(slot - 2, 1);
  const bars = series.map((p, i) => {
    const h = (40 * Math.abs(values[i] ?? 0)) / max;
    const x = 1 + i * slot;
    const rect = `<rect class="k-par" x="${x.toFixed(1)}" y="${(52 - h).toFixed(1)}" width="${width.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="#1baf7a"/>`;
    const label =
      i === 0 || i === peak
        ? `<text class="ink" x="${(x + width / 2).toFixed(1)}" y="${(48 - h).toFixed(1)}" text-anchor="middle">${esc(millions(p.minor, currency, true))}</text>`
        : '';
    return rect + label;
  });
  const first = series[0]?.month ?? '';
  const last = series[series.length - 1]?.month ?? '';
  return (
    `<svg viewBox="0 0 302 70" width="302" height="70" role="img" aria-label="Опережение сверх доли по месяцам, млн">` +
    `${bars.join('')}<text x="1" y="66">${esc(first)}</text><text x="301" y="66" text-anchor="end">${esc(last)}</text></svg>`
  );
}

function redLineRow(line, currency) {
  const word = line.status === 'breach' && line.baseStatus === 'breach' ? 'нарушено, как в базе' : WORD[line.status];
  const bar = line.bar === null || line.bar === undefined ? '' : frameBar(line, currency);
  const series = line.series === null || line.series === undefined ? '' : parityBars(line.series, currency);
  return (
    `<div class="k-rl ${line.status}"><span class="mk ${COLOR[line.status]}">${ICON[line.status]}</span>` +
    `<span class="nm">${esc(line.label)}<small>${esc(word)}</small></span>` +
    `<div><div class="tx">${esc(line.text)}</div>${bar}${series}` +
    `<span class="base">в базе: <span class="${COLOR[line.baseStatus]}">${ICON[line.baseStatus]}</span> ${WORD[line.baseStatus]}</span>` +
    `<div class="key">${esc(line.source)}</div></div></div>`
  );
}

export function renderRedLines(lines, currency = CZK) {
  return lines.map((line) => redLineRow(line, currency)).join('');
}

// ---------- goals (b1) ----------

function goalCell(mark, months, side) {
  if (months.length > 0) {
    const hit = months.filter((m) => m[side]).length;
    const chips = months.map((m) => `<span class="${m[side] ? 'y' : 'n'}">${esc(m.month)}</span>`).join('');
    return `<span class="${mark === 'ok' ? 'mk-ok' : 'mk-bad'}">${hit} из ${months.length} мес</span><div class="k-months">${chips}</div>`;
  }
  if (mark === 'ok') return '<span class="mk-ok">выполнено</span>';
  if (mark === 'breach') return '<span class="mk-bad">не выполнено</span>';
  return '<span class="c-none">○ не проверено</span>';
}

export function renderGoalChecks(checks) {
  if (checks.length === 0) return '<div class="k-muted">Целей нет: варианты ранжируются по обещанию партнёрам.</div>';
  const rows = checks.map(
    (c) =>
      `<tr class="goal"><td class="p">${esc(c.part)}</td><td>${esc(c.label)}</td>` +
      `<td>${goalCell(c.parent, c.months, 'parent')}</td><td>${goalCell(c.draft, c.months, 'draft')}</td></tr>`,
  );
  return `<table class="k-c"><tr><th>Часть прогноза</th><th>Условие</th><th>Родитель</th><th>Черновик</th></tr>${rows.join('')}</table>`;
}

// ---------- reconciliations ----------

export function renderReconciliations(recs) {
  return recs
    .map(
      (r) =>
        `<div class="k-rl${r.ok ? '' : ' breach'}"><span class="mk ${r.ok ? 'c-ok' : 'c-bad'}">${r.ok ? '✓' : '✗'}</span>` +
        `<span class="nm">${esc(RECONCILIATION[r.key] ?? r.key)}<small>${r.ok ? 'сходится' : 'не сходится'}</small></span>` +
        `<div><div class="tx">${esc(r.text)}</div><div class="key">${esc(r.source)}</div></div></div>`,
    )
    .join('');
}

// ---------- recommendation overview ----------

function matrixTable(matrix, ids, recommended, titleOf) {
  if (matrix.length === 0) return '';
  const head = ids.map((id) => `<th${id === recommended ? ' class="win"' : ''}>${esc(id)} ${esc(titleOf(id))}</th>`).join('');
  const rows = matrix.map((row) => {
    const cells = ids.map((id) => {
      const classes = [id === recommended ? 'win' : '', row.best === id ? 'best' : ''].filter((c) => c !== '').join(' ');
      return `<td${classes === '' ? '' : ` class="${classes}"`}>${esc(row.values[id] ?? '—')}</td>`;
    });
    return `<tr><td>${row.step === null ? '' : `${row.step}. `}${esc(row.label)}</td>${cells.join('')}</tr>`;
  });
  return (
    `<div class="k-part">Как варианты прошли критерии</div><table class="k-m"><tr><th>Критерий</th>${head}</tr>${rows.join('')}</table>` +
    '<div class="k-legend"><span>с номером: шаг выбора</span><span>без номера: цена решения</span><span>best: лучший по строке</span></div>'
  );
}

/** The drafts the server refused before scoring (stale lineage, closed cover window, rejected levers); '' for none. */
export function renderRejected(rejected) {
  if ((rejected ?? []).length === 0) return '';
  const items = rejected.map(
    (r) => `<li><b>${esc(r.id)}</b>${r.title === r.id ? '' : ` «${esc(r.title)}»`}: ${esc(r.errors.join('; '))}</li>`,
  );
  return `<div class="k-rejected"><div class="k-part">Сервер отклонил</div><ul>${items.join('')}</ul></div>`;
}

/**
 * What the save row says after POST /kairon/save, and whether the button may be pressed again (DEV-1377).
 * Plain text for textContent. An error that carries a versionId means Kairon created the version and then
 * refused its draws: a second click would create a second version, so the button stays off. A stale draft
 * (`stale: true`) can never be saved, so its button stays off too; the server's text names the way out.
 */
export function saveOutcome(status, json) {
  const ok = status >= 200 && status < 300;
  if (ok) {
    return {
      text: `Создан черновик «${json?.name ?? ''}» (${json?.versionId ?? ''}). Версия не активна: активировать её можно только в Kairon.`,
      canRetry: false,
    };
  }
  const error = json?.error ?? `HTTP ${status}`;
  if (typeof json?.versionId === 'string' && json.versionId !== '') {
    return { text: `${error}. Повторное сохранение создаст вторую версию.`, canRetry: false };
  }
  return { text: `Не сохранено: ${error}`, canRetry: json?.stale !== true };
}

/**
 * A note above the answer when the router could not parse the message and fell back to a question (DEV-1377).
 * Without it the fallback shows only in the ribbon summary; '' when the route has no error.
 */
export function renderRouteNote(route) {
  const error = route?.error ?? '';
  if (error === '') return '';
  return `<div class="k-route-note">Маршрут не разобран: ${esc(error)}. Ответ дан как на вопрос.</div>`;
}

/**
 * The answers a run shows above its cards: the scoring's list. It starts as a copy of the goal drafts' answers
 * («Цель уже выполнена в vN», «Черновик для vN не построен: …») and adds «ближе всего vN» for a draft that
 * misses its goal. A recording saved before the scoring carried answers has none.
 */
export function answersOf(out) {
  return out?.scored?.answers ?? [];
}

/** One run as the export indexes it: its tools, LLM calls and Kairon calls in order, with the events untouched. */
function runExport(step, run) {
  const events = run.events;
  const labels = new Map(events.filter((e) => e.type === 'llm.request').map((e) => [e.payload.callId, e.payload.label ?? null]));
  const ended = events.filter((e) => e.type === 'tool.end');
  const tools = events
    .filter((e) => e.type === 'tool.start')
    .map((e, i) => ({ tool: e.payload.tool, ms: ended[i]?.payload.ms ?? null, ended: ended[i] !== undefined }));
  const llm = events
    .filter((e) => e.type === 'llm.done')
    .map(({ payload: p }) => ({
      callId: p.callId,
      label: labels.get(p.callId) ?? null,
      model: p.model ?? null,
      ms: p.ms ?? null,
      finishReason: p.finishReason ?? null,
      tokensIn: p.usage?.prompt_tokens ?? null,
      tokensOut: p.usage?.completion_tokens ?? null,
      costUsd: p.usage?.cost ?? null,
    }));
  const kairon = events
    .filter((e) => e.type === 'kairon.call')
    .map(({ payload: p }) => ({ op: p.op, method: p.method, status: p.status, ms: p.ms }));
  const done = events.find((e) => e.type === 'run.done');
  return { step, failure: run.failure ?? null, ms: done?.payload.ms ?? null, tools, llm, kairon, events };
}

/**
 * The whole session as one JSON document, for analysis outside the page: every run of every message
 * (planning and execution) with a short index over its events, and the sections as the page holds them
 * (goals, the selected draft, each draft's lineage). The steps of a plan run one after another, so the
 * n-th tool.end closes the n-th tool.start. The API key is already redacted in run.start by the service.
 */
export function sessionExport(session, meta) {
  const messages = [];
  for (const r of session.record) {
    if (r.step === 'route' || messages.length === 0) messages.push({ index: messages.length + 1, text: r.message, runs: [] });
    messages[messages.length - 1].runs.push(runExport(r.step, r.run));
  }
  const sections = session.sections.map((s) => ({
    id: s.id,
    scenario: s.scenario,
    spec: s.spec,
    goals: s.goals,
    selected: session.selected?.section === s.id ? session.selected.id : null,
    drafts: [...s.drafts.values()].map((v) => ({
      id: v.id,
      parentId: v.parentId ?? null,
      title: v.title,
      status: v.status,
      levers: v.levers,
      lineage: v.lineage,
    })),
  }));
  return {
    format: 'kairon-reactor-session',
    version: 1,
    exportedAt: meta.exportedAt,
    model: meta.model,
    variantCount: meta.variantCount,
    messages,
    sections,
  };
}

export function renderOverview(explanation, scored) {
  const titleOf = (id) => scored.variants.find((v) => v.id === id)?.title ?? '';
  const rec = explanation.recommendation ?? '';
  const excluded = explanation.notRecommendable ?? [];
  const head =
    rec !== ''
      ? `<div class="k-rec">Рекомендую ${esc(rec)}: ${esc(titleOf(rec))}</div>`
      : excluded.length > 0
        ? '<div class="k-rec">Рекомендации нет: ни один вариант не выполняет цель запроса без нового нарушения красной линии</div>'
        : '<div class="k-rec">Рекомендации нет: ни один вариант не посчитан</div>';
  const say = [explanation.headline, explanation.whyRecommended, explanation.departureReason].filter((t) => typeof t === 'string' && t !== '');
  const rules = explanation.rules ?? [];
  const ids = scored.ranking.filter((id) => (explanation.matrix ?? []).some((row) => id in row.values));
  const not = [
    ...(explanation.whyNotOthers ?? []).map((w) => `<li>${esc(w.id)}: ${esc(w.reason)}</li>`),
    ...(explanation.dropped ?? []).map((d) => `<li>${esc(d.id)} отброшен: совпал с ${d.sameAs === 'parent' ? 'родителем' : esc(d.sameAs)}.</li>`),
    ...excluded.map((n) => `<li>${esc(n.id)} не рекомендуется: ${esc(n.reason)}.</li>`),
  ];
  const switches = (explanation.switches ?? []).map(
    (s) =>
      `<button type="button" class="k-switch-btn" data-goal="${esc(JSON.stringify(s.goal))}">${esc(s.label)} → <b>${esc(s.winner)}</b></button>`,
  );
  return [
    head,
    say.length === 0 ? '' : `<div class="k-say">${esc(say.join(' '))}</div>`,
    rules.length === 0 ? '' : `<div class="k-part">Чем руководствуюсь</div><ol class="k-rules">${list(rules)}</ol>`,
    matrixTable(explanation.matrix ?? [], ids, rec, titleOf),
    not.length === 0 ? '' : `<div class="k-part">Почему не другие</div><ul class="k-not">${not.join('')}</ul>`,
    switches.length === 0
      ? ''
      : `<div class="k-part">Что изменит выбор</div><div class="k-switch">${switches.join('')}</div>` +
        '<div class="k-legend"><span>клик пересчитывает порядок существующих вариантов под эту цель; новых черновиков не создаёт</span></div>',
  ].join('');
}

// ---------- widgets (w1, w2, declarative specs) ----------

const PALETTE = ['#2a78d6', '#6250d6', '#1baf7a', '#eda100', '#8a8f98'];
const TAGS = {
  'matrix-diff': 'w1 · таблица-дифф · всегда',
  'bars-before-after': 'w2 · было / стало',
  'condition-check': 'b1 · цели',
  'stakeholder-table': 'стороны',
};

/** A signed delta in millions with a typographic minus; zero reads ±0,0. */
export function delta(minor, currency = CZK) {
  const value = Number(minor) / 10 ** currency.decimals / 1e6;
  const text = Math.abs(value).toFixed(1).replace('.', ',');
  if (text === '0,0') return '±0,0';
  return value > 0 ? `+${text}` : `−${text}`;
}

function drawCells(evaluation) {
  const cells = new Map();
  for (const d of evaluation.draws ?? []) {
    const key = `${d.sourceId}|${d.period.slice(0, 7)}`;
    cells.set(key, (cells.get(key) ?? 0n) + BigInt(d.amountMinor));
  }
  return cells;
}

function goalWindow(variant) {
  return new Set((variant.goalChecks ?? []).flatMap((c) => c.months.map((m) => m.month)));
}

/** The months a widget shows: every month with a changed cell, plus the goal window. */
function shownMonths(parent, draft, window) {
  const months = new Set(window);
  for (const key of new Set([...parent.keys(), ...draft.keys()])) {
    if ((parent.get(key) ?? 0n) !== (draft.get(key) ?? 0n)) months.add(key.slice(key.indexOf('|') + 1));
  }
  return [...months].sort();
}

function drawsView(variant, parentEval, draftEval) {
  const parent = drawCells(parentEval);
  const draft = drawCells(draftEval);
  const window = goalWindow(variant);
  const sources = (draftEval.walk?.sources ?? []).map((s) => ({ id: s.id, name: s.name }));
  return { parent, draft, window, sources, months: shownMonths(parent, draft, window) };
}

function matrixDiff(variant, parentEval, draftEval, currency) {
  const v = drawsView(variant, parentEval, draftEval);
  const hasWindow = v.window.size > 0;
  const sum = (minor) => (minor === 0n ? `<td class="sum">${delta(minor, currency)}</td>` : `<td class="sum"><b>${delta(minor, currency)}</b></td>`);
  const head =
    `<tr><th>Источник, млн</th>${v.months.map((m) => `<th class="m">${esc(m)}</th>`).join('')}` +
    `${hasWindow ? '<th>Δ в окне</th>' : ''}<th>Σ Δ</th></tr>`;
  const rows = v.sources.map((s) => {
    let inWindow = 0n;
    let total = 0n;
    const cells = v.months.map((m) => {
      const before = v.parent.get(`${s.id}|${m}`) ?? 0n;
      const after = v.draft.get(`${s.id}|${m}`) ?? 0n;
      const d = after - before;
      total += d;
      if (v.window.has(m)) inWindow += d;
      if (d === 0n) return `<td class="same">${after === 0n ? '—' : millions(after, currency)}</td>`;
      return `<td class="chg"><b>${millions(after, currency)}</b><small>${delta(d, currency)}</small></td>`;
    });
    return `<tr><td>${esc(s.name)}</td>${cells.join('')}${hasWindow ? sum(inWindow) : ''}${sum(total)}</tr>`;
  });
  const need = draftEval.walk?.cashNeedMinor ?? {};
  const needRow =
    `<tr class="k-need"><td class="k-muted">Потребность</td>` +
    `${v.months.map((m) => `<td class="same">${millions(need[m] ?? '0', currency)}</td>`).join('')}` +
    `${hasWindow ? '<td></td>' : ''}<td></td></tr>`;
  const legend =
    '<div class="k-legend"><span>жёлтая ячейка: транш изменён, под ним Δ к родителю</span>' +
    (hasWindow ? '<span>Δ в окне: за месяцы цели</span>' : '') +
    '<span>Σ Δ: за все показанные месяцы</span></div>';
  return `<table class="k-t k-matrix">${head}${rows.join('')}${needRow}</table>${legend}`;
}

/** The source whose delta labels the bars: the cover goal's partner, else the largest total change. */
function labelledSource(v, variant, draftEval) {
  const partnerId = (variant.goalChecks ?? []).find((c) => c.goal?.type === 'funding_cover')?.goal.partnerId;
  const group = (draftEval.sourceGroups ?? []).find((g) => partnerId !== undefined && g.partnerId === partnerId);
  const byGoal = v.sources.find((s) => group !== undefined && s.id === group.sourceId);
  if (byGoal !== undefined) return byGoal;
  const moved = (s) =>
    v.months.reduce((acc, m) => {
      const d = (v.draft.get(`${s.id}|${m}`) ?? 0n) - (v.parent.get(`${s.id}|${m}`) ?? 0n);
      return acc + (d < 0n ? -d : d);
    }, 0n);
  return v.sources.reduce((best, s) => (best === null || moved(s) > moved(best) ? s : best), null);
}

function barsBeforeAfter(variant, parentEval, draftEval, currency) {
  const v = drawsView(variant, parentEval, draftEval);
  if (v.months.length === 0) return '<div class="k-muted">Транши не изменились.</div>';
  const height = (cells, m) => v.sources.reduce((acc, s) => acc + Math.max(Number(cells.get(`${s.id}|${m}`) ?? 0n), 0), 0);
  const max = Math.max(1, ...v.months.flatMap((m) => [height(v.parent, m), height(v.draft, m)]));
  // At least 52 units per month keeps the month and delta labels apart; a wider chart scrolls inside its card.
  const slot = Math.max(406 / v.months.length, 52);
  const plotRight = 30 + v.months.length * slot;
  const w = Math.max(Math.min(18, slot / 2 - 3), 2);
  const scale = (minor) => (152 * Math.max(Number(minor), 0)) / max;
  const labelled = labelledSource(v, variant, draftEval);
  const stack = (cells, m, x, opacity) => {
    let y = 166;
    return v.sources
      .map((s, i) => {
        const h = scale(cells.get(`${s.id}|${m}`) ?? 0n);
        y -= h;
        return h === 0 ? '' : `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${PALETTE[i % PALETTE.length]}" opacity="${opacity}"/>`;
      })
      .join('');
  };
  const windowed = v.months.filter((m) => v.window.has(m));
  const shade =
    windowed.length === 0
      ? ''
      : `<rect x="${(30 + v.months.indexOf(windowed[0]) * slot).toFixed(1)}" y="14" width="${(windowed.length * slot).toFixed(1)}" height="152" fill="#eda100" opacity=".07"/><text x="${(34 + v.months.indexOf(windowed[0]) * slot).toFixed(1)}" y="24">окно цели</text>`;
  const pairs = v.months.map((m, i) => {
    const x0 = 30 + i * slot + (slot - 2 * w - 2) / 2;
    const d = labelled === null ? 0n : (v.draft.get(`${labelled.id}|${m}`) ?? 0n) - (v.parent.get(`${labelled.id}|${m}`) ?? 0n);
    const top = 166 - scale(height(v.draft, m));
    const label = d === 0n ? '' : `<text class="ink" x="${(x0 + 1.5 * w + 2).toFixed(1)}" y="${(top - 4).toFixed(1)}" text-anchor="middle">${delta(d, currency)}</text>`;
    return (
      `<g class="k-pair" data-month="${esc(m)}">${stack(v.parent, m, x0, '0.38')}${stack(v.draft, m, x0 + w + 2, '1')}${label}` +
      `<text x="${(x0 + w + 1).toFixed(1)}" y="182" text-anchor="middle">${esc(m)}</text></g>`
    );
  });
  const swatches = v.sources.map((s, i) => `<span><span class="k-sw" style="background:${PALETTE[i % PALETTE.length]}"></span>${esc(s.name)}</span>`);
  const note = labelled === null ? '' : ` · подпись: Δ ${esc(labelled.name)}, млн`;
  return (
    `<svg viewBox="0 0 ${Math.round(plotRight + 4)} 190" width="${Math.round((plotRight + 4) * 1.5)}" height="285" role="img" aria-label="Транши по месяцам: родитель и черновик">` +
    `<line x1="30" x2="${plotRight.toFixed(1)}" y1="166" y2="166" stroke="var(--border)" stroke-width="1"/>${shade}${pairs.join('')}</svg>` +
    `<div class="k-legend">${swatches.join('')}<span>бледный: родитель · яркий: черновик${note}</span></div>`
  );
}

function stakeholderTable(spec, variant) {
  const rows = spec.rows.map((name) => {
    const partner = (variant.metrics?.partners ?? []).find((p) => p.name === name);
    const irr = partner === undefined || partner.irr === null ? '—' : percent(partner.irr);
    return `<tr><td>${esc(name)}</td><td>${esc(irr)}</td></tr>`;
  });
  return `<table class="k-t"><tr><th>Сторона</th><th>IRR</th></tr>${rows.join('')}</table>`;
}

export function renderWidget(spec, variant, parentEval, draftEval, currency = CZK) {
  const body =
    spec.widget === 'matrix-diff'
      ? matrixDiff(variant, parentEval, draftEval, currency)
      : spec.widget === 'bars-before-after'
        ? barsBeforeAfter(variant, parentEval, draftEval, currency)
        : spec.widget === 'condition-check'
          ? renderGoalChecks(variant.goalChecks ?? [])
          : stakeholderTable(spec, variant);
  return (
    `<div class="k-widget"><div class="k-wh"><b>${esc(spec.title)}</b><span class="k-tag">${TAGS[spec.widget] ?? esc(spec.widget)}</span></div>${body}` +
    `<details class="k-specd"><summary>спецификация виджета</summary><pre class="k-spec">${esc(JSON.stringify(spec, null, 1))}</pre></details></div>`
  );
}

// ---------- copy of Kairon's forecast diff view ----------

const absBig = (v) => (v < 0n ? -v : v);

function tile(caption, value, detail) {
  return `<div class="k-tile"><div class="c">${esc(caption)}</div><div class="n">${esc(value)}</div><div class="d">${esc(detail)}</div></div>`;
}

function contributorBars(contributors, currency) {
  const max = Math.max(1, ...contributors.flatMap((c) => [Number(c.parentMinor), Number(c.draftMinor)]));
  return contributors
    .map((c, i) => {
      const w = (minor) => ((260 * Math.max(Number(minor), 0)) / max).toFixed(1);
      const color = PALETTE[i % PALETTE.length];
      return (
        `<div class="k-contrib"><span>${esc(c.name)}</span><svg viewBox="0 0 262 18" width="262" height="18" role="img" aria-label="${esc(c.name)}: родитель и черновик">` +
        `<rect x="1" y="1" width="${w(c.parentMinor)}" height="7" rx="2" fill="${color}" opacity="0.38"/>` +
        `<rect x="1" y="10" width="${w(c.draftMinor)}" height="7" rx="2" fill="${color}"/></svg>` +
        `<span class="k-muted">${millions(c.parentMinor, currency)} → ${millions(c.draftMinor, currency)} (${delta(BigInt(c.draftMinor) - BigInt(c.parentMinor), currency)})</span></div>`
      );
    })
    .join('');
}

export function renderDiffView(view, currency = { ...CZK, currencyCode: 'CZK' }) {
  const code = currency.currencyCode ?? 'CZK';
  const money = (minor) => `${millions(absBig(BigInt(minor)), currency)} млн ${code}`;
  const t = view.tiles;
  const costs = BigInt(t.costsDeltaMinor);
  const revenue = BigInt(t.revenueDeltaMinor);
  const tiles = [
    tile('Затраты к базе', money(costs), costs < 0n ? 'перерасход' : costs > 0n ? 'экономия' : 'без изменений'),
    tile('Выручка к базе', money(revenue), revenue > 0n ? 'выше' : revenue < 0n ? 'ниже' : 'без изменений'),
    tile('Сверх утверждённого', money(t.overApprovedMinor), `строк: ${t.overApprovedLines}`),
    tile('Не покрыто финансированием', money(t.uncoveredMinor), `в родителе ${money(t.uncoveredParentMinor)}`),
  ];
  const lines = view.changedLines.map((l) => {
    const d = BigInt(l.draftMinor) - BigInt(l.parentMinor);
    const cost = BigInt(l.parentMinor) <= 0n && BigInt(l.draftMinor) <= 0n;
    const word = cost ? (d < 0n ? 'дороже на' : 'дешевле на') : d > 0n ? 'выше на' : 'ниже на';
    return `<tr><td>${esc(l.code)}</td><td>${esc(l.name)}</td><td>${money(l.parentMinor)}</td><td>${money(l.draftMinor)}</td><td>${word} ${money(d)}</td></tr>`;
  });
  const approved = view.againstApproved.map(
    (g) =>
      `<tr><td>${esc(g.groupCode)}</td><td>${money(g.draftMinor)}</td><td>${money(g.approvedMinor)}</td>` +
      `<td>${esc(g.words)} ${money(BigInt(g.draftMinor) - BigInt(g.approvedMinor))}</td></tr>`,
  );
  const coverage = view.coverage.covered
    ? '<div class="k-cov"><span class="c-ok">✓</span> Финансирование покрывает потребность в каждом открытом месяце</div>'
    : '<div class="k-cov"><span class="c-bad">✗</span> Финансирование не покрывает потребность</div>';
  const notices = view.coverage.notices.length === 0 ? '' : `<ul class="k-not">${list(view.coverage.notices)}</ul>`;
  const events = (view.events ?? []).map(
    (e) => `<tr${e.active === e.variant ? '' : ' class="moved"'}><td>${esc(e.label)}</td><td>${esc(e.active ?? '—')}</td><td>${esc(e.variant ?? '—')}</td></tr>`,
  );
  return [
    `<div class="k-tiles k-tiles4">${tiles.join('')}</div>`,
    lines.length === 0
      ? ''
      : `<div class="k-part">Что меняется</div><table class="k-t"><tr><th>Код</th><th>Строка</th><th>Родитель</th><th>Черновик</th><th>Изменение</th></tr>${lines.join('')}</table>`,
    `<div class="k-part">Кто вносит</div>${contributorBars(view.contributors, currency)}<div class="k-legend"><span>бледный: родитель · яркий: черновик</span></div>`,
    approved.length === 0
      ? ''
      : `<div class="k-part">Против утверждённого бюджета</div><table class="k-t"><tr><th>Группа</th><th>Черновик</th><th>Утверждено</th><th>Разница</th></tr>${approved.join('')}</table>`,
    `<div class="k-part">Покрытие</div>${coverage}${notices}`,
    events.length === 0 ? '' : `<div class="k-part">События</div><table class="k-t"><tr><th>Событие</th><th>Родитель</th><th>Черновик</th></tr>${events.join('')}</table>`,
  ].join('');
}

// ---------- styles ----------

export const CARD_CSS = `
.k-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--bg-secondary); display: flex; flex-direction: column; gap: 10px; }
.k-widget { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--bg-secondary); }
.k-wh { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; margin-bottom: 4px; }
.k-tag { font-size: 10px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-secondary); }
.k-part { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--text-secondary); font-weight: 600; margin: 8px 0 4px; }
.k-muted { color: var(--text-secondary); }
.k-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
.k-verdict-row { display: flex; flex-wrap: wrap; gap: 6px; }
.k-vchip { border: 1px solid var(--border); border-radius: 8px; padding: 5px 9px; background: var(--bg-primary); font-size: 12px; }
.k-vchip b { font-size: 13px; }
.k-vchip.warn { border-color: color-mix(in srgb, #b26a00 55%, var(--border)); }
.k-vchip.bad { border-color: color-mix(in srgb, #d03b3b 55%, var(--border)); }
.i-ok { color: #0ca30c; font-weight: 700; } .i-warn { color: #b26a00; font-weight: 700; } .i-bad { color: #d03b3b; font-weight: 700; } .i-none { color: var(--text-tertiary); font-weight: 700; }
.k-say { font-size: 13.5px; margin: 6px 0 2px; }
.k-gc { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; }
.k-gc > div { border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; background: var(--bg-primary); }
.k-gc h4 { margin: 0 0 3px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--text-secondary); }
.k-gc ul { margin: 0; padding-left: 16px; font-size: 12.5px; }
.k-rl { display: grid; grid-template-columns: 22px 190px 1fr; gap: 4px 8px; padding: 6px 0; border-bottom: 1px solid var(--border); align-items: start; }
.k-rl:last-child { border-bottom: 0; }
.k-rl .mk { font-weight: 700; font-size: 14px; line-height: 18px; }
.k-rl .nm { font-weight: 600; font-size: 12.5px; }
.k-rl .nm small { display: block; font-weight: 400; color: var(--text-secondary); }
.k-rl .tx { font-size: 12.5px; }
.k-rl .base { display: block; font-size: 11px; color: var(--text-secondary); }
.k-rl .key { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: var(--text-tertiary); }
.k-rl.warn { background: color-mix(in srgb, #b26a00 7%, transparent); }
.k-rl.breach { background: color-mix(in srgb, #d03b3b 6%, transparent); }
.k-rl.unchecked { color: var(--text-secondary); }
.c-ok { color: #0ca30c; } .c-warn { color: #b26a00; } .c-bad { color: #d03b3b; } .c-none { color: var(--text-tertiary); }
.mk-ok { color: #006300; white-space: nowrap; } .mk-ok::before { content: '✓ '; color: #0ca30c; font-weight: 700; }
.mk-bad { color: #9c1c1c; white-space: nowrap; } .mk-bad::before { content: '✗ '; color: #d03b3b; font-weight: 700; }
.k-months { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
.k-months span { font-size: 10px; border-radius: 4px; padding: 0 4px; border: 1px solid var(--border); }
.k-months .y { border-color: #0ca30c; color: #006300; } .k-months .n { border-color: #d03b3b; color: #9c1c1c; }
table.k-c, table.k-t, table.k-m { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
table.k-c th, table.k-c td, table.k-t th, table.k-t td, table.k-m th, table.k-m td { padding: 4px 6px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
table.k-c th, table.k-t th, table.k-m th { color: var(--text-secondary); font-weight: 500; }
table.k-c td.p { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--text-secondary); white-space: nowrap; }
table.k-c tr.goal td { background: color-mix(in srgb, #eda100 10%, transparent); }
table.k-m td.win, table.k-m th.win { background: color-mix(in srgb, #2a78d6 9%, transparent); }
table.k-m td.best { font-weight: 700; }
.k-rec { font-size: 15px; font-weight: 600; }
.k-rules { margin: 4px 0 0; padding-left: 20px; font-size: 12.5px; }
.k-not { margin: 4px 0 0; padding-left: 18px; font-size: 12.5px; }
.k-switch { display: flex; flex-wrap: wrap; gap: 6px; }
.k-rejected { border-left: 3px solid #d03b3b; padding: 4px 10px; margin: 6px 0; font-size: 13px; } .k-rejected ul { margin: 2px 0 0; padding-left: 18px; }
.k-route-note { border-left: 3px solid #b26a00; padding: 4px 10px; margin: 6px 0; font-size: 13px; }
.k-switch-btn { border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; background: var(--bg-primary); color: var(--text-primary); font: inherit; font-size: 12px; cursor: pointer; }
.k-tiles4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.k-tile { border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; background: var(--bg-primary); }
.k-tile .n { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.k-tile .c { font-size: 11px; color: var(--text-secondary); }
.k-tile .d { font-size: 12px; color: var(--text-secondary); }
table.k-matrix td, table.k-matrix th { text-align: right; } table.k-matrix td:first-child, table.k-matrix th:first-child { text-align: left; }
td.chg { background: color-mix(in srgb, #eda100 22%, transparent); } td.chg b { display: block; font-weight: 600; } td.chg small { color: var(--text-secondary); }
td.same { color: var(--text-tertiary); } td.sum { white-space: nowrap; }
tr.moved td { background: color-mix(in srgb, #eda100 10%, transparent); }
.k-sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.k-specd summary { font-size: 11px; color: var(--text-tertiary); cursor: pointer; margin-top: 4px; }
.k-spec { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; background: var(--bg-primary); border-radius: 6px; padding: 5px 7px; margin: 4px 0 0; white-space: pre-wrap; color: var(--text-secondary); }
.k-contrib { display: grid; grid-template-columns: 170px 262px 1fr; gap: 8px; align-items: center; font-size: 12px; padding: 2px 0; }
.k-cov { font-size: 12.5px; }
svg text { font-size: 10.5px; fill: var(--text-secondary); }
svg text.ink { fill: var(--text-primary); font-weight: 600; }
`;
