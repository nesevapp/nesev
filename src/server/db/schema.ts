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
export type NewReminder = typeof reminders.$inferInsert;
export type NewPdfTemplate = typeof pdfTemplates.$inferInsert;

