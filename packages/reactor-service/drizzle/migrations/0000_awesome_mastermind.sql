CREATE TABLE IF NOT EXISTS "experience" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"tool_name" varchar(128) NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"outcome" varchar(32) NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ideas" (
	"id" serial PRIMARY KEY NOT NULL,
	"schema" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"solution" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lessons" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"topic" varchar(256) NOT NULL,
	"description" text NOT NULL,
	"source" varchar(256),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "predictions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"idea_id" varchar(64),
	"tool_name" varchar(128) NOT NULL,
	"expected_outcome" varchar(32) NOT NULL,
	"confidence" real NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tools" (
	"tool_ref" varchar(128) PRIMARY KEY NOT NULL,
	"classification" varchar(32) NOT NULL,
	"metrics" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_tool_name_idx" ON "experience" ("tool_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_outcome_idx" ON "experience" ("outcome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_created_at_idx" ON "experience" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ideas_created_at_idx" ON "ideas" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lessons_source_idx" ON "lessons" ("source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lessons_created_at_idx" ON "lessons" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "predictions_tool_name_idx" ON "predictions" ("tool_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "predictions_idea_id_idx" ON "predictions" ("idea_id");