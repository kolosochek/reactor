// packages/reactor-service/src/kairon/sampleLlm.ts
//
// A provider with canned answers for the forecast prototype page (DEV-1364
// stage 4, DEV-1375 stage 5). It lets the page run the whole batch plan for
// free: the reactor, the tools, Kairon evaluate and the trace are real; only
// the LLM answers are prepared in advance for the demo phrases. The answer is
// picked by the request label (the step) and by the demo phrase found in the
// first user message (the last one there, so an earlier chat turn in the
// history does not win). Any other phrase gets the fixed text in the step's
// text field. Picked on the page as the model "kairon/sample-no-llm"; it calls
// no network.

import type { LLMCompletionRequest, LLMCompletionResponse, LLMProvider, ProgressEvent } from '@kolosochek/reactor-core';
import type { KaironLLMRequest } from './openrouter.js';

export const SAMPLE_MODEL = 'kairon/sample-no-llm';

/** The phrases the sample answers; the first is the stage 4 textarea text. */
export const DEMO_PHRASES = [
  'Разрешение на ввод в эксплуатацию (kolaudace) сдвигается на 3 месяца: с декабря 2027 на март 2028. Достройка растягивается, передача квартир и выход тоже сдвигаются. Как сохранить партнёрам IRR, обещанный в утверждённом бюджете?',
  'Хочу, чтобы ближайшие 6 месяцев все затраты покрывал Cedar',
  'Почему v2 выше v3?',
  'Стройка дорожает на 8 % с 2026-09',
  'Хочу добиться чистой прибыли в +10 000 000',
  'Хочу сохранить IRR только для Solstice',
] as const;

type Phrase = 'delay' | 'cover' | 'why' | 'construction' | 'profit' | 'solsticeOnly' | 'unknown';
const PHRASE_KEYS: Phrase[] = ['delay', 'cover', 'why', 'construction', 'profit', 'solsticeOnly'];

const NO_ANSWER = 'В образце нет ответа на эту фразу, выберите модель с ключом';

const DELAY = {
  stretch: [{ lineCodes: ['D5', 'D8'], fromMonth: '2026-09', byMonths: 3 }],
  shift: [{ lineCodes: ['R1', 'R4', 'C1', 'C2', 'O4', 'U2', 'F7'], fromMonth: '2028-03', toMonth: null, byMonths: 3 }],
  extend: [{ lineCodes: ['O3', 'O5', 'F1', 'F2', 'F3'], months: 3 }],
  scale: [],
  set: [],
  monthRangeTo: '2028-10',
  shareTarget: null,
};

const PROPOSAL = {
  variants: [
    {
      id: 'v1',
      title: 'Только задержка kolaudace на 3 месяца',
      rationale: 'Стройка идёт на 3 месяца дольше, передачи и выход сдвигаются на 3 месяца. Накладные, комиссии и проценты идут на 3 месяца дольше.',
      levers: [],
      patch: DELAY,
    },
    {
      id: 'v2',
      title: 'Задержка и цены квартир +1,5 %',
      rationale: 'К задержке добавляем индексацию цен непроданных квартир на 1,5 %. Рынок принимает рост цен за время задержки.',
      levers: ['Цены квартир +1,5 %'],
      patch: { ...DELAY, scale: [{ lineCodes: ['R1'], fromMonth: '2026-09', factorPpm: 1_015_000 }] },
    },
    {
      id: 'v3',
      title: 'Задержка и первая очередь на месяц раньше',
      rationale: 'К задержке добавляем досрочную передачу первой очереди: она уходит на месяц раньше второй. Деньги покупателей приходят раньше.',
      levers: ['Первая очередь на месяц раньше'],
      patch: {
        ...DELAY,
        shift: [...DELAY.shift, { lineCodes: ['R1'], fromMonth: '2028-07', toMonth: '2028-07', byMonths: -1 }],
      },
    },
  ],
  openQuestions: ['Согласует ли банк продление кредита на 3 месяца без изменения ставки?'],
};

const EMPTY_PATCH = { stretch: [], shift: [], extend: [], scale: [], set: [], monthRangeTo: null, shareTarget: null };
const RELEASE_U2 = ['2026-11', '2027-06', '2028-01', '2028-06'].map((month) => ({ code: 'U2', month, amountMinor: '0' }));
const prices = (factorPpm: number) => [{ lineCodes: ['R1'], fromMonth: '2026-09', factorPpm }];

/** Scenario 2 levers on top of construction +8 % (the server builds v1, the scenario alone). */
const CONSTRUCTION_LEVERS: Record<string, { title: string; rationale: string; levers: string[]; patch: object }> = {
  v2: {
    title: 'Удорожание покрываем резервом U2',
    rationale: 'Резерв на непредвиденные расходы уходит на удорожание стройки. Цены квартир не трогаем.',
    levers: ['Резерв U2 отпущен'],
    patch: { ...EMPTY_PATCH, set: RELEASE_U2 },
  },
  v3: {
    title: 'Удорожание покрываем ценами квартир',
    rationale: 'Индексируем цены непроданных квартир на верхней границе рычага. Резерв остаётся на риски стройки.',
    levers: ['Цены квартир вверх'],
    patch: { ...EMPTY_PATCH, scale: prices(1_030_000) },
  },
  v4: {
    title: 'Резерв и умеренная индексация цен',
    rationale: 'Нагрузка делится: резерв уходит на удорожание, цены индексируются меньше, чем в v3.',
    levers: ['Резерв U2 отпущен', 'Цены квартир вверх'],
    patch: { ...EMPTY_PATCH, set: RELEASE_U2, scale: prices(1_023_000) },
  },
};

/** One price lever per asked id: the answer to a profit or IRR goal. */
function priceLever(id: string): object {
  return {
    id,
    title: 'Цены квартир вверх',
    rationale: 'Индексируем цены непроданных квартир на верхней границе рычага, остальное как у родителя.',
    levers: ['Цены квартир вверх'],
    patch: { ...EMPTY_PATCH, scale: prices(1_030_000) },
  };
}

/** The demo phrase of the current message: the one found last in the first user message. */
function phraseOf(request: KaironLLMRequest): Phrase {
  const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
  let found: Phrase = 'unknown';
  let at = -1;
  DEMO_PHRASES.forEach((phrase, i) => {
    const index = user.lastIndexOf(phrase);
    const key = PHRASE_KEYS[i];
    if (index > at && key !== undefined) {
      at = index;
      found = key;
    }
  });
  return found;
}

/** The ids a lever request asks for: "Return exactly N variants with ids a, b." in the system prompt. */
function askedIdsOf(request: KaironLLMRequest): string[] | null {
  const marker = 'variants with ids ';
  const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
  const at = system.indexOf(marker);
  if (at === -1) return null;
  const rest = system.slice(at + marker.length);
  return rest.slice(0, rest.indexOf('. ')).split(', ');
}

function proposal(request: KaironLLMRequest, phrase: Phrase): Record<string, unknown> {
  const asked = askedIdsOf(request);
  if (phrase === 'delay') return PROPOSAL;
  if (phrase === 'construction' && asked !== null) {
    const variants = asked.flatMap((id) => {
      const lever = CONSTRUCTION_LEVERS[id];
      return lever === undefined ? [] : [{ id, ...lever }];
    });
    return { variants, openQuestions: ['Подрядчик подтвердит удорожание письменно до 2026-09?'] };
  }
  if ((phrase === 'profit' || phrase === 'solsticeOnly') && asked !== null) {
    return { variants: asked.map(priceLever), openQuestions: [] };
  }
  return { variants: [], openQuestions: [NO_ANSWER] };
}

const ROUTES: Record<Phrase, { kind: string; scope: string[] }> = {
  delay: { kind: 'generate', scope: [] },
  cover: { kind: 'goal_change', scope: [] },
  why: { kind: 'question', scope: [] },
  construction: { kind: 'generate', scope: [] },
  profit: { kind: 'goal_change', scope: [] },
  solsticeOnly: { kind: 'goal_change', scope: ['all'] },
  unknown: { kind: 'question', scope: [] },
};

const FREE = { type: 'free', lineCodes: [], fromMonth: null, factorPpm: null };
const NO_GOAL = { partnerId: null, fromMonth: null, months: null, partnerIds: [], amountMinor: null, basis: null };

function scenario(phrase: Phrase): Record<string, unknown> {
  return phrase === 'construction' ? { type: 'cost_change', lineCodes: ['D5', 'D8'], fromMonth: '2026-09', factorPpm: 1_080_000 } : FREE;
}

function goal(phrase: Phrase): Record<string, unknown> {
  if (phrase === 'cover') return { ...NO_GOAL, type: 'funding_cover', partnerId: 'cedar', fromMonth: '2026-09', months: 6 };
  if (phrase === 'profit') return { ...NO_GOAL, type: 'net_profit_target', amountMinor: '1000000000', basis: 'delta' };
  // An unknown phrase never reaches this step (the router sends it to answerQuestion); irr_floor keeps the answer valid.
  return { ...NO_GOAL, type: 'irr_floor', partnerIds: ['solstice'] };
}

function answer(phrase: Phrase): Record<string, unknown> {
  return {
    answer:
      phrase === 'why'
        ? 'v2 выше v3 по правилам ранжирования сервера: IRR Solstice {{v2.irr.solstice}} против {{v3.irr.solstice}} при обещании {{approved.irr.solstice}}, чистая прибыль {{v2.d.netProfit}} против {{v3.d.netProfit}}.'
        : NO_ANSWER,
  };
}

function variantIdsOf(request: KaironLLMRequest): string[] {
  const schema = request.responseSchema?.schema as
    | { properties?: { variants?: { items?: { properties?: { id?: { enum?: unknown } } } } } }
    | undefined;
  const ids = schema?.properties?.variants?.items?.properties?.id?.enum;
  return Array.isArray(ids) ? ids.map(String) : [];
}

function topRankedOf(request: KaironLLMRequest): string {
  const marker = 'TOP-RANKED VARIANT: ';
  const user = request.messages.map((m) => m.content).join('\n');
  const at = user.indexOf(marker);
  if (at === -1) return '';
  const rest = user.slice(at + marker.length);
  const end = rest.indexOf('\n');
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

interface VariantText {
  whatWeDo: string;
  whatShifts: string;
  gives: string[];
  costs: string[];
}

const DELAY_TEXT: Record<string, Omit<VariantText, 'gives' | 'costs'>> = {
  v1: {
    whatWeDo: 'Принимаем задержку kolaudace и ничего не меняем в ценах и в финансировании.',
    whatShifts: 'Стройка, передачи и выход уходят на 3 месяца позже; деньги проходят дно в {{v1.troughMonth}} и возвращаются в плюс в {{v1.cashPositive}}.',
  },
  v2: {
    whatWeDo: 'Индексируем цены непроданных квартир на время задержки: рынок принимает рост цен.',
    whatShifts: 'Сроки как у задержки: деньги в плюс в {{v2.cashPositive}}.',
  },
  v3: {
    whatWeDo: 'Передаём первую очередь покупателям на месяц раньше второй.',
    whatShifts: 'Часть выручки приходит на месяц раньше, провал денег в {{v3.troughMonth}}.',
  },
};

function variantText(phrase: Phrase, id: string): VariantText {
  const child = id.includes('.');
  if (child && phrase === 'cover') {
    return {
      whatWeDo: 'Cedar вносит всю потребность в окне цели, Solstice в эти месяцы не вносит.',
      whatShifts: 'Меняются только транши в окне цели; стройка, продажи и выход как у родителя.',
      gives: ['Solstice не вносит деньги в окне цели.'],
      costs: ['Cedar вносит больше: IRR Cedar {{' + id + '.d.irr.cedar}} к родителю.', 'Проценты по источникам {{' + id + '.d.interest}} к родителю.'],
    };
  }
  if (child) {
    return {
      whatWeDo: 'Индексируем цены непроданных квартир, остальное как у родителя.',
      whatShifts: 'Сроки как у родителя.',
      gives: ['Чистая прибыль {{' + id + '.d.netProfit}} к родителю.'],
      costs: ['Покупатели платят больше за непроданные квартиры.'],
    };
  }
  if (phrase === 'construction') {
    const lever = CONSTRUCTION_LEVERS[id];
    return {
      whatWeDo: lever === undefined ? 'Принимаем удорожание стройки без рычагов: видна цена сценария.' : lever.rationale,
      whatShifts: 'Сроки не меняются; провал денег в {{' + id + '.troughMonth}}.',
      gives: [lever === undefined ? 'Цена удорожания видна без рычагов.' : 'Часть удорожания возвращена рычагом.'],
      costs: ['Чистая прибыль {{' + id + '.d.netProfit}} к активному прогнозу.'],
    };
  }
  return {
    whatWeDo: DELAY_TEXT[id]?.whatWeDo ?? 'Рычаг варианта.',
    whatShifts: DELAY_TEXT[id]?.whatShifts ?? '',
    gives: ['IRR Solstice {{' + id + '.irr.solstice}} при обещании {{approved.irr.solstice}}.'],
    costs: ['Чистая прибыль {{' + id + '.d.netProfit}}.'],
  };
}

const HEADLINES: Partial<Record<Phrase, string>> = {
  delay: 'Обещание партнёрам держится и без рычагов: задержка стоит {{v1.d.netProfit}} чистой прибыли и {{v1.d.irr.solstice}} IRR Solstice.',
  construction: 'Удорожание стройки стоит {{v1.d.netProfit}} чистой прибыли; рычаги возвращают часть, варианты идут по рангу сервера.',
  cover: 'Cedar покрывает потребность в окне цели: Solstice в эти месяцы не вносит, цена видна в IRR Cedar и в процентах.',
  profit: 'Цель по чистой прибыли проверена по каждому варианту; рычаг цены добавлен там, где цель не выполнена.',
  solsticeOnly: 'IRR Solstice проверен против обещания по каждому варианту; рычаг цены добавлен там, где он ниже.',
};

function explanation(request: KaironLLMRequest, phrase: Phrase): Record<string, unknown> {
  const ids = variantIdsOf(request);
  const top = topRankedOf(request) || ids[0] || 'v1';
  const headline = HEADLINES[phrase] ?? NO_ANSWER;
  return {
    headline,
    variants: ids.map((id) => {
      const text = variantText(phrase, id);
      return {
        id,
        whatWeDo: text.whatWeDo,
        whatShifts: text.whatShifts,
        result: `IRR Solstice {{${id}.irr.solstice}} при обещании {{approved.irr.solstice}}, Cedar {{${id}.irr.cedar}}; чистая прибыль {{${id}.d.netProfit}}, провал денег {{${id}.trough}}.`,
        verdict: `IRR Solstice {{${id}.irr.solstice}} при обещании {{approved.irr.solstice}}.`,
        gives: text.gives,
        costs: text.costs,
        stakeholders: [{ party: 'project', meaning: `Чистая прибыль {{${id}.d.netProfit}}.` }],
      };
    }),
    whyRecommended: `${top} ближе всех к обещанию и не опускается ниже: он не просит у покупателей и партнёров больше, чем стоит сценарий.`,
    recommendation: top,
    departureReason: null,
    caveats: [
      'Условия банка и даты траншей остаются как в базе; правило финансирования Kairon предлагает транши заново.',
      'Индексация цен относится и к уже законтрактованным квартирам: в плане нет разделения на проданные и свободные.',
    ],
    whyNotOthers: ids.filter((id) => id !== top).map((id) => ({ id, reason: `${id} ниже в ранге сервера.` })),
  };
}

function answerFor(request: KaironLLMRequest): Record<string, unknown> {
  const label = request.label ?? '';
  const phrase = phraseOf(request);
  if (label.startsWith('route')) return ROUTES[phrase];
  if (label.startsWith('structureScenario')) return scenario(phrase);
  if (label.startsWith('structureGoal')) return goal(phrase);
  if (label.startsWith('planWidgets')) return { widgets: [] };
  if (label.startsWith('explainVariants')) return explanation(request, phrase);
  if (label.startsWith('answerQuestion')) return answer(phrase);
  return proposal(request, phrase);
}

export function createSampleLLM(config: { emit: (event: ProgressEvent) => void }): LLMProvider {
  let calls = 0;
  return {
    name: 'kairon-sample',
    async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
      const r = request as KaironLLMRequest;
      const callId = `sample-${++calls}`;
      const label = r.label ?? '';
      const content = JSON.stringify(answerFor(r));
      config.emit({
        type: 'llm.request',
        payload: { callId, label, url: '(sample: no network call)', body: { model: SAMPLE_MODEL, messages: r.messages } },
      });
      config.emit({
        type: 'llm.done',
        payload: {
          callId, ms: 0, firstByteMs: null, firstReasoningMs: null, ttftMs: null, reasoningChars: 0,
          id: null, model: SAMPLE_MODEL, finishReason: 'stop', content, usage: { cost: 0 },
        },
      });
      return { content, model: SAMPLE_MODEL, finishReason: 'stop' };
    },
  };
}
