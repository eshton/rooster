CREATE TABLE `ticket_assignees` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_assignees_uq` ON `ticket_assignees` (`org_id`,`ticket_id`,`principal_id`);