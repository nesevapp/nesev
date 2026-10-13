CREATE TABLE `articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`unit_price_cents` integer DEFAULT 0 NOT NULL,
	`tax_rate_bp` integer DEFAULT 2000 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `articles_number_uq` ON `articles` (`number`);--> statement-breakpoint
CREATE INDEX `articles_title_idx` ON `articles` (`title`);--> statement-breakpoint
CREATE INDEX `articles_archived_idx` ON `articles` (`archived_at`);--> statement-breakpoint
CREATE TABLE `recurring_invoice_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recurring_invoice_id` integer NOT NULL,
	`position` integer NOT NULL,
	`article_id` integer,
	`title` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`quantity` integer DEFAULT 1000 NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`unit_price_cents` integer DEFAULT 0 NOT NULL,
	`tax_rate_bp` integer DEFAULT 2000 NOT NULL,
	`discount_bp` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`recurring_invoice_id`) REFERENCES `recurring_invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recurring_invoice_items_pos_idx` ON `recurring_invoice_items` (`recurring_invoice_id`,`position`);--> statement-breakpoint
CREATE TABLE `recurring_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`client_id` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`interval_unit` text DEFAULT 'month' NOT NULL,
	`interval_count` integer DEFAULT 1 NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`next_run_date` text NOT NULL,
	`set_service_period` integer DEFAULT true NOT NULL,
	`auto_finalize` integer DEFAULT false NOT NULL,
	`tax_mode` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`intro_text` text DEFAULT '' NOT NULL,
	`closing_text` text DEFAULT '' NOT NULL,
	`template_id` integer,
	`net_cents` integer DEFAULT 0 NOT NULL,
	`gross_cents` integer DEFAULT 0 NOT NULL,
	`last_run_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`template_id`) REFERENCES `pdf_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recurring_invoices_client_idx` ON `recurring_invoices` (`client_id`);--> statement-breakpoint
CREATE INDEX `recurring_invoices_next_run_idx` ON `recurring_invoices` (`active`,`next_run_date`);--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`level` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`number` text,
	`issue_date` text NOT NULL,
	`due_date` text NOT NULL,
	`open_cents` integer DEFAULT 0 NOT NULL,
	`fee_cents` integer DEFAULT 0 NOT NULL,
	`interest_cents` integer DEFAULT 0 NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`intro_text` text DEFAULT '' NOT NULL,
	`closing_text` text DEFAULT '' NOT NULL,
	`template_id` integer,
	`client_snapshot` text,
	`seller_snapshot` text,
	`finalized_at` text,
	`sent_at` text,
	`pdf_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`template_id`) REFERENCES `pdf_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminders_number_uq` ON `reminders` (`number`);--> statement-breakpoint
CREATE INDEX `reminders_invoice_idx` ON `reminders` (`invoice_id`,`level`);--> statement-breakpoint
ALTER TABLE `document_items` ADD `article_id` integer REFERENCES articles(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `documents` ADD `recurring_invoice_id` integer REFERENCES recurring_invoices(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `documents_recurring_idx` ON `documents` (`recurring_invoice_id`);--> statement-breakpoint
ALTER TABLE `settings` ADD `reminder_levels` text;