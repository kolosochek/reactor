// packages/reactor-service/src/db/repositories/PostgresPredictionsRepository.ts
//
// Implements PredictionsRepository SPI on top of the predictions table.
// Schema columns mirror SPI fields 1:1 (id, ideaId, toolName, expectedOutcome,
// confidence, rationale, createdAt). Confidence is stored as `real` to match
// the 0..1 float SPI. Service-side extras live in the metadata jsonb column.

import { eq, desc, and, gte, sql, type SQL } from 'drizzle-orm';
import { predictions } from '../schema.js';
import type { ReactorDb } from '../client.js';
import type {
  Prediction,
  PredictionsRepository,
  PredictionsQuery,
  ExperienceOutcome,
} from '@kolosochek/reactor-core';

export class PostgresPredictionsRepository implements PredictionsRepository {
  constructor(private readonly db: ReactorDb) {}

  async save(p: Prediction): Promise<void> {
    await this.db.insert(predictions).values({
      id: p.id,
      ideaId: p.ideaId ?? null,
      toolName: p.toolName,
      expectedOutcome: p.expectedOutcome,
      confidence: p.confidence,
      rationale: p.rationale,
      createdAt: new Date(p.createdAt),
      metadata: null,
    });
  }

  async list(query: PredictionsQuery = {}): Promise<Prediction[]> {
    const filters: SQL[] = [];
    if (query.toolName !== undefined) {
      filters.push(eq(predictions.toolName, query.toolName));
    }
    if (query.ideaId !== undefined) {
      filters.push(eq(predictions.ideaId, query.ideaId));
    }
    if (query.since !== undefined) {
      filters.push(gte(predictions.createdAt, new Date(query.since)));
    }

    const rows = await this.db
      .select()
      .from(predictions)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(predictions.createdAt))
      .limit(query.limit ?? 1000);

    return rows.map((row) => ({
      id: row.id,
      ideaId: row.ideaId ?? undefined,
      toolName: row.toolName,
      expectedOutcome: row.expectedOutcome as ExperienceOutcome,
      confidence: row.confidence,
      rationale: row.rationale,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
