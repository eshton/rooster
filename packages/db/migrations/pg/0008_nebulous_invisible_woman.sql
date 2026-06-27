CREATE TABLE "ticket_links" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"from_ticket_id" text NOT NULL,
	"to_ticket_id" text NOT NULL,
	"type" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_links_uq" ON "ticket_links" USING btree ("org_id","from_ticket_id","to_ticket_id","type");