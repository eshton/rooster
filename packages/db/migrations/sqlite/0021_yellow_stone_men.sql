ALTER TABLE `projects` ADD `customer_id` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `deal_id` text;--> statement-breakpoint
CREATE INDEX `projects_org_deal_idx` ON `projects` (`org_id`,`deal_id`);--> statement-breakpoint
CREATE INDEX `projects_org_customer_idx` ON `projects` (`org_id`,`customer_id`);