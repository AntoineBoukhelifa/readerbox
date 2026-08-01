CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `entities_type_name_idx` ON `entities` (`type`,`name`);--> statement-breakpoint
CREATE TABLE `entity_sources` (
	`entity_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`source`, `entity_type`, `external_id`),
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entity_sources_entity_id_idx` ON `entity_sources` (`entity_id`);--> statement-breakpoint
CREATE TABLE `graph_rematerializations` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `graph_remat_pending_idx` ON `graph_rematerializations` (`processed_at`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `graph_remat_pending_unique_idx` ON `graph_rematerializations` (`work_id`,`reason`) WHERE processed_at is null;--> statement-breakpoint
CREATE TABLE `work_characters` (
	`work_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`source` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`work_id`, `entity_id`, `source`),
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_characters_entity_id_idx` ON `work_characters` (`entity_id`);--> statement-breakpoint
CREATE TABLE `work_contents` (
	`container_work_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`content_work_id` text,
	`rank` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`container_work_id`, `source`, `external_id`),
	FOREIGN KEY (`container_work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_contents_content_work_id_idx` ON `work_contents` (`content_work_id`);--> statement-breakpoint
CREATE TABLE `work_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`member_id` text NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_corrections_work_id_idx` ON `work_corrections` (`work_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `work_creators` (
	`work_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`source` text NOT NULL,
	`role` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`work_id`, `entity_id`, `source`, `role`),
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_creators_entity_id_idx` ON `work_creators` (`entity_id`);--> statement-breakpoint
CREATE TABLE `work_sources` (
	`work_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`characters_completeness` text NOT NULL,
	`creators_completeness` text NOT NULL,
	`contents_completeness` text NOT NULL,
	`ingested_at` integer NOT NULL,
	PRIMARY KEY(`source`, `external_id`),
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_sources_work_id_idx` ON `work_sources` (`work_id`);--> statement-breakpoint
CREATE TABLE `works` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`release_date` text,
	`series_entity_id` text,
	`number_in_series` integer,
	`event_entity_id` text,
	`cover_url` text,
	`ingestion_state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`series_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `works_series_number_idx` ON `works` (`series_entity_id`,`number_in_series`);--> statement-breakpoint
CREATE INDEX `works_event_idx` ON `works` (`event_entity_id`);--> statement-breakpoint
CREATE INDEX `works_ingestion_state_idx` ON `works` (`ingestion_state`);--> statement-breakpoint
CREATE INDEX `works_type_title_idx` ON `works` (`type`,`title`);