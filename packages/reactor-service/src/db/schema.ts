// packages/reactor-service/src/db/schema.ts
//
// Drizzle schema for the 5 SPI repositories. Tables match @kolosochek/reactor-core
// RepositoriesProvider interface. jsonb columns hold structured payloads
// (input/output/lineage) so future indexed queries on inner fields don't need
// schema migrations (e.g., `WHERE idea_meta->>'domain' = 'hhru'`).

import { pgTable, serial, text, timestamp, jsonb, integer, varchar, index } from 'drizzle-orm/pg-core';

export const experience = pgTable(
  'experience',
  {
    id: serial('id').primaryKey(),
    toolName: varchar('tool_name', { length: 128 }).notNull(),
    domain: varchar('domain', { length: 128 }).notNull(),
    input: jsonb('input').notNull(),
    output: jsonb('output').notNull(),
    outcome: varchar('outcome', { length: 32 }).notNull(), // 'success' | 'failure'
    errorMessage: text('error_message'),
    errorClass: varchar('error_class', { length: 128 }),
    durationMs: integer('duration_ms').notNull(),
    ideaMeta: jsonb('idea_meta').notNull(), // lineage from Acts/016 Agent/Meta
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    byToolName: index('experience_tool_name_idx').on(t.toolName),
    byDomain: index('experience_domain_idx').on(t.domain),
    byOutcome: index('experience_outcome_idx').on(t.outcome),
    byCreatedAt: index('experience_created_at_idx').on(t.createdAt),
  }),
);

export const lessons = pgTable(
  'lessons',
  {
    id: serial('id').primaryKey(),
    domain: varchar('domain', { length: 128 }).notNull(),
    type: varchar('type', { length: 32 }).notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    evidence: jsonb('evidence'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    byDomain: index('lessons_domain_idx').on(t.domain),
    byType: index('lessons_type_idx').on(t.type),
  }),
);

export const ideas = pgTable(
  'ideas',
  {
    id: serial('id').primaryKey(),
    domain: varchar('domain', { length: 128 }).notNull(),
    path: varchar('path', { length: 512 }).notNull(),
    version: varchar('version', { length: 32 }).notNull(),
    parentRef: varchar('parent_ref', { length: 512 }),
    schema: jsonb('schema').notNull(),
    context: jsonb('context').notNull(),
    solution: jsonb('solution'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    byDomain: index('ideas_domain_idx').on(t.domain),
    byPath: index('ideas_path_idx').on(t.path),
    byParentRef: index('ideas_parent_ref_idx').on(t.parentRef),
  }),
);

export const predictions = pgTable('predictions', {
  id: serial('id').primaryKey(),
  activity: varchar('activity', { length: 128 }).notNull(),
  expected: jsonb('expected').notNull(),
  actual: jsonb('actual'),
  confidence: integer('confidence'), // 0-100
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const tools = pgTable('tools', {
  name: varchar('name', { length: 128 }).primaryKey(),
  classification: varchar('classification', { length: 32 }).notNull(),
  metrics: jsonb('metrics').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
