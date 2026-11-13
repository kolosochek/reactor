// packages/reactor-service/src/kairon/models.ts
//
// Models offered by the forecast prototype page (DEV-1364 stage 3): the live
// OpenRouter catalog, limited to models that accept response_format
// json_schema (supported_parameters has "structured_outputs"). The catalog is
// public; it is cached for 10 minutes. Prices are USD per 1M tokens.

import { z } from 'zod';

export const DEFAULT_MODEL = 'google/gemini-3.8-flash';

const PREFERRED = [
  DEFAULT_MODEL,
  'google/gemini-3.5-flash',
  'google/gemini-3.1-pro-preview',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-opus-5.5',
  'openai/gpt-5.5',
  'openai/gpt-5.4-mini',
];

const CatalogShape = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      context_length: z.number().nullable().optional(),
      pricing: z.object({ prompt: z.string(), completion: z.string() }).partial().optional(),
      supported_parameters: z.array(z.string()).nullable().optional(),
    }),
  ),
});

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  promptUsdPerMTok: number | null;
  completionUsdPerMTok: number | null;
  preferred: boolean;
}

function perMillion(price: string | undefined): number | null {
  if (price === undefined) return null;
  return Math.round(Number(price) * 1e10) / 1e4;
}

export function selectStructuredModels(catalog: unknown): ModelInfo[] {
  const models = CatalogShape.parse(catalog)
    .data.filter((m) => !m.id.endsWith(':batch') && (m.supported_parameters ?? []).includes('structured_outputs'))
    .map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length ?? null,
      promptUsdPerMTok: perMillion(m.pricing?.prompt),
      completionUsdPerMTok: perMillion(m.pricing?.completion),
      preferred: PREFERRED.includes(m.id),
    }));
  const rank = (id: string) => {
    const i = PREFERRED.indexOf(id);
    return i === -1 ? PREFERRED.length : i;
  };
  return models.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; models: ModelInfo[] } | null = null;

export async function loadStructuredModels(fetchImpl: typeof fetch = fetch): Promise<{ source: string; models: ModelInfo[] }> {
  if (cache !== null && Date.now() - cache.at < CACHE_MS) return { source: 'openrouter (cached)', models: cache.models };
  try {
    const resp = await fetchImpl('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`catalog ${resp.status}`);
    const models = selectStructuredModels(await resp.json());
    cache = { at: Date.now(), models };
    return { source: 'openrouter', models };
  } catch {
    const fallback = PREFERRED.map((id) => ({
      id,
      name: id,
      contextLength: null,
      promptUsdPerMTok: null,
      completionUsdPerMTok: null,
      preferred: true,
    }));
    return { source: 'fallback (catalog unreachable)', models: fallback };
  }
}
