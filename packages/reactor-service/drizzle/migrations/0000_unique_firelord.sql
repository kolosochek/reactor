CREATE TABLE IF NOT EXISTS "experience" (
	"id" serial PRIMARY KEY NOT NULL,
	"tool_name" varchar(128) NOT NULL,
	"domain" varchar(128) NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"outcome" varchar(32) NOT NULL,
	"error_message" text,
	"error_class" varchar(128),
	"duration_ms" integer NOT NULL,
	"idea_meta" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ideas" (
	"id" serial PRIMARY KEY NOT NULL,
	"domain" varchar(128) NOT NULL,
	"path" varchar(512) NOT NULL,
	"version" varchar(32) NOT NULL,
	"parent_ref" varchar(512),
	"schema" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"solution" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lessons" (
	"id" serial PRIMARY KEY NOT NULL,
	"domain" varchar(128) NOT NULL,
	"type" varchar(32) NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"activity" varchar(128) NOT NULL,
	"expected" jsonb NOT NULL,
	"actual" jsonb,
	"confidence" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tools" (
	"name" varchar(128) PRIMARY KEY NOT NULL,
	"classification" varchar(32) NOT NULL,
	"metrics" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_tool_name_idx" ON "experience" ("tool_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_domain_idx" ON "experience" ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_outcome_idx" ON "experience" ("outcome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_created_at_idx" ON "experience" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ideas_domain_idx" ON "ideas" ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ideas_path_idx" ON "ideas" ("path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ideas_parent_ref_idx" ON "ideas" ("parent_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lessons_domain_idx" ON "lessons" ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lessons_type_idx" ON "lessons" ("type");