CREATE TABLE `reconnections` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`member_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconnections_token_hash_unique` ON `reconnections` (`token_hash`);--> statement-breakpoint
CREATE INDEX `reconnections_member_id_idx` ON `reconnections` (`member_id`);