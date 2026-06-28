CREATE TABLE `context_files` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`ticket_id` text,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`author_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_files_org_project_idx` ON `context_files` (`org_id`,`project_id`);