CREATE TABLE `fixed_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` integer NOT NULL,
	`name` text NOT NULL,
	`expense_id` integer,
	`acquisition_date` text NOT NULL,
	`in_service_date` text NOT NULL,
	`cost_cents` integer NOT NULL,
	`useful_life_years` integer NOT NULL,
	`disposal_date` text,
	`disposal_proceeds_cents` integer,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`expense_id`) REFERENCES `expenses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fixed_assets_number_uq` ON `fixed_assets` (`number`);--> statement-breakpoint
CREATE INDEX `fixed_assets_expense_idx` ON `fixed_assets` (`expense_id`);--> statement-breakpoint
CREATE TABLE `recurring_expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`supplier_name` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'sonstiges' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`interval_unit` text DEFAULT 'month' NOT NULL,
	`interval_count` integer DEFAULT 1 NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`gross_cents` integer DEFAULT 0 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recurring_expenses_active_idx` ON `recurring_expenses` (`active`);--> statement-breakpoint
ALTER TABLE `settings` ADD `cash_balance_cents` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `cash_balance_date` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `income_tax_prepayment_cents` integer DEFAULT 0 NOT NULL;