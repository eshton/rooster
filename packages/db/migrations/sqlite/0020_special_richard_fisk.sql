CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`author_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interactions_org_target_idx` ON `interactions` (`org_id`,`target_type`,`target_id`);