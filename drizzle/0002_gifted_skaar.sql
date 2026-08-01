CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`work_id` text NOT NULL,
	`shelf` text NOT NULL,
	`abandoned_at` integer,
	`declared_position` real,
	`total_length` integer,
	`rating` real,
	`provenance` text NOT NULL,
	`provenance_member_id` text,
	`provenance_order_id` text,
	`origin` text DEFAULT 'directe' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provenance_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_entries_member_work_idx` ON `journal_entries` (`member_id`,`work_id`);--> statement-breakpoint
CREATE INDEX `journal_entries_work_idx` ON `journal_entries` (`work_id`);--> statement-breakpoint
CREATE INDEX `journal_entries_member_shelf_idx` ON `journal_entries` (`member_id`,`shelf`);--> statement-breakpoint
CREATE TABLE `reach_crossings` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`work_id` text NOT NULL,
	`direction` text NOT NULL,
	`created_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reach_crossings_pending_idx` ON `reach_crossings` (`processed_at`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `reach_crossings_pending_unique_idx` ON `reach_crossings` (`member_id`,`work_id`) WHERE processed_at is null;--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`body` text NOT NULL,
	`position_at_writing` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_entry_idx` ON `reviews` (`entry_id`);