CREATE TABLE `bank_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`iban` text DEFAULT '' NOT NULL,
	`bank_name` text DEFAULT '' NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bank_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`file_name` text DEFAULT '' NOT NULL,
	`format` text NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bank_matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` integer NOT NULL,
	`document_id` integer,
	`expense_id` integer,
	`amount_cents` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `bank_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`expense_id`) REFERENCES `expenses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bank_matches_tx_idx` ON `bank_matches` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `bank_matches_document_idx` ON `bank_matches` (`document_id`);--> statement-breakpoint
CREATE INDEX `bank_matches_expense_idx` ON `bank_matches` (`expense_id`);--> statement-breakpoint
CREATE TABLE `bank_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`import_id` integer,
	`booking_date` text NOT NULL,
	`value_date` text,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`counterparty_name` text DEFAULT '' NOT NULL,
	`counterparty_iban` text DEFAULT '' NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`import_hash` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_id`) REFERENCES `bank_imports`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_transactions_hash_uq` ON `bank_transactions` (`account_id`,`import_hash`);--> statement-breakpoint
CREATE INDEX `bank_transactions_date_idx` ON `bank_transactions` (`booking_date`);--> statement-breakpoint
CREATE INDEX `bank_transactions_status_idx` ON `bank_transactions` (`status`);--> statement-breakpoint
CREATE TABLE `expense_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`expense_id` integer NOT NULL,
	`position` integer NOT NULL,
	`category` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`net_cents` integer DEFAULT 0 NOT NULL,
	`tax_rate_bp` integer DEFAULT 2000 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`deductible_bp` integer DEFAULT 10000 NOT NULL,
	FOREIGN KEY (`expense_id`) REFERENCES `expenses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `expense_lines_expense_idx` ON `expense_lines` (`expense_id`,`position`);--> statement-breakpoint
CREATE INDEX `expense_lines_category_idx` ON `expense_lines` (`category`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` text,
	`supplier_name` text NOT NULL,
	`supplier_uid` text DEFAULT '' NOT NULL,
	`supplier_country` text DEFAULT 'AT' NOT NULL,
	`supplier_invoice_number` text DEFAULT '' NOT NULL,
	`issue_date` text NOT NULL,
	`due_date` text,
	`paid_at` text,
	`vat_treatment` text DEFAULT 'domestic' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`net_cents` integer DEFAULT 0 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`gross_cents` integer DEFAULT 0 NOT NULL,
	`attachment_path` text,
	`attachment_name` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_number_uq` ON `expenses` (`number`);--> statement-breakpoint
CREATE INDEX `expenses_issue_date_idx` ON `expenses` (`issue_date`);--> statement-breakpoint
CREATE INDEX `expenses_supplier_idx` ON `expenses` (`supplier_name`);--> statement-breakpoint
CREATE INDEX `expenses_paid_idx` ON `expenses` (`paid_at`);--> statement-breakpoint
ALTER TABLE `settings` ADD `vat_basis` text DEFAULT 'accrual' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `vat_period` text DEFAULT 'quarterly' NOT NULL;