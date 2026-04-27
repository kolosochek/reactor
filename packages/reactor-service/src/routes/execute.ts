// packages/reactor-service/src/routes/execute.ts
//
// POST /reactor/execute - the core endpoint. Validates the request body
// (Zod), constructs a per-request Reactor with the request-scoped LLM,
// dispatches Reactor.execute, and surfaces either the Solution or a typed
// error mapped to HTTP via mapErrorToResponse.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Idea, RepositoriesProvider } from '@kolosochek/reactor-core';
import { buildLLMProvider } from '../reactor/llmFromConfig.js';
import { buildReactor } from '../reactor/buildReactor.js';
import { mapErrorToResponse } from './errorMapper.js';

const ProviderConfigSchema = z.object({
  provider: z.literal('openrouter'),
  model: z.string().min(1),
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
});

const RequestBodySchema = z.object({
  idea: z.object({
    schema: z.unknown(),
    context: z.array(z.unknown()),
    solution: z.unknown().nullable(),
  }),
  providerConfig: ProviderConfigSchema,
});

export function registerExecuteRoute(
  app: FastifyInstance,
  repositories: RepositoriesProvider,
): void {
  app.post('/reactor/execute', async (request, reply) => {
    const parsed = RequestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { class: 'RequestValidationError', message: parsed.error.message },
      });
    }

    try {
      const llm = buildLLMProvider(parsed.data.providerConfig);
      const reactor = buildReactor(llm, repositories);
      const solution = await reactor.execute(parsed.data.idea as Idea);
      return reply.status(200).send({ solution });
    } catch (err) {
      const mapped = mapErrorToResponse(err);
      return reply.status(mapped.status).send(mapped.body);
    }
  });
}
