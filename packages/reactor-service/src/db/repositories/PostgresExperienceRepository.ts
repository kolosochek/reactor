// packages/reactor-service/src/db/repositories/PostgresExperienceRepository.ts
//
// Implements ExperienceRepository SPI on top of the experience table.
// Schema is 1:1 with the SPI shape; service-side extensions live in metadata.

import { eq, desc, and, gte, sql, type SQL } from 'drizzle-orm';
import { experience } from '../schema.js';
import type { ReactorDb } from '../client.js';
import type {
  ExperienceRecord,
  ExperienceRepository,
  ExperienceQuery,
  ExperienceOutcome,
} from '@kolosochek/reactor-core';

export class PostgresExperienceRepository implements ExperienceRepository {
  constructor(private readonly db: ReactorDb) {}

  async append(rec: ExperienceRecord): Promise<void> {
    await this.db.insert(experience).values({
      id: rec.id,
      toolName: rec.toolName,
      input: sql`${rec.input}`,
      output: sql`${rec.output}`,
      outcome: rec.outcome,
      durationMs: rec.durationMs,
      createdAt: new Date(rec.createdAt),
      metadata: rec.metadata !== undefined && rec.metadata !== null ? sql`${rec.metadata}` : null,
    });
  }

  async list(query: ExperienceQuery = {}): Promise<ExperienceRecord[]> {
    const filters: SQL[] = [];
    if (query.toolName !== undefined) {
      filters.push(eq(experience.toolName, query.toolName));
    }
    if (query.outcome !== undefined) {
      filters.push(eq(experience.outcome, query.outcome));
    }
    if (query.since !== undefined) {
      filters.push(gte(experience.createdAt, new Date(query.since)));
    }

    const rows = await this.db
      .select()
      .from(experience)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(experience.createdAt))
      .limit(query.limit ?? 1000);

    return rows.map((row) => ({
      id: row.id,
      toolName: row.toolName,
      input: row.input,
      output: row.output,
      outcome: row.outcome as ExperienceOutcome,
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    }));
  }
}
