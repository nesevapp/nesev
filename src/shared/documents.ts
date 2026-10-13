// Document types, statuses and numbering — shared by server and web.

export const DOCUMENT_TYPES = ["offer", "invoice", "credit_note"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  offer: "Angebot",
  invoice: "Rechnung",
  credit_note: "Gutschrift",
};

export const OFFER_STATUSES = ["draft", "final", "sent", "accepted", "declined"] as const;
export const INVOICE_STATUSES = ["draft", "final", "sent", "paid"] as const;
export const CREDIT_NOTE_STATUSES = ["draft", "final"] as const;

export const DOCUMENT_STATUSES = ["draft", "final", "sent", "accepted", "declined", "paid"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const STATUSES_BY_TYPE: Record<DocumentType, readonly DocumentStatus[]> = {
  offer: OFFER_STATUSES,
  invoice: INVOICE_STATUSES,
  credit_note: CREDIT_NOTE_STATUSES,
};

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: "Entwurf",
  final: "Finalisiert",
  sent: "Versendet",
  accepted: "Angenommen",
  declined: "Abgelehnt",
  paid: "Bezahlt",
};

/** Number sequences also cover reminders (Mahnungen, see ./reminders), which are not documents. */
export type NumberedType = DocumentType | "reminder";

export const DOCUMENT_NUMBER_PREFIX: Record<NumberedType, string> = {
  offer: "AN",
  invoice: "RE",
  credit_note: "GS",
  reminder: "MA",
};

/** PDF templates exist per document type plus one type for reminders. */
export const TEMPLATE_DOC_TYPES = [...DOCUMENT_TYPES, "reminder"] as const;
export type TemplateDocType = (typeof TEMPLATE_DOC_TYPES)[number];

export const TEMPLATE_DOC_TYPE_LABELS: Record<TemplateDocType, string> = {
  ...DOCUMENT_TYPE_LABELS,
  reminder: "Mahnung",
};

/** formatDocumentNumber("invoice", 2026, 1) → "RE-2026-0001" */
export function formatDocumentNumber(type: NumberedType, year: number, seq: number): string {
  return `${DOCUMENT_NUMBER_PREFIX[type]}-${year}-${String(seq).padStart(4, "0")}`;
}

/** Status changes on finalized documents (POST /api/documents/:id/status). "unpaid" reverts "paid". */
export const STATUS_ACTIONS = ["sent", "accepted", "declined", "paid", "unpaid"] as const;
export type StatusAction = (typeof STATUS_ACTIONS)[number];

/** Allowed actions per type and current status. Drafts change status only via finalize. */
export const ALLOWED_STATUS_ACTIONS: Record<DocumentType, Partial<Record<DocumentStatus, readonly StatusAction[]>>> = {
  offer: {
    final: ["sent", "accepted", "declined"],
    sent: ["accepted", "declined"],
    accepted: ["declined"],
    declined: ["accepted"],
  },
  invoice: {
    final: ["sent", "paid"],
    sent: ["paid"],
    paid: ["unpaid"],
  },
  credit_note: {},
};

export const STATUS_ACTION_LABELS: Record<StatusAction, string> = {
  sent: "Als versendet markieren",
  accepted: "Als angenommen markieren",
  declined: "Als abgelehnt markieren",
  paid: "Als bezahlt markieren",
  unpaid: "Zahlung zurücksetzen",
};

export const OVERDUE_LABEL = "Überfällig";

/** Invoices that are final/sent (not paid) with a due date before `today` ("YYYY-MM-DD"). */
export function isOverdue(
  doc: { type: DocumentType; status: DocumentStatus; dueDate: string | null },
  today: string,
): boolean {
  return (
    doc.type === "invoice" && (doc.status === "final" || doc.status === "sent") && !!doc.dueDate && doc.dueDate < today
  );
}
