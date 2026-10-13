ALTER TABLE `bank_accounts` ADD `csv_mapping` text;--> statement-breakpoint
ALTER TABLE `bank_accounts` ADD `auto_match` text DEFAULT 'safe' NOT NULL;