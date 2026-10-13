import { formatDate } from "./dates";
import { formatCents } from "./money";

// Payment reminders (Mahnungen): statuses, level settings, fee/interest rules — shared by server and web.
//
// Rules:
// - A reminder belongs to one finalized, unpaid, overdue invoice. Its level is the next one after the
//   highest existing reminder of that invoice, capped at the last configured level (which can repeat).
// - Mahnspesen (fees) and Verzugszinsen (default interest) are damages, not consideration for a supply,
//   so they are NOT subject to VAT in Austria (nicht steuerbarer Schadenersatz). They are therefore plain
//   amounts without a tax rate, and the PDF prints REMINDER_TAX_NOTE.
// - Paying the invoice ends the dunning: reminders of a paid invoice show as "Erledigt" and no new ones
//   can be created or finalized.

export const REMINDER_STATUSES = ["draft", "final", "sent"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const REMINDER_STATUS_LABELS: Record<ReminderStatus, string> = {
  draft: "Entwurf",
  final: "Finalisiert",
  sent: "Versendet",
};

/** Shown instead of the status once the invoice has been paid. */
export const SETTLED_LABEL = "Erledigt";

export const REMINDER_TAX_NOTE = "Mahnspesen und Verzugszinsen sind als Schadenersatz nicht umsatzsteuerbar.";

export const MAX_REMINDER_LEVELS = 5;

export interface ReminderLevelConfig {
  /** e.g. "Zahlungserinnerung", "1. Mahnung"; used as the PDF heading */
  title: string;
  /** Mahnspesen charged on this level (total for this reminder, not cumulative) */
  feeCents: number;
  /** new payment deadline = issue date + days */
  days: number;
  /** may contain placeholders, see REMINDER_PLACEHOLDERS */
  introText: string;
  closingText: string;
}

/** Stored as JSON in settings.reminder_levels (null → DEFAULT_REMINDER_SETTINGS). */
export interface ReminderSettings {
  levels: ReminderLevelConfig[];
  /** charge default interest (Verzugszinsen) from the invoice due date to the reminder date */
  interestEnabled: boolean;
  /** % p.a. in basis points. AT B2B: base rate + 9.2 pp (§ 456 UGB); B2C: 4 % (§ 1000 ABGB). */
  interestRateBp: number;
}

const PAID_ALREADY = "Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.";

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  levels: [
    {
      title: "Zahlungserinnerung",
      feeCents: 0,
      days: 7,
      introText:
        "Sicher ist es Ihrer Aufmerksamkeit entgangen: Für unsere Rechnung {invoiceNumber} vom {invoiceDate}, fällig am {invoiceDueDate}, konnten wir noch keinen Zahlungseingang feststellen.",
      closingText: `Wir bitten Sie, den offenen Betrag von {total} bis {dueDate} zu überweisen. ${PAID_ALREADY}`,
    },
    {
      title: "1. Mahnung",
      feeCents: 1000,
      days: 7,
      introText:
        "Leider konnten wir für unsere Rechnung {invoiceNumber} vom {invoiceDate} trotz Zahlungserinnerung noch keinen Zahlungseingang feststellen. Die Rechnung ist seit {daysOverdue} Tagen überfällig.",
      closingText: `Bitte überweisen Sie den offenen Gesamtbetrag von {total} inklusive Mahnspesen bis spätestens {dueDate}. ${PAID_ALREADY}`,
    },
    {
      title: "2. und letzte Mahnung",
      feeCents: 2000,
      days: 7,
      introText:
        "Trotz unserer bisherigen Erinnerungen ist die Rechnung {invoiceNumber} vom {invoiceDate} weiterhin unbezahlt.",
      closingText:
        "Wir fordern Sie letztmalig auf, den offenen Gesamtbetrag von {total} bis spätestens {dueDate} zu begleichen. Nach Ablauf dieser Frist übergeben wir die Forderung ohne weitere Ankündigung an ein Inkassobüro bzw. unsere Rechtsvertretung. Die dadurch entstehenden Kosten gehen zu Ihren Lasten.",
    },
  ],
  interestEnabled: false,
  interestRateBp: 1120,
};

/** Placeholders usable in reminder intro/closing texts; filled when the PDF is rendered. */
export const REMINDER_PLACEHOLDERS = [
  { key: "invoiceNumber", label: "Rechnungsnummer" },
  { key: "invoiceDate", label: "Rechnungsdatum" },
  { key: "invoiceDueDate", label: "Ursprüngliche Fälligkeit" },
  { key: "dueDate", label: "Neue Zahlungsfrist" },
  { key: "daysOverdue", label: "Tage überfällig" },
  { key: "openAmount", label: "Offener Rechnungsbetrag" },
  { key: "fee", label: "Mahnspesen" },
  { key: "interest", label: "Verzugszinsen" },
  { key: "total", label: "Zu zahlender Gesamtbetrag" },
  { key: "clientName", label: "Kundenname" },
] as const;
export type ReminderPlaceholder = (typeof REMINDER_PLACEHOLDERS)[number]["key"];

/** Replaces known `{placeholder}`s; unknown ones are left as they are. */
export function fillPlaceholders(text: string, values: Partial<Record<ReminderPlaceholder, string>>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key as ReminderPlaceholder] ?? match);
}

/** Values for REMINDER_PLACEHOLDERS (used by the PDF mapper and the reminder view). */
export function reminderPlaceholderValues(
  r: { issueDate: string; dueDate: string; openCents: number; feeCents: number; interestCents: number },
  invoice: { number: string | null; issueDate: string; dueDate: string | null },
  clientName: string,
): Record<ReminderPlaceholder, string> {
  return {
    invoiceNumber: invoice.number ?? "",
    invoiceDate: formatDate(invoice.issueDate),
    invoiceDueDate: formatDate(invoice.dueDate),
    dueDate: formatDate(r.dueDate),
    daysOverdue: String(invoice.dueDate ? Math.max(0, daysBetween(invoice.dueDate, r.issueDate)) : 0),
    openAmount: formatCents(r.openCents),
    fee: formatCents(r.feeCents),
    interest: formatCents(r.interestCents),
    total: formatCents(reminderTotalCents(r)),
    clientName,
  };
}

/** Level for a new reminder: one above the highest existing level, capped at the last configured level. */
export function nextReminderLevel(existingLevels: readonly number[], levelCount: number): number {
  const highest = existingLevels.length ? Math.max(...existingLevels) : 0;
  return Math.max(1, Math.min(highest + 1, levelCount));
}

/** Config of a level (1-based); levels beyond the configured ones use the last one. */
export function levelConfig(settings: ReminderSettings, level: number): ReminderLevelConfig {
  const levels = settings.levels.length ? settings.levels : DEFAULT_REMINDER_SETTINGS.levels;
  return levels[Math.min(Math.max(level, 1), levels.length) - 1]!;
}

/** Whole calendar days from `from` to `to` ("YYYY-MM-DD"); negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const utc = (iso: string) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/**
 * Simple default interest (act/365) on the open amount for the days between the invoice due date and the
 * reminder date, commercially rounded to cents. 0 if not overdue.
 */
export function calcInterestCents(openCents: number, rateBp: number, invoiceDueDate: string, until: string): number {
  const days = daysBetween(invoiceDueDate, until);
  if (days <= 0 || openCents <= 0 || rateBp <= 0) return 0;
  return Math.round((openCents * rateBp * days) / (10_000 * 365));
}

/** Amount the client is asked to pay. */
export function reminderTotalCents(r: { openCents: number; feeCents: number; interestCents: number }): number {
  return r.openCents + r.feeCents + r.interestCents;
}
