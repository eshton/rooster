CREATE TABLE `embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`model` text NOT NULL,
	`embedding` F32_BLOB(1536) NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embeddings_source_uq` ON `embeddings` (`org_id`,`source_type`,`source_id`);