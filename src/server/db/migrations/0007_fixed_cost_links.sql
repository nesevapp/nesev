CREATE TABLE `recurring_expense_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recurring_expense_id` integer NOT NULL,
	`expense_id` integer NOT NULL,
	`scheduled_date` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`recurring_expense_id`) REFERENCES `recurring_expenses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`expense_id`) REFERENCES `expenses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_expense_payments_expense_uq` ON `recurring_expense_payments` (`expense_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_expense_payments_slot_uq` ON `recurring_expense_payments` (`recurring_expense_id`,`scheduled_date`);