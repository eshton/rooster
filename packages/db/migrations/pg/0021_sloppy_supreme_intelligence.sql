ALTER TABLE "projects" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deal_id" text;--> statement-breakpoint
CREATE INDEX "projects_org_deal_idx" ON "projects" USING btree ("org_id","deal_id");--> statement-breakpoint
CREATE INDEX "projects_org_customer_idx" ON "projects" USING btree ("org_id","customer_id");