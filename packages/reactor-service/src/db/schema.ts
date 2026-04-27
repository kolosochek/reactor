// packages/reactor-service/src/db/schema.ts
//
// Drizzle schema aligned 1:1 with @kolosochek/reactor-core 0.2.0 SPI shapes.
// Service-side extensions (domain, errorMessage, ideaMeta, etc.) live in the
// `metadata` jsonb column, never as first-class columns. Future indexed
// queries on inner fields use jsonb path expressions (e.g.,
// `WHERE metadata->>'domain' = 'hhru'`) without schema migration.
//
// Outcome enum is varchar(32), not a PG enum: SPI allows 'partial', but
// Decision #7 forbids partial writes. Enforcement happens above the repo
// layer (route/service validator), not in the column constraint.

import { pgTable, serial, text, timestamp, jsonb, integer, real, varchar, index } from 'drizzle-orm/pg-core';

export const experience = pgTable(
  'experience',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    toolName: varchar('tool_name', { length: 128 }).notNull(),
    input: jsonb('input').notNull(),
    output: jsonb('output').notNull(),
    outcome: varchar('outcome', { length: 32 }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    metadata: jsonb('metadata'),
  },
  (t) => ({
    byToolName: index('experience_tool_name_idx').on(t.toolName),
    byOutcome: index('experience_outcome_idx').on(t.outcome),
    byCreatedAt: index('experience_created_at_idx').on(t.createdAt),
  }),
);

export const lessons = pgTable(
  'lessons',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    topic: varchar('topic', { length: 256 }).notNull(),
    description: text('description').notNull(),
    source: varchar('source', { length: 256 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    metadata: jsonb('metadata'),
  },
  (t) => ({
    bySource: index('lessons_source_idx').on(t.source),
    byCreatedAt: index('lessons_created_at_idx').on(t.createdAt),
  }),
);

export const ideas = pgTable(
  'ideas',
  {
    id: serial('id').primaryKey(),
    schema: jsonb('schema').notNull(),
    context: jsonb('context').notNull(),
    solution: jsonb('solution'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    metadata: jsonb('metadata'),
  },
  (t) => ({
    byCreatedAt: index('ideas_created_at_idx').on(t.createdAt),
  }),
);

export const predictions = pgTable(
  'predictions',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    ideaId: varchar('idea_id', { length: 64 }),
    toolName: varchar('tool_name', { length: 128 }).notNull(),
    expectedOutcome: varchar('expected_outcome', { length: 32 }).notNull(),
    confidence: real('confidence').notNull(),
    rationale: text('rationale').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    metadata: jsonb('metadata'),
  },
  (t) => ({
    byToolName: index('predictions_tool_name_idx').on(t.toolName),
    byIdeaId: index('predictions_idea_id_idx').on(t.ideaId),
  }),
);

export const tools = pgTable('tools', {
  toolRef: varchar('tool_ref', { length: 128 }).primaryKey(),
  classification: varchar('classification', { length: 32 }).notNull(),
  metrics: jsonb('metrics').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
