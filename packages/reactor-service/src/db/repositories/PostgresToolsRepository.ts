// packages/reactor-service/src/db/repositories/PostgresToolsRepository.ts
//
// Implements ToolsRepository SPI on top of the tools table. PK is toolRef
// (varchar). The full ToolMetrics blob is stored in the metrics jsonb column;
// classification is duplicated as a top-level column to support equality
// filtering without jsonb path expressions. Other ToolsQuery filters (domain,
// minSuccessRate, minTotalExecutions, capabilityName) reach into the jsonb blob.

import { eq, and, sql, type SQL } from 'drizzle-orm';
import { tools } from '../schema.js';
import type { ReactorDb } from '../client.js';
import type { ToolsRepository, ToolsQuery, ToolMetrics } from '@kolosochek/reactor-core';

export class PostgresToolsRepository implements ToolsRepository {
  constructor(private readonly db: ReactorDb) {}

  async upsert(metric: ToolMetrics): Promise<void> {
    await this.db
      .insert(tools)
      .values({
        toolRef: metric.toolRef,
        classification: metric.classification,
        metrics: sql`${metric}`,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: tools.toolRef,
        set: {
          classification: metric.classification,
          metrics: sql`${metric}`,
          updatedAt: new Date(),
        },
      });
  }

  async get(toolRef: string): Promise<ToolMetrics | null> {
    const rows = await this.db.select().from(tools).where(eq(tools.toolRef, toolRef)).limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return row.metrics as ToolMetrics;
  }

  async list(query: ToolsQuery = {}): Promise<ToolMetrics[]> {
    const filters: SQL[] = [];
    if (query.classification !== undefined) {
      filters.push(eq(tools.classification, query.classification));
    }
    if (query.domain !== undefined) {
      filters.push(sql`${tools.metrics}->>'domain' = ${query.domain}`);
    }
    if (query.capabilityName !== undefined) {
      filters.push(sql`${tools.metrics}->>'capabilityName' = ${query.capabilityName}`);
    }
    if (query.minSuccessRate !== undefined) {
      filters.push(sql`(${tools.metrics}->>'successRate')::real >= ${query.minSuccessRate}`);
    }
    if (query.minTotalExecutions !== undefined) {
      filters.push(sql`(${tools.metrics}->>'totalExecutions')::integer >= ${query.minTotalExecutions}`);
    }

    const rows = await this.db
      .select()
      .from(tools)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .limit(query.limit ?? 1000);

    return rows.map((row) => row.metrics as ToolMetrics);
  }
}
