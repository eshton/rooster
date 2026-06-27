PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`key` text,
	`name` text NOT NULL,
	`ticket_seq` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_teams`("id", "org_id", "key", "name", "ticket_seq", "created_at", "updated_at") SELECT "id", "org_id", "key", "name", "ticket_seq", "created_at", "updated_at" FROM `teams`;--> statement-breakpoint
DROP TABLE `teams`;--> statement-breakpoint
ALTER TABLE `__new_teams` RENAME TO `teams`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `teams_org_key_uq` ON `teams` (`org_id`,`key`);--> statement-breakpoint
ALTER TABLE `projects` ADD `key` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `ticket_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_key_uq` ON `projects` (`org_id`,`key`);