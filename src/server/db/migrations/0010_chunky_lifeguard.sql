CREATE TABLE `chat_feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_feedback_message_uq` ON `chat_feedback` (`message_id`);--> statement-breakpoint
CREATE TABLE `receipt_inbox_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_name` text NOT NULL,
	`stored_path` text,
	`source_path` text DEFAULT '' NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`expense_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`expense_id`) REFERENCES `expenses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_inbox_sha_uq` ON `receipt_inbox_items` (`sha256`);--> statement-breakpoint
CREATE INDEX `receipt_inbox_status_idx` ON `receipt_inbox_items` (`status`);--> statement-breakpoint
ALTER TABLE `clients` ADD `e_invoice_format` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `e_invoice_buyer_reference` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `clients` ADD `e_invoice_supplier_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `buyer_reference` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `payment_qr` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `receipt_inbox_path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `accounting_export` text;