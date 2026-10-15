import { hashKey, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { keys } from "./keys";

/**
 * Cross-resource invalidation map: which cached data a kind of change makes stale.
 * Mutation hooks name a change here instead of listing keys themselves, so a write that affects
 * other views (an invoice paid via bank match shows up on the dashboard, forecast, reminders, …)
 * is handled in one place. Add a resource's keys here when a new view depends on it.
 */
const affects = {
  articles: [keys.articles.all],
  clients: [keys.clients.all],
  templates: [keys.templates.all],
  /** Template content saved (detail is written to the cache directly). */
  templateSaved: [keys.templates.list],
  /** Any document write (save, finalize, status change, derive, delete): open amounts, dunning, reports. */
  documents: [keys.documents.all, keys.dashboard.all, keys.forecast.all, keys.reminders.all, keys.bank.all, keys.tax.all],
  /** Bank accounts, ignore flags: only the bank views. */
  bank: [keys.bank.all],
  /** Matching, imports, undo, auto-match: payment states of invoices and expenses change. */
  bankMatches: [
    keys.bank.all,
    keys.documents.all,
    keys.expenses.all,
    keys.dashboard.all,
    keys.forecast.all,
    keys.reminders.all,
    keys.tax.all,
  ],
  /** Expense writes: lists, supplier suggestions, EAR/UVA, the bank's match candidates, the forecast (unpaid
   *  expenses) and Fixkosten schedules/suggestions (links cascade on delete). */
  expenses: [
    keys.expenses.lists,
    keys.expenses.suppliersAll,
    keys.tax.all,
    keys.bank.all,
    keys.dashboard.all,
    keys.assets.all,
    keys.forecast.all,
    keys.recurringExpenses.all,
  ],
  /** New or replaced receipt file: also earlier analysis results. */
  expenseReceipt: [keys.expenses.lists, keys.expenses.suppliersAll, keys.tax.all, keys.bank.all, keys.receipts.all],
  receipts: [keys.receipts.all],
  /** Belege-Eingang: items added/dismissed, folder changed. */
  receiptInbox: [keys.receiptInbox.all],
  /** Inbox folder setting: the inbox status and the settings row. */
  receiptInboxFolder: [keys.receiptInbox.all, keys.settings.all],
  /** Inbox items turned into expense drafts: the inbox plus everything a new expense with a receipt affects. */
  receiptInboxConvert: [keys.receiptInbox.all, keys.expenses.lists, keys.expenses.suppliersAll, keys.tax.all, keys.bank.all, keys.receipts.all],
  /** Reminders change the dunning state shown on the dashboard. */
  reminders: [keys.reminders.all, keys.dashboard.all],
  /** Recurring invoice settings: the forecast projects them. */
  recurring: [keys.recurring.all, keys.forecast.all],
  /** Generated invoices: everything a document write affects. */
  recurringRun: [
    keys.recurring.all,
    keys.documents.all,
    keys.dashboard.all,
    keys.forecast.all,
    keys.reminders.all,
    keys.bank.all,
    keys.tax.all,
  ],
  backups: [keys.export.backups],
  /** Fixkosten: projected outflows in the forecast. */
  recurringExpenses: [keys.recurringExpenses.all, keys.forecast.all],
  /** Expense ↔ Fixkosten-slot links: schedules, suggestions, forecast (linked slots aren't projected). */
  recurringExpenseLinks: [keys.recurringExpenses.all, keys.forecast.all, keys.expenses.lists],
  /** Start balance / income tax prepayment: forecast only. */
  forecastSettings: [keys.forecast.all],
  /** Anlagen: AfA changes the EAR, the dashboard result and the expense hints. */
  assets: [keys.assets.all, keys.tax.all, keys.dashboard.all, keys.expenses.lists],
} satisfies Record<string, readonly QueryKey[]>;

export type Change = keyof typeof affects;

/**
 * Returns `invalidate(change, except?)`. `except` is a key that is skipped, typically the detail key
 * a mutation just wrote with setQueryData (no point refetching it).
 */
export function useInvalidate() {
  const qc = useQueryClient();
  return (change: Change, except?: QueryKey) => {
    const skip = except ? hashKey(except) : undefined;
    return Promise.all(
      affects[change].map((queryKey) =>
        qc.invalidateQueries({ queryKey, predicate: skip ? (q) => q.queryHash !== skip : undefined }),
      ),
    );
  };
}
