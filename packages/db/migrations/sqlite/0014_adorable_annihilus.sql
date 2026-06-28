CREATE INDEX `audit_log_org_created_idx` ON `audit_log` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `comments_org_ticket_idx` ON `comments` (`org_id`,`ticket_id`);--> statement-breakpoint
CREATE INDEX `ticket_assignees_org_principal_idx` ON `ticket_assignees` (`org_id`,`principal_id`);--> statement-breakpoint
CREATE INDEX `tickets_org_project_status_idx` ON `tickets` (`org_id`,`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `tickets_org_assignee_idx` ON `tickets` (`org_id`,`assignee_id`);--> statement-breakpoint
CREATE INDEX `tickets_org_milestone_idx` ON `tickets` (`org_id`,`milestone_id`);