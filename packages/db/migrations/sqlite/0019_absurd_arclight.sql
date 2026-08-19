CREATE TABLE `deals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`title` text NOT NULL,
	`pipeline_stage` text DEFAULT 'prospecting' NOT NULL,
	`value` integer,
	`currency` text,
	`close_date` text,
	`probability` integer,
	`owner_id` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deals_org_customer_idx` ON `deals` (`org_id`,`customer_id`);