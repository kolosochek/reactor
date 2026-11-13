// packages/reactor-service/src/kairon/sampleLlm.ts
//
// A provider with canned answers for the forecast prototype page (DEV-1364
// stage 4). It lets the page run the whole batch plan for free: the reactor,
// the four tools, Kairon evaluate and the trace are real; only the two LLM
// answers are prepared in advance for Rivergate's kolaudace +3 scenario.
// Picked on the page as the model "kairon/sample-no-llm"; it calls no network.

import type { LLMCompletionRequest, LLMCompletionResponse, LLMProvider, ProgressEvent } from '@kolosochek/reactor-core';
import type { KaironLLMRequest } from './openrouter.js';

export const SAMPLE_MODEL = 'kairon/sample-no-llm';

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

const VARIANT_TEXT: Record<string, { whatWeDo: string; whatShifts: string }> = {
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

function explanation(request: KaironLLMRequest): Record<string, unknown> {
  const ids = variantIdsOf(request);
  const top = topRankedOf(request) || ids[0] || 'v1';
  return {
    headline:
      'Обещание партнёрам держится и без рычагов: задержка стоит {{v1.d.netProfit}} чистой прибыли и {{v1.d.irr.solstice}} IRR Solstice.',
    variants: ids.map((id) => ({
      id,
      whatWeDo: VARIANT_TEXT[id]?.whatWeDo ?? 'Рычаг варианта.',
      whatShifts: VARIANT_TEXT[id]?.whatShifts ?? '',
      result: `IRR Solstice {{${id}.irr.solstice}} при обещании {{approved.irr.solstice}}, Cedar {{${id}.irr.cedar}}; чистая прибыль {{${id}.d.netProfit}}, провал денег {{${id}.trough}}.`,
    })),
    whyRecommended: `${top} ближе всех к обещанию и не опускается ниже: он не просит у покупателей и партнёров больше, чем стоит задержка.`,
    recommendation: top,
    departureReason: null,
    caveats: [
      'Условия банка и даты траншей остаются как в базе; правило финансирования Kairon предлагает транши заново.',
      'Индексация цен относится и к уже законтрактованным квартирам: в плане нет разделения на проданные и свободные.',
    ],
  };
}

export function createSampleLLM(config: { emit: (event: ProgressEvent) => void }): LLMProvider {
  let calls = 0;
  return {
    name: 'kairon-sample',
    async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
      const r = request as KaironLLMRequest;
      const callId = `sample-${++calls}`;
      const label = r.label ?? '';
      const answer = label.startsWith('explainVariants') ? explanation(r) : PROPOSAL;
      const content = JSON.stringify(answer);
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
