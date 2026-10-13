CREATE TABLE `receipt_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`expense_id` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attachment_path` text,
	`text_source` text,
	`text` text DEFAULT '' NOT NULL,
	`result` text,
	`model` text DEFAULT '' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`applied_at` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`expense_id`) REFERENCES `expenses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `receipt_analyses_expense_idx` ON `receipt_analyses` (`expense_id`);--> statement-breakpoint
CREATE INDEX `receipt_analyses_status_idx` ON `receipt_analyses` (`status`);--> statement-breakpoint
ALTER TABLE `settings` ADD `ocr_settings` text;