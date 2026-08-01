CREATE TABLE `cascades` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`container_work_id` text NOT NULL,
	`action` text NOT NULL,
	`last_source` text,
	`last_external_id` text,
	`processed_count` integer DEFAULT 0 NOT NULL,
	`total_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`container_work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cascades_pending_idx` ON `cascades` (`completed_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `cascades_member_container_idx` ON `cascades` (`member_id`,`container_work_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cascades_pending_unique_idx` ON `cascades` (`member_id`,`container_work_id`) WHERE completed_at is null;--> statement-breakpoint
CREATE TABLE `entry_origins` (
	`entry_id` text NOT NULL,
	`container_work_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`entry_id`, `container_work_id`),
	FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`container_work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entry_origins_container_idx` ON `entry_origins` (`container_work_id`);