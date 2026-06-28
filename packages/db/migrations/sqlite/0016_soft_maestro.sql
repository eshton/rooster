CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`stage` text NOT NULL,
	`author_id` text NOT NULL,
	`role` text NOT NULL,
	`kind` text DEFAULT 'text' NOT NULL,
	`seq` integer NOT NULL,
	`body` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversation_messages_org_ticket_stage_seq_idx` ON `conversation_messages` (`org_id`,`ticket_id`,`stage`,`seq`);