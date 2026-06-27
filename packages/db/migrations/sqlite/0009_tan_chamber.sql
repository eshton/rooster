CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`added_by_id` text NOT NULL,
	`url` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
