CREATE TABLE `reveals` (
	`member_id` text NOT NULL,
	`work_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `work_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reveals_member_idx` ON `reveals` (`member_id`);