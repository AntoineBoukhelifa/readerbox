CREATE TABLE `feed_events` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`type` text NOT NULL,
	`work_id` text,
	`order_id` text,
	`shelf` text,
	`rating` real,
	`position` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `feed_events_created_idx` ON `feed_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `feed_events_member_work_idx` ON `feed_events` (`member_id`,`work_id`);--> statement-breakpoint
CREATE INDEX `feed_events_order_idx` ON `feed_events` (`order_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`work_id` text NOT NULL,
	`works_count` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_member_idx` ON `notifications` (`member_id`,`read_at`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_unread_unique_idx` ON `notifications` (`member_id`,`actor_id`,`work_id`) WHERE read_at is null;