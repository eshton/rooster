CREATE TABLE "ticket_watchers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_watchers_uq" ON "ticket_watchers" USING btree ("org_id","ticket_id","principal_id");