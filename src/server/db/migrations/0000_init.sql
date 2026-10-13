CREATE TABLE `clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` integer NOT NULL,
	`type` text DEFAULT 'company' NOT NULL,
	`name` text NOT NULL,
	`contact_person` text DEFAULT '' NOT NULL,
	`street` text DEFAULT '' NOT NULL,
	`address_extra` text DEFAULT '' NOT NULL,
	`zip` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`country` text DEFAULT 'AT' NOT NULL,
	`uid` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`payment_terms_days` integer,
	`default_tax_mode` text,
	`notes` text DEFAULT '' NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_number_uq` ON `clients` (`number`);--> statement-breakpoint
CREATE INDEX `clients_name_idx` ON `clients` (`name`);--> statement-breakpoint
CREATE INDEX `clients_archived_idx` ON `clients` (`archived_at`);--> statement-breakpoint
CREATE TABLE `document_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`position` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`quantity` integer DEFAULT 1000 NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`unit_price_cents` integer DEFAULT 0 NOT NULL,
	`tax_rate_bp` integer DEFAULT 2000 NOT NULL,
	`discount_bp` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_items_doc_pos_idx` ON `document_items` (`document_id`,`position`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`number` text,
	`client_id` integer NOT NULL,
	`client_snapshot` text,
	`seller_snapshot` text,
	`issue_date` text NOT NULL,
	`service_period_start` text,
	`service_period_end` text,
	`due_date` text,
	`valid_until` text,
	`tax_mode` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`intro_text` text DEFAULT '' NOT NULL,
	`closing_text` text DEFAULT '' NOT NULL,
	`template_id` integer,
	`parent_id` integer,
	`net_cents` integer DEFAULT 0 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`gross_cents` integer DEFAULT 0 NOT NULL,
	`finalized_at` text,
	`sent_at` text,
	`paid_at` text,
	`pdf_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`template_id`) REFERENCES `pdf_templates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_number_uq` ON `documents` (`number`);--> statement-breakpoint
CREATE INDEX `documents_type_status_idx` ON `documents` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `documents_client_idx` ON `documents` (`client_id`);--> statement-breakpoint
CREATE INDEX `documents_issue_date_idx` ON `documents` (`issue_date`);--> statement-breakpoint
CREATE INDEX `documents_parent_idx` ON `documents` (`parent_id`);--> statement-breakpoint
CREATE TABLE `number_sequences` (
	`type` text NOT NULL,
	`year` integer NOT NULL,
	`last_number` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`type`, `year`)
);
--> statement-breakpoint
CREATE TABLE `pdf_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`doc_type` text NOT NULL,
	`template` text NOT NULL,
	`base_pdf_path` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pdf_templates_doc_type_idx` ON `pdf_templates` (`doc_type`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`company_name` text DEFAULT '' NOT NULL,
	`owner_name` text DEFAULT '' NOT NULL,
	`street` text DEFAULT '' NOT NULL,
	`zip` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`country` text DEFAULT 'AT' NOT NULL,
	`uid` text DEFAULT '' NOT NULL,
	`tax_number` text DEFAULT '' NOT NULL,
	`company_register` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`iban` text DEFAULT '' NOT NULL,
	`bic` text DEFAULT '' NOT NULL,
	`bank_name` text DEFAULT '' NOT NULL,
	`logo_path` text,
	`payment_terms_days` integer DEFAULT 14 NOT NULL,
	`offer_validity_days` integer DEFAULT 30 NOT NULL,
	`default_offer_intro` text DEFAULT '' NOT NULL,
	`default_offer_closing` text DEFAULT '' NOT NULL,
	`default_invoice_intro` text DEFAULT '' NOT NULL,
	`default_invoice_closing` text DEFAULT '' NOT NULL,
	`default_credit_note_intro` text DEFAULT '' NOT NULL,
	`default_credit_note_closing` text DEFAULT '' NOT NULL,
	`small_business` integer DEFAULT false NOT NULL,
	`tax_note_reverse_charge` text DEFAULT '' NOT NULL,
	`tax_note_third_country` text DEFAULT '' NOT NULL,
	`tax_note_small_business` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
