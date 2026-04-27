// packages/reactor-service/src/db/repositories/PostgresIdeasRepository.ts
//
// Implements IdeaRepository SPI on top of the ideas table.
// Schema stores the Idea triplet (schema/context/solution) as jsonb columns;
// IdeaMeta extracted from solution.meta or context (MetaMessage) is stored
// separately in the metadata jsonb column to support domain filtering.
// id is a serial integer; SPI returns it as String(id).

import { eq, desc, and, gte, sql, type SQL } from 'drizzle-orm';
import { ideas } from '../schema.js';
import type { ReactorDb } from '../client.js';
import type {
  Idea,
  IdeaRepository,
  IdeasQuery,
  IdeaMeta,
  Solution,
  Message,
} from '@kolosochek/reactor-core';
import { extractMeta } from '@kolosochek/reactor-core';

export class PostgresIdeasRepository implements IdeaRepository {
  constructor(private readonly db: ReactorDb) {}

  async save(idea: Idea, solution: Solution | null): Promise<string> {
    const meta: IdeaMeta | undefined = solution?.meta ?? extractMeta(idea.context);
    const rows = await this.db
      .insert(ideas)
      .values({
        schema: sql`${idea.schema}`,
        context: sql`${idea.context}`,
        solution: solution !== null ? sql`${solution}` : null,
        metadata: meta !== undefined ? sql`${meta}` : null,
      })
      .returning({ id: ideas.id });

    const inserted = rows[0];
    if (!inserted) {
      throw new Error('PostgresIdeasRepository.save: insert returned no rows');
    }
    return String(inserted.id);
  }

  async load(id: string): Promise<{ idea: Idea; solution: Solution | null } | null> {
    const numId = Number.parseInt(id, 10);
    if (Number.isNaN(numId)) {
      return null;
    }

    const rows = await this.db.select().from(ideas).where(eq(ideas.id, numId)).limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }

    const solution = row.solution as Solution | null;
    return {
      idea: {
        schema: row.schema as Idea['schema'],
        context: row.context as Message[],
        solution,
      },
      solution,
    };
  }

  async list(query: IdeasQuery = {}): Promise<Array<{ id: string; meta: IdeaMeta }>> {
    const filters: SQL[] = [];
    if (query.domain !== undefined) {
      filters.push(sql`${ideas.metadata}->>'domain' = ${query.domain}`);
    }
    if (query.hasSolution === true) {
      filters.push(sql`${ideas.solution} IS NOT NULL`);
    }
    if (query.hasSolution === false) {
      filters.push(sql`${ideas.solution} IS NULL`);
    }
    if (query.since !== undefined) {
      filters.push(gte(ideas.createdAt, new Date(query.since)));
    }

    const rows = await this.db
      .select()
      .from(ideas)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(ideas.createdAt))
      .limit(query.limit ?? 1000);

    return rows.map((row) => {
      const stored = row.metadata as IdeaMeta | null;
      const ctx = Array.isArray(row.context) ? (row.context as Message[]) : [];
      const fromContext = extractMeta(ctx);
      const meta: IdeaMeta = stored ?? fromContext ?? {
        domain: '',
        path: '',
        version: '',
        branches: [],
        createdAt: row.createdAt.toISOString(),
      };
      return { id: String(row.id), meta };
    });
  }
}
