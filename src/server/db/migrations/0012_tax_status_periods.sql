CREATE TABLE `tax_status_periods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`valid_from` text NOT NULL,
	`small_business` integer NOT NULL,
	`vat_basis` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_status_periods_valid_from_uq` ON `tax_status_periods` (`valid_from`);--> statement-breakpoint
-- Carry the former global settings over as the first entry, valid from the beginning of time (nothing changes for
-- existing databases). Without a settings row yet: the settings defaults (no Kleinunternehmer, Sollbesteuerung).
INSERT INTO `tax_status_periods` (`valid_from`, `small_business`, `vat_basis`, `note`, `created_at`, `updated_at`)
SELECT '0001-01-01', `small_business`, `vat_basis`, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `settings` WHERE `id` = 1
UNION ALL
SELECT '0001-01-01', 0, 'accrual', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM `settings` WHERE `id` = 1);
