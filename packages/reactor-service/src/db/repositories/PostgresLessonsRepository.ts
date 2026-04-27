// packages/reactor-service/src/db/repositories/PostgresLessonsRepository.ts
//
// Implements LessonsRepository SPI on top of the lessons table.
// Schema columns mirror the SPI base shape (id, topic, description, source,
// createdAt). Rich Lesson fields (domain, type, classification, evidence,
// outcomes, etc.) plus consumer-supplied metadata are merged into the
// metadata jsonb column. On read the blob is returned as the metadata field.

import { eq, desc, and, gte, sql, type SQL } from 'drizzle-orm';
import { lessons } from '../schema.js';
import type { ReactorDb } from '../client.js';
import type { Lesson, LessonsRepository, LessonsQuery } from '@kolosochek/reactor-core';

export class PostgresLessonsRepository implements LessonsRepository {
  constructor(private readonly db: ReactorDb) {}

  async upsert(lesson: Lesson): Promise<void> {
    const { id, topic, description, source, createdAt, metadata, ...rich } = lesson;
    const blob = { ...(metadata ?? {}), ...rich };
    const blobValue = Object.keys(blob).length > 0 ? sql`${blob}` : null;

    await this.db
      .insert(lessons)
      .values({
        id,
        topic,
        description,
        source: source ?? null,
        createdAt: new Date(createdAt),
        metadata: blobValue,
      })
      .onConflictDoUpdate({
        target: lessons.id,
        set: {
          topic,
          description,
          source: source ?? null,
          metadata: blobValue,
        },
      });
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(lessons).where(eq(lessons.id, id));
  }

  async list(query: LessonsQuery = {}): Promise<Lesson[]> {
    const filters: SQL[] = [];
    if (query.topic !== undefined) {
      filters.push(eq(lessons.topic, query.topic));
    }
    if (query.source !== undefined) {
      filters.push(eq(lessons.source, query.source));
    }
    if (query.since !== undefined) {
      filters.push(gte(lessons.createdAt, new Date(query.since)));
    }

    const rows = await this.db
      .select()
      .from(lessons)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(lessons.createdAt))
      .limit(query.limit ?? 1000);

    return rows.map((row) => {
      const md = (row.metadata as Record<string, unknown> | null) ?? undefined;
      return {
        id: row.id,
        topic: row.topic,
        description: row.description,
        source: row.source ?? undefined,
        createdAt: row.createdAt.toISOString(),
        metadata: md,
      } as Lesson;
    });
  }
}
