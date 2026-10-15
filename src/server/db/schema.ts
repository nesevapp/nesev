import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { DocumentStatus, DocumentType, NumberedType, TemplateDocType } from "../../shared/documents";
import type { TaxMode } from "../../shared/tax";
import type { EInvoiceFormat } from "../../shared/einvoice";
import type { ClientType } from "../../shared/schemas/client";
import type { ClientSnapshot, SellerSnapshot } from "../../shared/types";

// Conventions:
// - money: integer cents (*Cents), quantity: integer milli-units, rates: integer basis points (*Bp)
// - timestamps: ISO-8601 strings (createdAt/updatedAt/*At); calendar dates: "YYYY-MM-DD" strings
// - free text columns are NOT NULL DEFAULT '' (simpler forms); optional refs/dates/numbers are nullable
// - enums are text columns typed with TS unions from src/shared

const now = () => new Date().toISOString();
const timestamps = {
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
};
const str = (name: string) => text(name).notNull().default("");

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(), // singleton: always 1
  companyName: str("company_name"),
  ownerName: str("owner_name"),
  street: str("street"),
  zip: str("zip"),
  city: str("city"),
  country: text("country").notNull().default("AT"),
  uid: str("uid"),
  taxNumber: str("tax_number"),
  companyRegister: str("company_register"),
  email: str("email"),
  phone: str("phone"),
  website: str("website"),
  iban: str("iban"),
  bic: str("bic"),
  bankName: str("bank_name"),
  /** relative to data dir, e.g. "assets/logo.png"; served at /api/files/<logoPath> */
  logoPath: text("logo_path"),
  paymentTermsDays: integer("payment_terms_days").notNull().default(14),
  offerValidityDays: integer("offer_validity_days").notNull().default(30),
  defaultOfferIntro: str("default_offer_intro"),
  defaultOfferClosing: str("default_offer_closing"),
  defaultInvoiceIntro: str("default_invoice_intro"),
  defaultInvoiceClosing: str("default_invoice_closing"),
  defaultCreditNoteIntro: str("default_credit_note_intro"),
  defaultCreditNoteClosing: str("default_credit_note_closing"),
  smallBusiness: integer("small_business", { mode: "boolean" }).notNull().default(false),
  taxNoteReverseCharge: str("tax_note_reverse_charge"),
  taxNoteThirdCountry: str("tax_note_third_country"),
  taxNoteSmallBusiness: str("tax_note_small_business"),
  /** Mahnstufen config (JSON array, shape owned by the reminders feature); null → built-in defaults */
  reminderLevels: text("reminder_levels", { mode: "json" }).$type<unknown>(),
  /** Umsatzsteuer: "accrual" = Sollbesteuerung (by invoice date), "cash" = Istbesteuerung (by payment date) */
  vatBasis: text("vat_basis").$type<"accrual" | "cash">().notNull().default("accrual"),
  /** UVA period */
  vatPeriod: text("vat_period").$type<"monthly" | "quarterly">().notNull().default("quarterly"),
  /** units offered in line-item dropdowns (JSON string[]); null → DEFAULT_UNITS */
  units: text("units", { mode: "json" }).$type<string[]>(),
  /** receipt analysis config (JSON: mode, llama.cpp paths, ...; shape = OcrSettings, unknown keys ignored); null → defaults */
  ocrSettings: text("ocr_settings", { mode: "json" }).$type<unknown>(),
  /** forecast: account balance entered by the user and the date it refers to; null → forecast without balance */
  cashBalanceCents: integer("cash_balance_cents"),
  cashBalanceDate: text("cash_balance_date"),
  /** forecast: quarterly income tax prepayment (ESt-Vorauszahlung, due 15.2./15.5./15.8./15.11.); 0 = none */
  incomeTaxPrepaymentCents: integer("income_tax_prepayment_cents").notNull().default(0),
  /** in-app assistant config (JSON, shape = ChatSettings in src/shared/chat.ts, unknown keys ignored); null → defaults */
  chatSettings: text("chat_settings", { mode: "json" }).$type<unknown>(),
  /** print a payment QR code (EPC/GiroCode, "Zahlen mit Code") on invoices; needs IBAN */
  paymentQr: integer("payment_qr", { mode: "boolean" }).notNull().default(true),
  /** receipt inbox: folder watched for new receipt files (absolute path); "" = off */
  receiptInboxPath: str("receipt_inbox_path"),
  /** accountant export config (JSON: BMD account mapping per category, …; shape owned by the export feature); null → defaults */
  accountingExport: text("accounting_export", { mode: "json" }).$type<unknown>(),
  ...timestamps,
});

export const clients = sqliteTable(
  "clients",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** customer number shown to the user */
    number: integer("number").notNull(),
    type: text("type").$type<ClientType>().notNull().default("company"),
    name: text("name").notNull(),
    contactPerson: str("contact_person"),
    street: str("street"),
    addressExtra: str("address_extra"),
    zip: str("zip"),
    city: str("city"),
    /** ISO 3166-1 alpha-2 */
    country: text("country").notNull().default("AT"),
    uid: str("uid"),
    email: str("email"),
    phone: str("phone"),
    /** null → settings.paymentTermsDays */
    paymentTermsDays: integer("payment_terms_days"),
    /** null → derived via defaultTaxMode() */
    defaultTaxMode: text("default_tax_mode").$type<TaxMode>(),
    /** e-invoice format for this client: null = none (PDF only); src/shared/einvoice.ts */
    eInvoiceFormat: text("e_invoice_format").$type<EInvoiceFormat>(),
    /** default buyer reference: Leitweg-ID (XRechnung) / Auftragsreferenz (ebInterface); per document overridable */
    eInvoiceBuyerReference: str("e_invoice_buyer_reference"),
    /** our supplier number at the client (ebInterface BillersInvoiceRecipientID, e.g. Lieferantennummer beim Bund) */
    eInvoiceSupplierId: str("e_invoice_supplier_id"),
    notes: str("notes"),
    archivedAt: text("archived_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("clients_number_uq").on(t.number),
    index("clients_name_idx").on(t.name),
    index("clients_archived_idx").on(t.archivedAt),
  ],
);

export const pdfTemplates = sqliteTable(
  "pdf_templates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    docType: text("doc_type").$type<TemplateDocType>().notNull(),
    /** pdfme Template JSON (schemas + basePdf) */
    template: text("template", { mode: "json" }).$type<unknown>().notNull(),
    /** optional letterhead PDF relative to data dir, e.g. "assets/letterhead.pdf" */
    basePdfPath: text("base_pdf_path"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (t) => [index("pdf_templates_doc_type_idx").on(t.docType)],
);

export const articles = sqliteTable(
  "articles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** article number shown to the user */
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: str("description"),
    unit: str("unit"),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    taxRateBp: integer("tax_rate_bp").notNull().default(2000),
    notes: str("notes"),
    /** incremented when used on a document line; drives picker ordering */
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: text("last_used_at"),
    archivedAt: text("archived_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("articles_number_uq").on(t.number),
    index("articles_title_idx").on(t.title),
    index("articles_archived_idx").on(t.archivedAt),
  ],
);

export const recurringInvoices = sqliteTable(
  "recurring_invoices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** internal label, e.g. "Hosting Alpen AG" */
    name: text("name").notNull(),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** "month" | "year"; every intervalCount units (1 month, 3 months, 1 year, ...) */
    intervalUnit: text("interval_unit").$type<"month" | "year">().notNull().default("month"),
    intervalCount: integer("interval_count").notNull().default(1),
    startDate: text("start_date").notNull(),
    /** last date an invoice may be issued; null = open-ended */
    endDate: text("end_date"),
    /** issue date of the next invoice to generate */
    nextRunDate: text("next_run_date").notNull(),
    /** set the generated invoice's service period to the covered interval */
    setServicePeriod: integer("set_service_period", { mode: "boolean" }).notNull().default(true),
    /** false → generated invoices stay drafts for review */
    autoFinalize: integer("auto_finalize", { mode: "boolean" }).notNull().default(false),
    taxMode: text("tax_mode").$type<TaxMode>().notNull(),
    title: str("title"),
    introText: str("intro_text"),
    closingText: str("closing_text"),
    templateId: integer("template_id").references(() => pdfTemplates.id, { onDelete: "set null" }),
    /** cached totals of one run (for lists and forecast) */
    netCents: integer("net_cents").notNull().default(0),
    grossCents: integer("gross_cents").notNull().default(0),
    lastRunAt: text("last_run_at"),
    ...timestamps,
  },
  (t) => [
    index("recurring_invoices_client_idx").on(t.clientId),
    index("recurring_invoices_next_run_idx").on(t.active, t.nextRunDate),
  ],
);

export const recurringInvoiceItems = sqliteTable(
  "recurring_invoice_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recurringInvoiceId: integer("recurring_invoice_id")
      .notNull()
      .references(() => recurringInvoices.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    articleId: integer("article_id").references(() => articles.id, { onDelete: "set null" }),
    title: str("title"),
    description: str("description"),
    /** milli-units */
    quantity: integer("quantity").notNull().default(1000),
    unit: str("unit"),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    taxRateBp: integer("tax_rate_bp").notNull().default(2000),
    discountBp: integer("discount_bp").notNull().default(0),
  },
  (t) => [index("recurring_invoice_items_pos_idx").on(t.recurringInvoiceId, t.position)],
);

export const documents = sqliteTable(
  "documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").$type<DocumentType>().notNull(),
    status: text("status").$type<DocumentStatus>().notNull().default("draft"),
    /** null until finalized, e.g. "RE-2026-0001" */
    number: text("number"),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    /** frozen at finalize; null while draft (use live client) */
    clientSnapshot: text("client_snapshot", { mode: "json" }).$type<ClientSnapshot>(),
    sellerSnapshot: text("seller_snapshot", { mode: "json" }).$type<SellerSnapshot>(),
    issueDate: text("issue_date").notNull(),
    servicePeriodStart: text("service_period_start"),
    servicePeriodEnd: text("service_period_end"),
    /** invoices / credit notes */
    dueDate: text("due_date"),
    /** offers */
    validUntil: text("valid_until"),
    taxMode: text("tax_mode").$type<TaxMode>().notNull(),
    title: str("title"),
    introText: str("intro_text"),
    closingText: str("closing_text"),
    templateId: integer("template_id").references(() => pdfTemplates.id, { onDelete: "set null" }),
    /** offer → invoice → credit note chain */
    parentId: integer("parent_id").references((): AnySQLiteColumn => documents.id, { onDelete: "set null" }),
    /** generated from this recurring invoice */
    recurringInvoiceId: integer("recurring_invoice_id").references(() => recurringInvoices.id, { onDelete: "set null" }),
    /** cached result of calcTotals(), always written together with items */
    netCents: integer("net_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    grossCents: integer("gross_cents").notNull().default(0),
    finalizedAt: text("finalized_at"),
    sentAt: text("sent_at"),
    paidAt: text("paid_at"),
    /** frozen PDF relative to data dir, e.g. "pdfs/RE-2026-0001.pdf" */
    pdfPath: text("pdf_path"),
    /** e-invoice buyer reference / order reference; "" → client's eInvoiceBuyerReference */
    buyerReference: str("buyer_reference"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("documents_number_uq").on(t.number), // NULLs are distinct in SQLite
    index("documents_type_status_idx").on(t.type, t.status),
    index("documents_client_idx").on(t.clientId),
    index("documents_issue_date_idx").on(t.issueDate),
    index("documents_parent_idx").on(t.parentId),
    index("documents_recurring_idx").on(t.recurringInvoiceId),
  ],
);

export const documentItems = sqliteTable(
  "document_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: integer("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** catalog article this line was taken from (values are copied, not linked) */
    articleId: integer("article_id").references(() => articles.id, { onDelete: "set null" }),
    title: str("title"),
    description: str("description"),
    /** milli-units */
    quantity: integer("quantity").notNull().default(1000),
    unit: str("unit"),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    taxRateBp: integer("tax_rate_bp").notNull().default(2000),
    discountBp: integer("discount_bp").notNull().default(0),
  },
  (t) => [index("document_items_doc_pos_idx").on(t.documentId, t.position)],
);

export const reminders = sqliteTable(
  "reminders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    /** Mahnstufe: 1 = Zahlungserinnerung, 2 = 1. Mahnung, ... */
    level: integer("level").notNull(),
    /** "draft" | "final" | "sent" */
    status: text("status").$type<"draft" | "final" | "sent">().notNull().default("draft"),
    /** null until finalized, e.g. "MA-2026-0001" */
    number: text("number"),
    issueDate: text("issue_date").notNull(),
    /** new payment deadline */
    dueDate: text("due_date").notNull(),
    /** invoice amount still open when the reminder was created */
    openCents: integer("open_cents").notNull().default(0),
    feeCents: integer("fee_cents").notNull().default(0),
    interestCents: integer("interest_cents").notNull().default(0),
    title: str("title"),
    introText: str("intro_text"),
    closingText: str("closing_text"),
    templateId: integer("template_id").references(() => pdfTemplates.id, { onDelete: "set null" }),
    clientSnapshot: text("client_snapshot", { mode: "json" }).$type<ClientSnapshot>(),
    sellerSnapshot: text("seller_snapshot", { mode: "json" }).$type<SellerSnapshot>(),
    finalizedAt: text("finalized_at"),
    sentAt: text("sent_at"),
    /** frozen PDF relative to data dir */
    pdfPath: text("pdf_path"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("reminders_number_uq").on(t.number),
    index("reminders_invoice_idx").on(t.invoiceId, t.level),
  ],
);

export const expenses = sqliteTable(
  "expenses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** internal running receipt number, e.g. "ER-2026-0001" (assigned on create) */
    number: text("number"),
    supplierName: text("supplier_name").notNull(),
    supplierUid: str("supplier_uid"),
    /** ISO 3166-1 alpha-2 */
    supplierCountry: text("supplier_country").notNull().default("AT"),
    /** supplier's own invoice number */
    supplierInvoiceNumber: str("supplier_invoice_number"),
    issueDate: text("issue_date").notNull(),
    dueDate: text("due_date"),
    paidAt: text("paid_at"),
    /** "domestic" | "reverse_charge" | "ig_acquisition" | "import" | "none" — shape owned by the expenses feature */
    vatTreatment: text("vat_treatment").notNull().default("domestic"),
    description: str("description"),
    notes: str("notes"),
    /** cached sums of expense_lines */
    netCents: integer("net_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    grossCents: integer("gross_cents").notNull().default(0),
    /** uploaded receipt relative to data dir, e.g. "receipts/2026/ER-2026-0001.pdf" */
    attachmentPath: text("attachment_path"),
    attachmentName: str("attachment_name"),
    /** original photo when the receipt was cropped/straightened; attachmentPath then points to the cropped image */
    attachmentOriginalPath: text("attachment_original_path"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("expenses_number_uq").on(t.number),
    index("expenses_issue_date_idx").on(t.issueDate),
    index("expenses_supplier_idx").on(t.supplierName),
    index("expenses_paid_idx").on(t.paidAt),
  ],
);

export const expenseLines = sqliteTable(
  "expense_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    expenseId: integer("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** category key from the expenses feature's category list */
    category: text("category").notNull(),
    description: str("description"),
    netCents: integer("net_cents").notNull().default(0),
    taxRateBp: integer("tax_rate_bp").notNull().default(2000),
    /** stored (not derived) so receipt rounding can be matched exactly */
    taxCents: integer("tax_cents").notNull().default(0),
    /** share of input VAT that is deductible (e.g. 5000 = 50 %), 10000 = fully */
    deductibleBp: integer("deductible_bp").notNull().default(10000),
  },
  (t) => [index("expense_lines_expense_idx").on(t.expenseId, t.position), index("expense_lines_category_idx").on(t.category)],
);

/**
 * On-demand receipt analysis (text extraction / OCR / field extraction) for an expense's attachment.
 * Uploading never creates a run; the user queues analyses explicitly. One row per run, newest wins.
 */
export const receiptAnalyses = sqliteTable(
  "receipt_analyses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    expenseId: integer("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    /** "queued" | "running" | "done" | "failed" | "cancelled" */
    status: text("status").notNull().default("queued"),
    /** attachment analysed (to detect a replaced receipt) */
    attachmentPath: text("attachment_path"),
    /** how the text was obtained: "xml" | "pdf_text" | "vision" | "tesseract" | ... */
    textSource: text("text_source"),
    text: str("text"),
    /** extracted fields with confidences (JSON, shape owned by the receipt-ocr feature) */
    result: text("result", { mode: "json" }).$type<unknown>(),
    /** model used for field extraction, e.g. "qwen3.5:4b" */
    model: str("model"),
    error: str("error"),
    /** set once the user applied the suggestions to the expense */
    appliedAt: text("applied_at"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    ...timestamps,
  },
  (t) => [index("receipt_analyses_expense_idx").on(t.expenseId), index("receipt_analyses_status_idx").on(t.status)],
);

export const bankAccounts = sqliteTable("bank_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  iban: str("iban"),
  bankName: str("bank_name"),
  /** remembered CSV column mapping (JSON, shape owned by the bank feature) */
  csvMapping: text("csv_mapping", { mode: "json" }).$type<unknown>(),
  /** "off" | "safe" | "aggressive" — auto-apply level for payment matching */
  autoMatch: text("auto_match").$type<"off" | "safe" | "aggressive">().notNull().default("safe"),
  archivedAt: text("archived_at"),
  ...timestamps,
});

export const bankImports = sqliteTable("bank_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => bankAccounts.id, { onDelete: "cascade" }),
  fileName: str("file_name"),
  /** "csv" | "camt053" | ... */
  format: text("format").notNull(),
  importedCount: integer("imported_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  ...timestamps,
});

export const bankTransactions = sqliteTable(
  "bank_transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    importId: integer("import_id").references(() => bankImports.id, { onDelete: "set null" }),
    bookingDate: text("booking_date").notNull(),
    valueDate: text("value_date"),
    /** signed: incoming > 0, outgoing < 0 */
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("EUR"),
    counterpartyName: str("counterparty_name"),
    counterpartyIban: str("counterparty_iban"),
    /** Verwendungszweck */
    purpose: str("purpose"),
    /** bank/end-to-end reference if provided */
    reference: str("reference"),
    /** dedupe key across overlapping imports */
    importHash: text("import_hash").notNull(),
    /** "open" | "matched" | "ignored" — shape owned by the bank feature */
    status: text("status").notNull().default("open"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("bank_transactions_hash_uq").on(t.accountId, t.importHash),
    index("bank_transactions_date_idx").on(t.bookingDate),
    index("bank_transactions_status_idx").on(t.status),
  ],
);

/** Allocation of (part of) a bank transaction to an invoice/credit note or an expense. Supports split and partial payments. */
export const bankMatches = sqliteTable(
  "bank_matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => bankTransactions.id, { onDelete: "cascade" }),
    documentId: integer("document_id").references(() => documents.id, { onDelete: "cascade" }),
    expenseId: integer("expense_id").references(() => expenses.id, { onDelete: "cascade" }),
    /** positive amount allocated */
    amountCents: integer("amount_cents").notNull(),
    /** "auto" | "manual" */
    source: text("source").notNull().default("manual"),
    ...timestamps,
  },
  (t) => [
    index("bank_matches_tx_idx").on(t.transactionId),
    index("bank_matches_document_idx").on(t.documentId),
    index("bank_matches_expense_idx").on(t.expenseId),
  ],
);

/**
 * Recurring outgoing payments (Fixkosten: SVS, rent, subscriptions, insurance). Used by the forecast only;
 * nothing is booked automatically. Schedule semantics like recurringInvoices (anchored day of month).
 */
export const recurringExpenses = sqliteTable(
  "recurring_expenses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** label, e.g. "SVS Beiträge" */
    name: text("name").notNull(),
    supplierName: str("supplier_name"),
    /** expense category key (src/shared/expenses.ts) */
    category: text("category").notNull().default("sonstiges"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    intervalUnit: text("interval_unit").$type<"month" | "year">().notNull().default("month"),
    intervalCount: integer("interval_count").notNull().default(1),
    /** first payment date; later ones are anchored to its day of month */
    startDate: text("start_date").notNull(),
    /** last possible payment date; null = open-ended */
    endDate: text("end_date"),
    /** amount leaving the account per payment */
    grossCents: integer("gross_cents").notNull().default(0),
    /** deductible input VAT contained in grossCents (reduces the VAT payable in the forecast) */
    taxCents: integer("tax_cents").notNull().default(0),
    notes: str("notes"),
    ...timestamps,
  },
  (t) => [index("recurring_expenses_active_idx").on(t.active)],
);

/**
 * Links a booked expense to one scheduled Fixkosten payment ("Miete November" → ER-2026-0042), so the
 * forecast counts that payment once: a linked payment is no longer projected from the Fixkosten schedule.
 */
export const recurringExpensePayments = sqliteTable(
  "recurring_expense_payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recurringExpenseId: integer("recurring_expense_id")
      .notNull()
      .references(() => recurringExpenses.id, { onDelete: "cascade" }),
    /** an expense covers at most one scheduled payment */
    expenseId: integer("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    /** the scheduled payment date (from the Fixkosten schedule) this expense covers */
    scheduledDate: text("scheduled_date").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("recurring_expense_payments_expense_uq").on(t.expenseId),
    uniqueIndex("recurring_expense_payments_slot_uq").on(t.recurringExpenseId, t.scheduledDate),
  ],
);

/**
 * Anlagenverzeichnis: assets over the GWG limit, depreciated straight-line (AfA) over their useful life.
 * Expense lines with category "anlagen" are capitalized (not expensed); the AfA from this table replaces them.
 */
export const fixedAssets = sqliteTable(
  "fixed_assets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** running asset number shown to the user (AV-0001) */
    number: integer("number").notNull(),
    name: text("name").notNull(),
    /** expense the asset was bought with (optional) */
    expenseId: integer("expense_id").references(() => expenses.id, { onDelete: "set null" }),
    acquisitionDate: text("acquisition_date").notNull(),
    /** Inbetriebnahme; decides full vs. half-year AfA in the first year */
    inServiceDate: text("in_service_date").notNull(),
    /** Anschaffungskosten (net, plus non-deductible VAT) */
    costCents: integer("cost_cents").notNull(),
    usefulLifeYears: integer("useful_life_years").notNull(),
    /** sold / scrapped; remaining book value is written off in that year */
    disposalDate: text("disposal_date"),
    disposalProceedsCents: integer("disposal_proceeds_cents"),
    notes: str("notes"),
    ...timestamps,
  },
  (t) => [uniqueIndex("fixed_assets_number_uq").on(t.number), index("fixed_assets_expense_idx").on(t.expenseId)],
);

/** In-app assistant ("Assistent"): one row per conversation. */
export const chatConversations = sqliteTable("chat_conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** short title, derived from the first user message (editable) */
  title: str("title"),
  ...timestamps,
});

/**
 * Messages of a conversation in OpenAI chat format order. Assistant messages may carry tool calls; each tool
 * result is its own row (role "tool"). A state-changing tool call waits for the user's confirmation
 * (status "pending") before it is executed.
 */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant" | "tool">().notNull(),
    content: str("content"),
    /** assistant: [{ id, name, arguments }] (shape = ChatToolCall[]) */
    toolCalls: text("tool_calls", { mode: "json" }).$type<unknown>(),
    /** tool: the call this row answers */
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    /** tool: structured result for the UI (links, ids; shape = ChatToolResult) */
    toolResult: text("tool_result", { mode: "json" }).$type<unknown>(),
    /** "done" | "pending" (awaiting confirmation) | "cancelled" | "error" */
    status: text("status").$type<"done" | "pending" | "cancelled" | "error">().notNull().default("done"),
    /** page the user was on when sending (user messages), e.g. "/invoices/12" */
    contextPath: text("context_path"),
    ...timestamps,
  },
  (t) => [index("chat_messages_conversation_idx").on(t.conversationId, t.id)],
);

/**
 * Receipt inbox: files picked up from settings.receiptInboxPath (copied to data/receipts/inbox/). Nothing is
 * analysed automatically; the user turns an item into an expense (and may queue analysis) or dismisses it.
 */
export const receiptInboxItems = sqliteTable(
  "receipt_inbox_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fileName: text("file_name").notNull(),
    /** copy relative to data dir, e.g. "receipts/inbox/3-rechnung.pdf"; cleared when converted/dismissed and moved */
    storedPath: text("stored_path"),
    /** where the file was found */
    sourcePath: str("source_path"),
    /** sha256 of the file, for de-duplication */
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    /** "new" | "converted" | "dismissed" */
    status: text("status").$type<"new" | "converted" | "dismissed">().notNull().default("new"),
    expenseId: integer("expense_id").references(() => expenses.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("receipt_inbox_sha_uq").on(t.sha256), index("receipt_inbox_status_idx").on(t.status)],
);

/** Assistant answers the user flagged as wrong; exported as draft eval cases (bun run eval:feedback). */
export const chatFeedback = sqliteTable(
  "chat_feedback",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    /** the flagged assistant message */
    messageId: integer("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    /** what the user expected, optional */
    note: str("note"),
    ...timestamps,
  },
  (t) => [uniqueIndex("chat_feedback_message_uq").on(t.messageId)],
);

export const numberSequences = sqliteTable(
  "number_sequences",
  {
    type: text("type").$type<NumberedType>().notNull(),
    year: integer("year").notNull(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.type, t.year] })],
);

export type Settings = typeof settings.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentItem = typeof documentItems.$inferSelect;
export type NewDocumentItem = typeof documentItems.$inferInsert;
export type PdfTemplate = typeof pdfTemplates.$inferSelect;
export type Article = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;
export type RecurringInvoice = typeof recurringInvoices.$inferSelect;
export type NewRecurringInvoice = typeof recurringInvoices.$inferInsert;
export type RecurringInvoiceItem = typeof recurringInvoiceItems.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
export type ExpenseLine = typeof expenseLines.$inferSelect;
export type ReceiptAnalysis = typeof receiptAnalyses.$inferSelect;
export type BankAccount = typeof bankAccounts.$inferSelect;
export type BankImport = typeof bankImports.$inferSelect;
export type BankTransaction = typeof bankTransactions.$inferSelect;
export type NewBankTransaction = typeof bankTransactions.$inferInsert;
export type BankMatch = typeof bankMatches.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
export type RecurringExpense = typeof recurringExpenses.$inferSelect;
export type NewRecurringExpense = typeof recurringExpenses.$inferInsert;
export type FixedAsset = typeof fixedAssets.$inferSelect;
export type RecurringExpensePayment = typeof recurringExpensePayments.$inferSelect;
export type ChatConversation = typeof chatConversations.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewFixedAsset = typeof fixedAssets.$inferInsert;
export type NewPdfTemplate = typeof pdfTemplates.$inferInsert;

