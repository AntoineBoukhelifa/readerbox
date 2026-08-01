CREATE TABLE `graph_edge_supports` (
	`edge_id` text NOT NULL,
	`work_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`edge_id`, `work_id`),
	FOREIGN KEY (`edge_id`) REFERENCES `graph_edges`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `graph_edge_supports_work_idx` ON `graph_edge_supports` (`work_id`);--> statement-breakpoint
CREATE TABLE `graph_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`relation` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_edges_member_relation_entity_idx` ON `graph_edges` (`member_id`,`relation`,`entity_id`);--> statement-breakpoint
CREATE INDEX `graph_edges_member_relation_idx` ON `graph_edges` (`member_id`,`relation`);