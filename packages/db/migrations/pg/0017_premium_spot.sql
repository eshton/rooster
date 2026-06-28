CREATE TABLE "context_files" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"ticket_id" text,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"author_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"stage" text NOT NULL,
	"author_id" text NOT NULL,
	"role" text NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"seq" integer NOT NULL,
	"body" text NOT NULL,
	"metadata" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "context_files_org_project_idx" ON "context_files" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_org_ticket_stage_seq_idx" ON "conversation_messages" USING btree ("org_id","ticket_id","stage","seq");