CREATE TABLE `order_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`work_id` text NOT NULL,
	`rank` integer NOT NULL,
	`optional` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_entries_order_rank_idx` ON `order_entries` (`order_id`,`rank`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_entries_order_work_idx` ON `order_entries` (`order_id`,`work_id`);--> statement-breakpoint
CREATE INDEX `order_entries_work_idx` ON `order_entries` (`work_id`);--> statement-breakpoint
CREATE TABLE `order_follows` (
	`order_id` text NOT NULL,
	`member_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`order_id`, `member_id`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_follows_member_idx` ON `order_follows` (`member_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`forked_from_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`forked_from_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orders_author_idx` ON `orders` (`author_id`);--> statement-breakpoint
CREATE INDEX `orders_forked_from_idx` ON `orders` (`forked_from_id`);