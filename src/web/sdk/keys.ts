import type { DocumentType } from "@shared/documents";

/**
 * Every React Query key in the app. Keys are hierarchical: `keys.x.all` is the prefix of every key of
 * resource x, so `invalidateQueries({ queryKey: keys.x.all })` refreshes all of it.
 * Filter objects are part of the key, so each filter combination is cached separately.
 */
export const keys = {
  settings: {
    all: ["settings"] as const,
  },
  units: {
    all: ["units"] as const,
  },
  clients: {
    all: ["clients"] as const,
    list: (filter: object) => ["clients", "list", filter] as const,
    picker: (q: string, limit: number) => ["clients", "picker", q, limit] as const,
    detail: (id: number) => ["clients", "detail", id] as const,
    nextNumber: ["clients", "next-number"] as const,
  },
  articles: {
    all: ["articles"] as const,
    list: (filter: object) => ["articles", "list", filter] as const,
    picker: (q: string, limit: number) => ["articles", "picker", q, limit] as const,
    nextNumber: ["articles", "next-number"] as const,
  },
  documents: {
    all: ["documents"] as const,
    list: (filter: object) => ["documents", "list", filter] as const,
    detail: (id: number) => ["documents", "detail", id] as const,
    /** Defaults for a new recurring invoice: cached, refreshed whenever documents change. */
    defaults: (type: DocumentType, clientId: number | null) => ["documents", "defaults", type, clientId] as const,
    /** e-invoice formats and missing data of a finalized invoice / credit note */
    einvoice: (id: number) => ["documents", "einvoice", id] as const,
  },
  /** Defaults for the "new document" page: deliberately outside `documents.all`, so saving the new
   *  draft doesn't refetch them while the page is still mounted. */
  documentDraftDefaults: (type: DocumentType, clientId: number | null) => ["document-defaults", type, clientId] as const,
  templates: {
    all: ["templates"] as const,
    list: ["templates", "list"] as const,
    detail: (id: number) => ["templates", "detail", id] as const,
    sample: (id: number) => ["templates", "sample", id] as const,
  },
  reminders: {
    all: ["reminders"] as const,
    list: (filter: object) => ["reminders", "list", filter] as const,
    due: ["reminders", "due"] as const,
    detail: (id: number) => ["reminders", "detail", id] as const,
    settings: ["reminders", "settings"] as const,
  },
  recurring: {
    all: ["recurring"] as const,
    list: ["recurring", "list"] as const,
    detail: (id: number) => ["recurring", "detail", id] as const,
  },
  forecast: {
    all: ["forecast"] as const,
    report: (params: object) => ["forecast", params] as const,
    settings: ["forecast", "settings"] as const,
  },
  dashboard: {
    all: ["dashboard"] as const,
    year: (year: number | undefined) => ["dashboard", year ?? "current"] as const,
  },
  export: {
    all: ["export"] as const,
    summary: (range: object) => ["export", "summary", range] as const,
    backups: ["export", "backups"] as const,
  },
  expenses: {
    all: ["expenses"] as const,
    lists: ["expenses", "list"] as const,
    list: (filter: object) => ["expenses", "list", filter] as const,
    detail: (id: number) => ["expenses", "detail", id] as const,
    suppliersAll: ["expenses", "suppliers"] as const,
    suppliers: (q: string, limit: number) => ["expenses", "suppliers", q, limit] as const,
    /** suggested crop outline, per original photo */
    receiptDetect: (id: number, originalPath: string) => ["expenses", "receipt-detect", id, originalPath] as const,
  },
  receipts: {
    all: ["receipts"] as const,
    queue: ["receipts", "queue"] as const,
    expense: (expenseId: number) => ["receipts", "expense", expenseId] as const,
    settings: ["receipts", "settings"] as const,
    statusAll: ["receipts", "status"] as const,
    status: (probe: object) => ["receipts", "status", probe] as const,
    llamaModels: ["receipts", "llamacpp", "models"] as const,
  },
  receiptInbox: {
    all: ["receipt-inbox"] as const,
    list: (status: string) => ["receipt-inbox", "list", status] as const,
    count: ["receipt-inbox", "count"] as const,
    status: ["receipt-inbox", "status"] as const,
  },
  bank: {
    all: ["bank"] as const,
    accounts: ["bank", "accounts"] as const,
    accountSuggestion: ["bank", "accounts", "suggestion"] as const,
    presets: ["bank", "presets"] as const,
    transactions: (filter: object) => ["bank", "transactions", filter] as const,
    summary: (filter: object) => ["bank", "summary", filter] as const,
    imports: (accountId: number | undefined) => ["bank", "imports", accountId ?? null] as const,
    candidates: (filter: object) => ["bank", "candidates", filter] as const,
    documentPayments: (documentId: number) => ["bank", "payments", "document", documentId] as const,
  },
  recurringExpenses: {
    all: ["recurring-expenses"] as const,
    list: ["recurring-expenses", "list"] as const,
    schedule: (id: number) => ["recurring-expenses", "schedule", id] as const,
    candidates: (id: number, date: string) => ["recurring-expenses", "candidates", id, date] as const,
    expenseLink: (expenseId: number) => ["recurring-expenses", "link", expenseId] as const,
    suggestions: (expenseId: number) => ["recurring-expenses", "suggestions", expenseId] as const,
  },
  assets: {
    all: ["assets"] as const,
    list: (filter: object) => ["assets", "list", filter] as const,
    detail: (id: number) => ["assets", "detail", id] as const,
  },
  chat: {
    all: ["chat"] as const,
    conversations: ["chat", "conversations"] as const,
    conversation: (id: number) => ["chat", "conversation", id] as const,
    feedback: (id: number) => ["chat", "feedback", id] as const,
    settings: ["chat", "settings"] as const,
    status: ["chat", "status"] as const,
  },
  voice: {
    all: ["voice"] as const,
    settings: ["voice", "settings"] as const,
    status: ["voice", "status"] as const,
    models: ["voice", "models"] as const,
  },
  search: {
    all: ["search"] as const,
    query: (q: string) => ["search", q] as const,
  },
  tax: {
    all: ["tax"] as const,
    uva: (period: string | undefined, euIn021: boolean) => ["tax", "uva", period ?? "default", euIn021] as const,
    zm: (period: string | undefined) => ["tax", "zm", period ?? "default"] as const,
    ear: (year: number | undefined) => ["tax", "ear", year ?? "current"] as const,
    finanzOnline: (kind: "uva" | "zm", period: string, euIn021: boolean) => ["tax", "finanzonline", kind, period, euIn021] as const,
  },
};
