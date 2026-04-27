// packages/reactor-service/src/routes/experience.ts
//
// GET /reactor/experience - read-only list of persisted ExperienceRecords.
// Query string maps to ExperienceQuery (toolName / outcome / since / limit
// per reactor-core 0.2.0 SPI). Decision #10 keeps schema 1:1 with SPI;
// extensions live in metadata jsonb and are not filterable here in v0.1.0.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { RepositoriesProvider } from '@kolosochek/reactor-core';

const QuerySchema = z.object({
  toolName: z.string().optional(),
  outcome: z.enum(['success', 'failure', 'partial']).optional(),
  since: z.string().optional(),
  limit: z.coerce.number().int().positive().max(10_000).optional(),
});

export function registerExperienceRoute(
  app: FastifyInstance,
  repositories: RepositoriesProvider,
): void {
  app.get('/reactor/experience', async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { class: 'RequestValidationError', message: parsed.error.message },
      });
    }
    const records = await repositories.experience.list(parsed.data);
    return reply.status(200).send({ records });
  });
}
