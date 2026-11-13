// Streaming OpenRouter provider with json_schema output and trace events
// (DEV-1364 stage 3): SSE parsing, time to first token, raw request and reply.

import { describe, expect, it, vi } from 'vitest';
import type { ProgressEvent } from '@kolosochek/reactor-core';
import { createSseParser, createStreamingOpenRouter, type KaironLLMRequest } from '../kairon/openrouter.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function clock(values: number[]): () => number {
  const queue = [...values];
  return () => queue.shift() ?? 0;
}

describe('kairon createSseParser', () => {
  it('joins lines split across chunks and skips comments and blank lines', () => {
    // SCENARIO: OpenRouter SSE arrives in arbitrary network chunks
    // INPUT: ": OPENROUTER PROCESSING", a data line split in two chunks, CRLF endings, [DONE]
    // EXPECTED: the two data payloads in order
    const seen: string[] = [];
    const parser = createSseParser((data) => seen.push(data));
    parser.push(': OPENROUTER PROCESSING\r\n\r\ndata: {"a"');
    parser.push(':1}\r\n\r\ndata: [DONE]\n');
    expect(seen).toEqual(['{"a":1}', '[DONE]']);
  });
});

describe('kairon createStreamingOpenRouter', () => {
  const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
  const request: KaironLLMRequest = {
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.2,
    maxTokens: 100,
    responseSchema: { name: 'proposal', schema },
    label: 'proposeVariants #1',
  };

  it('sends the json_schema request, measures the first token and returns the streamed content', async () => {
    // SCENARIO: a streamed reply in two content chunks plus a usage chunk
    // INPUT: clock 1000 (sent), 1010 (first byte), 1040 (first token), 1100 (done)
    // EXPECTED: events request -> first_byte (10 ms) -> first_token (40 ms) -> 2 deltas -> done; content '{"a":1}'
    const events: ProgressEvent[] = [];
    const fetchImpl = vi.fn(async () =>
      new Response(
        streamOf([
          'data: {"id":"gen-1","model":"google/gemini-3.8-flash","choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
          'data: {"id":"gen-1","choices":[{"delta":{"content":"{\\"a\\""}}]}\n\n',
          'data: {"id":"gen-1","choices":[{"delta":{"content":":1}"},"finish_reason":"stop"}]}\n\n',
          'data: {"id":"gen-1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"cost":0.0001}}\n\n',
          'data: [DONE]\n\n',
        ]),
        { status: 200 },
      ),
    );
    const llm = createStreamingOpenRouter({
      apiKey: 'sk-or-test',
      model: 'google/gemini-3.8-flash',
      emit: (e) => events.push(e),
      fetchImpl,
      now: clock([1000, 1010, 1040, 1100]),
    });

    const res = await llm.complete(request);

    expect(res).toEqual({
      content: '{"a":1}',
      model: 'google/gemini-3.8-flash',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://openrouter.ai/api/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: { authorization: 'Bearer sk-or-test', 'content-type': 'application/json' },
    }));
    expect(events.map((e) => e.type)).toEqual(['llm.request', 'llm.first_byte', 'llm.first_token', 'llm.delta', 'llm.delta', 'llm.done']);
    expect(events[0]?.payload).toEqual({
      callId: 'llm-1',
      label: 'proposeVariants #1',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      body: {
        model: 'google/gemini-3.8-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        usage: { include: true },
        temperature: 0.2,
        max_tokens: 100,
        response_format: { type: 'json_schema', json_schema: { name: 'proposal', strict: true, schema } },
      },
    });
    expect(events[1]?.payload).toEqual({ callId: 'llm-1', ms: 10 });
    expect(events[2]?.payload).toEqual({ callId: 'llm-1', ms: 40 });
    expect(events[5]?.payload).toEqual({
      callId: 'llm-1',
      ms: 100,
      firstByteMs: 10,
      firstReasoningMs: null,
      ttftMs: 40,
      reasoningChars: 0,
      id: 'gen-1',
      model: 'google/gemini-3.8-flash',
      finishReason: 'stop',
      content: '{"a":1}',
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.0001 },
    });
  });

  it('reports a provider refusal as an event and throws', async () => {
    // SCENARIO: the provider rejects a schema keyword
    // INPUT: HTTP 400 with an error body
    // EXPECTED: events request -> error (status 400, body); the call throws "OpenRouter 400: ..."
    const events: ProgressEvent[] = [];
    const llm = createStreamingOpenRouter({
      apiKey: 'sk-or-test',
      model: 'm',
      emit: (e) => events.push(e),
      fetchImpl: async () => new Response('{"error":{"message":"minimum not supported"}}', { status: 400 }),
      now: clock([1000, 1010]),
    });
    await expect(llm.complete(request)).rejects.toThrow('OpenRouter 400: {"error":{"message":"minimum not supported"}}');
    expect(events.map((e) => e.type)).toEqual(['llm.request', 'llm.error']);
    expect(events[1]?.payload).toEqual({
      callId: 'llm-1',
      ms: 10,
      status: 400,
      body: '{"error":{"message":"minimum not supported"}}',
    });
  });

  it('reports reasoning chunks before the first answer token', async () => {
    // SCENARIO: a thinking model streams reasoning first, then the answer
    // INPUT: clock 0 (sent), 5 (first byte), 30 (first reasoning), 900 (first token), 950 (done)
    // EXPECTED: first_reasoning at 30 ms, a reasoning delta, first_token at 900 ms; done counts 6 reasoning chars
    const events: ProgressEvent[] = [];
    const llm = createStreamingOpenRouter({
      apiKey: 'k',
      model: 'm',
      emit: (e) => events.push(e),
      fetchImpl: async () =>
        new Response(
          streamOf([
            ': OPENROUTER PROCESSING\n\n',
            'data: {"id":"g","choices":[{"delta":{"content":"","reasoning":"думаю"}}]}\n\n',
            'data: {"id":"g","choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ]),
          { status: 200 },
        ),
      now: clock([0, 5, 30, 900, 950]),
    });
    const res = await llm.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(res.content).toBe('{}');
    expect(events.map((e) => e.type)).toEqual([
      'llm.request', 'llm.first_byte', 'llm.first_reasoning', 'llm.reasoning', 'llm.first_token', 'llm.delta', 'llm.done',
    ]);
    expect(events[2]?.payload).toEqual({ callId: 'llm-1', ms: 30 });
    expect(events[3]?.payload).toEqual({ callId: 'llm-1', text: 'думаю' });
    const done = events[6]?.payload as { firstReasoningMs: number; ttftMs: number; reasoningChars: number };
    expect([done.firstReasoningMs, done.ttftMs, done.reasoningChars]).toEqual([30, 900, 5]);
  });

  it('retries once with the relaxed schema when the provider refuses the strict one', async () => {
    // SCENARIO: a provider answers 400 to enums and integer bounds
    // INPUT: 400 then a streamed {} reply; request carries schema and relaxedSchema
    // EXPECTED: llm-1 request -> error -> schema_relaxed -> llm-2 request with the relaxed schema -> reply
    const events: ProgressEvent[] = [];
    const replies = [
      new Response('{"error":{"message":"too many states"}}', { status: 400 }),
      new Response(streamOf(['data: {"id":"g","choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\n']), { status: 200 }),
    ];
    const llm = createStreamingOpenRouter({
      apiKey: 'k',
      model: 'm',
      emit: (e) => events.push(e),
      fetchImpl: async () => replies.shift() ?? new Response('', { status: 500 }),
      now: clock([0, 3, 10, 12, 20, 30]),
    });
    const strictSchema = { type: 'object', properties: { a: { type: 'integer', minimum: 1 } }, required: ['a'], additionalProperties: false };
    const relaxed = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'], additionalProperties: false };
    const res = await llm.complete({
      messages: [{ role: 'user', content: 'x' }],
      responseSchema: { name: 'p', schema: strictSchema, relaxedSchema: relaxed },
      label: 'proposeVariants, attempt 1',
    } as KaironLLMRequest);
    expect(res.content).toBe('{}');
    expect(events.map((e) => e.type)).toEqual([
      'llm.request', 'llm.error', 'llm.schema_relaxed', 'llm.request', 'llm.first_byte', 'llm.first_token', 'llm.delta', 'llm.done',
    ]);
    expect(events[2]?.payload).toEqual({ callId: 'llm-1', status: 400, body: '{"error":{"message":"too many states"}}' });
    const retry = events[3]?.payload as { callId: string; label: string; body: { response_format: { json_schema: { schema: unknown } } } };
    expect([retry.callId, retry.label]).toEqual(['llm-2', 'proposeVariants, attempt 1 (relaxed schema)']);
    expect(retry.body.response_format.json_schema.schema).toEqual(relaxed);
  });
});

