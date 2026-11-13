// packages/reactor-service/src/kairon/openrouter.ts
//
// Streaming OpenRouter provider for the forecast prototype (DEV-1364 stage 3).
// It differs from reactor-core's createOpenRouter in three ways: it streams
// (stream: true, server-sent events), it sends response_format json_schema
// with strict: true when the request carries a schema, and it emits trace
// events: the exact request body, the first byte of the stream, reasoning
// chunks, the first answer token, every delta and the final reply with usage
// and cost. When a provider refuses the strict schema (400) and the request
// carries a relaxed one, it retries once with it. The API key travels only in
// the header and is never emitted.

import type { LLMCompletionRequest, LLMCompletionResponse, LLMProvider, ProgressEvent } from '@kolosochek/reactor-core';

export interface KaironLLMRequest extends LLMCompletionRequest {
  /** relaxedSchema is retried once when the provider refuses schema (HTTP 400). */
  responseSchema?: { name: string; schema: Record<string, unknown>; relaxedSchema?: Record<string, unknown> };
  label?: string;
}

export interface StreamingOpenRouterConfig {
  apiKey: string;
  model: string;
  emit: (event: ProgressEvent) => void;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Splits a server-sent event stream into data payloads; comment and blank lines are skipped. */
export function createSseParser(onData: (data: string) => void): { push(chunk: string): void } {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.startsWith('data:')) onData(line.slice(5).trimStart());
      }
    },
  };
}

interface StreamChunk {
  id?: string;
  model?: string;
  error?: { message?: string };
  choices?: Array<{ delta?: { content?: string | null; reasoning?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
}

const FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'error']);

export function createStreamingOpenRouter(config: StreamingOpenRouterConfig): LLMProvider {
  const url = `${config.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`;
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  let calls = 0;

  type Sent = { ok: true; result: LLMCompletionResponse } | { ok: false; callId: string; status: number; text: string };

  async function send(r: KaironLLMRequest): Promise<Sent> {
    const callId = `llm-${++calls}`;
    const body: Record<string, unknown> = {
      model: r.model ?? config.model,
      messages: r.messages,
      stream: true,
      usage: { include: true },
    };
    if (r.temperature !== undefined) body.temperature = r.temperature;
    if (r.maxTokens !== undefined) body.max_tokens = r.maxTokens;
    if (r.responseSchema !== undefined) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: r.responseSchema.name, strict: true, schema: r.responseSchema.schema },
      };
    } else if (r.jsonMode === true) {
      body.response_format = { type: 'json_object' };
    }
    config.emit({ type: 'llm.request', payload: { callId, label: r.label, url, body } });

    const started = now();
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: r.signal,
    });
    if (!resp.ok || resp.body === null) {
      const text = await resp.text();
      config.emit({ type: 'llm.error', payload: { callId, ms: now() - started, status: resp.status, body: text } });
      return { ok: false, callId, status: resp.status, text };
    }

    let content = '';
    let firstByteMs: number | null = null;
    let firstReasoningMs: number | null = null;
    let ttftMs: number | null = null;
    let reasoningChars = 0;
    let id: string | null = null;
    let model = String(body.model);
    let finishReason = 'stop';
    let usage: StreamChunk['usage'] | null = null;
    const parser = createSseParser((data) => {
      if (data === '[DONE]') return;
      const chunk = JSON.parse(data) as StreamChunk;
      if (chunk.error !== undefined) throw new Error(`OpenRouter stream error: ${chunk.error.message ?? data}`);
      id = id ?? chunk.id ?? null;
      model = chunk.model ?? model;
      if (chunk.usage !== undefined) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
      const reasoning = choice?.delta?.reasoning;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (firstReasoningMs === null) {
          firstReasoningMs = now() - started;
          config.emit({ type: 'llm.first_reasoning', payload: { callId, ms: firstReasoningMs } });
        }
        reasoningChars += reasoning.length;
        config.emit({ type: 'llm.reasoning', payload: { callId, text: reasoning } });
      }
      const delta = choice?.delta?.content;
      if (typeof delta !== 'string' || delta.length === 0) return;
      if (ttftMs === null) {
        ttftMs = now() - started;
        config.emit({ type: 'llm.first_token', payload: { callId, ms: ttftMs } });
      }
      content += delta;
      config.emit({ type: 'llm.delta', payload: { callId, text: delta } });
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      if (firstByteMs === null) {
        firstByteMs = now() - started;
        config.emit({ type: 'llm.first_byte', payload: { callId, ms: firstByteMs } });
      }
      parser.push(decoder.decode(read.value, { stream: true }));
    }

    const done = {
      callId,
      ms: now() - started,
      firstByteMs,
      firstReasoningMs,
      ttftMs,
      reasoningChars,
      id,
      model,
      finishReason,
      content,
      usage,
    };
    config.emit({ type: 'llm.done', payload: done });
    const result: LLMCompletionResponse = {
      content,
      model,
      finishReason: (FINISH_REASONS.has(finishReason) ? finishReason : 'stop') as LLMCompletionResponse['finishReason'],
    };
    const u = usage as StreamChunk['usage'] | null;
    if (u !== null && u !== undefined) {
      result.usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens };
    }
    return { ok: true, result };
  }

  return {
    name: 'openrouter-streaming',
    async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
      const r = req as KaironLLMRequest;
      let sent = await send(r);
      const relaxed = r.responseSchema?.relaxedSchema;
      if (!sent.ok && sent.status === 400 && r.responseSchema !== undefined && relaxed !== undefined) {
        config.emit({ type: 'llm.schema_relaxed', payload: { callId: sent.callId, status: sent.status, body: sent.text } });
        sent = await send({
          ...r,
          responseSchema: { name: r.responseSchema.name, schema: relaxed },
          label: `${r.label ?? 'llm'} (relaxed schema)`,
        });
      }
      if (!sent.ok) throw new Error(`OpenRouter ${sent.status}: ${sent.text.slice(0, 500)}`);
      return sent.result;
    },
  };
}
