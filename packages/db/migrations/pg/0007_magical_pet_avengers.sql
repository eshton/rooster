ALTER TABLE "teams" ALTER COLUMN "key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ticket_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_key_uq" ON "projects" USING btree ("org_id","key");