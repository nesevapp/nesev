import { and, asc, desc, eq, gte, inArray, lte, ne, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { addDays, todayIso } from "../../shared/dates";
import {
  ALLOWED_STATUS_ACTIONS,
  type DocumentStatus,
  type DocumentType,
  isOverdue,
} from "../../shared/documents";
import type {
  DocumentCreate,
  DocumentItemInput,
  DocumentListQuery,
  DocumentStatusInput,
  DocumentUpdate,
} from "../../shared/schemas/document";
import { formatCents } from "../../shared/money";
import { countryName } from "../../shared/countries";
import { defaultTaxMode, isEuCountry, requiresClientUid, TAX_MODE_LABELS, type TaxMode } from "../../shared/tax";
import { calcTotals } from "../../shared/totals";
import type { DbOrTx } from "../db/client";
import { type Client, type Document, type DocumentItem, clients, documentItems, documents } from "../db/schema";
import { nextNumber } from "../lib/numbering";
import { bumpArticleUsage, existingArticleIds } from "./articles";
import { creditedCentsByInvoice, invoicePaymentState, invoicePaymentStates, lastPaymentDate, paidCentsForDocument } from "./bank";
import { clientSnapshot, getClient } from "./clients";
import { getSettings, sellerSnapshot } from "./settings";

// Business rules for offers, invoices and credit notes.
// - Drafts are freely editable; finalize assigns the gapless number, freezes client + seller snapshots
//   and locks the document (edits → 409). Corrections to invoices only via credit note.
// - Credit notes store POSITIVE amounts (items copied 1:1 from the invoice). Their meaning
//   (amount owed to the client) comes from type = "credit_note"; reports must subtract them. On finalize a credit
//   note must keep its invoice's tax mode, and the invoice's finalized credit notes may not exceed its gross.
// - Totals are cached on the document (net/tax/gross) whenever items or the tax mode change.
// - An invoice is "paid" once finalized credit notes plus bank allocations cover its gross (settleInvoice);
//   the user can also mark it paid by hand. Resetting a payment that bank allocations cover is refused (409)
//   unless the allocations are removed with it (routes/documents.ts → removeDocumentAllocations).

export interface DocumentRef {
  id: number;
  type: DocumentType;
  number: string | null;
  status: DocumentStatus;
}

export type DocumentListRow = Document & {
  clientName: string;
  overdue: boolean;
  /** finalized invoices: gross − credit notes − bank allocations; null otherwise */
  openCents: number | null;
  /** finalized, unpaid invoice with bank payments that don't cover it yet ("teilbezahlt") */
  partial: boolean;
};
export type DocumentDetail = DocumentListRow & {
  items: DocumentItem[];
  parent: DocumentRef | null;
  children: DocumentRef[];
};

const notFound = () => new HTTPException(404, { message: "Beleg nicht gefunden" });
const unprocessable = (message: string) => new HTTPException(422, { message });
const conflict = (message: string) => new HTTPException(409, { message });

// ── Reads ───────────────────────────────────────────────────────────────────────

type PaymentStates = ReturnType<typeof invoicePaymentStates>;

function paymentStates(db: DbOrTx, docs: Document[]): PaymentStates {
  return invoicePaymentStates(db, docs.filter((d) => d.type === "invoice" && d.status !== "draft"));
}

function withDerived(doc: Document, liveClientName: string | null, today: string, states: PaymentStates): DocumentListRow {
  const state = states.get(doc.id);
  const unpaid = doc.status === "final" || doc.status === "sent";
  return {
    ...doc,
    clientName: doc.clientSnapshot?.name ?? liveClientName ?? "",
    // nothing left to pay (e.g. fully credited) → not overdue
    overdue: isOverdue(doc, today) && (!state || state.openCents > 0),
    openCents: state?.openCents ?? null,
    partial: unpaid && !!state?.partial,
  };
}

export function listDocuments(db: DbOrTx, query: DocumentListQuery = {}): DocumentListRow[] {
  const today = todayIso();
  const where: SQL[] = [];
  if (query.type) where.push(eq(documents.type, query.type));
  if (query.clientId) where.push(eq(documents.clientId, query.clientId));
  if (query.from) where.push(gte(documents.issueDate, query.from));
  if (query.to) where.push(lte(documents.issueDate, query.to));
  if (query.status === "overdue") where.push(inArray(documents.status, ["final", "sent"]));
  else if (query.status) where.push(eq(documents.status, query.status));

  const raw = db
    .select({ doc: documents, clientName: clients.name })
    .from(documents)
    .leftJoin(clients, eq(clients.id, documents.clientId))
    .where(and(...where))
    .orderBy(desc(documents.issueDate), desc(documents.id))
    .all();
  const states = paymentStates(db, raw.map((r) => r.doc));
  const rows = raw.map((r) => withDerived(r.doc, r.clientName, today, states));

  const q = query.q?.toLowerCase();
  return rows.filter(
    (r) =>
      (query.status !== "overdue" || r.overdue) &&
      (!q ||
        r.clientName.toLowerCase().includes(q) ||
        (r.number ?? "").toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q)),
  );
}

function getRow(db: DbOrTx, id: number): Document {
  const doc = db.select().from(documents).where(eq(documents.id, id)).get();
  if (!doc) throw notFound();
  return doc;
}

function getItems(db: DbOrTx, documentId: number): DocumentItem[] {
  return db
    .select()
    .from(documentItems)
    .where(eq(documentItems.documentId, documentId))
    .orderBy(asc(documentItems.position))
    .all();
}

const refColumns = { id: documents.id, type: documents.type, number: documents.number, status: documents.status };

export function getDocument(db: DbOrTx, id: number): DocumentDetail {
  const doc = getRow(db, id);
  const client = db.select({ name: clients.name }).from(clients).where(eq(clients.id, doc.clientId)).get();
  const parent = doc.parentId
    ? (db.select(refColumns).from(documents).where(eq(documents.id, doc.parentId)).get() ?? null)
    : null;
  const children = db.select(refColumns).from(documents).where(eq(documents.parentId, id)).orderBy(asc(documents.id)).all();
  return { ...withDerived(doc, client?.name ?? null, todayIso(), paymentStates(db, [doc])), items: getItems(db, id), parent, children };
}

// ── Defaults ────────────────────────────────────────────────────────────────────

export interface DocumentDefaults {
  issueDate: string;
  dueDate: string | null;
  validUntil: string | null;
  taxMode: TaxMode;
  introText: string;
  closingText: string;
}

/** Prefill values for a new draft: texts from settings, tax mode and payment terms from the client. */
export function documentDefaults(
  db: DbOrTx,
  type: DocumentType,
  clientId?: number,
  issueDate: string = todayIso(),
): DocumentDefaults {
  const s = getSettings(db);
  const client = clientId ? getClient(db, clientId) : undefined;
  const texts: Record<DocumentType, [string, string]> = {
    offer: [s.defaultOfferIntro, s.defaultOfferClosing],
    invoice: [s.defaultInvoiceIntro, s.defaultInvoiceClosing],
    credit_note: [s.defaultCreditNoteIntro, s.defaultCreditNoteClosing],
  };
  return {
    issueDate,
    dueDate: type === "invoice" ? addDays(issueDate, client?.paymentTermsDays ?? s.paymentTermsDays) : null,
    validUntil: type === "offer" ? addDays(issueDate, s.offerValidityDays) : null,
    taxMode: client ? defaultTaxMode(client, s) : s.smallBusiness ? "SMALL_BUSINESS" : "AT_DOMESTIC",
    introText: texts[type][0],
    closingText: texts[type][1],
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────────

function cachedTotals(items: Pick<DocumentItemInput, "quantity" | "unitPriceCents" | "taxRateBp" | "discountBp">[], taxMode: TaxMode) {
  const t = calcTotals(items, taxMode);
  return { netCents: t.netCents, taxCents: t.taxCents, grossCents: t.grossCents };
}

function replaceItems(tx: DbOrTx, documentId: number, items: DocumentItemInput[]) {
  tx.delete(documentItems).where(eq(documentItems.documentId, documentId)).run();
  if (items.length) {
    // the referenced article may have been deleted meanwhile: keep the line, drop the link
    const known = existingArticleIds(tx, items.map((i) => i.articleId));
    tx.insert(documentItems)
      .values(
        items.map(({ articleId, ...item }, position) => ({
          ...item,
          articleId: articleId && known.has(articleId) ? articleId : null,
          documentId,
          position,
        })),
      )
      .run();
  }
}

function requireClient(db: DbOrTx, clientId: number): Client {
  const client = getClient(db, clientId);
  if (!client) throw unprocessable("Kunde nicht gefunden");
  return client;
}

function requireDraft(doc: Document) {
  if (doc.status !== "draft") throw conflict("Finalisierte Belege können nicht mehr bearbeitet werden");
}

/** Strip DB-only columns so items can be copied onto another document. */
function copyItems(items: DocumentItem[]): DocumentItemInput[] {
  return items.map(({ articleId, title, description, quantity, unit, unitPriceCents, taxRateBp, discountBp }) => ({
    articleId,
    title,
    description,
    quantity,
    unit,
    unitPriceCents,
    taxRateBp,
    discountBp,
  }));
}

/** Create a draft. Fields not given are prefilled via documentDefaults(). */
export function createDocument(db: DbOrTx, input: DocumentCreate & { parentId?: number | null }): DocumentDetail {
  const id = db.transaction((tx) => {
    requireClient(tx, input.clientId);
    const d = documentDefaults(tx, input.type, input.clientId, input.issueDate);
    const taxMode = input.taxMode ?? d.taxMode;
    const items = input.items ?? [];
    const doc = tx
      .insert(documents)
      .values({
        type: input.type,
        status: "draft",
        clientId: input.clientId,
        issueDate: d.issueDate,
        servicePeriodStart: input.servicePeriodStart ?? null,
        servicePeriodEnd: input.servicePeriodEnd ?? null,
        dueDate: input.dueDate !== undefined ? input.dueDate : d.dueDate,
        validUntil: input.validUntil !== undefined ? input.validUntil : d.validUntil,
        taxMode,
        title: input.title ?? "",
        introText: input.introText ?? d.introText,
        closingText: input.closingText ?? d.closingText,
        templateId: input.templateId ?? null,
        buyerReference: input.buyerReference ?? "",
        parentId: input.parentId ?? null,
        ...cachedTotals(items, taxMode),
      })
      .returning({ id: documents.id })
      .get();
    replaceItems(tx, doc.id, items);
    return doc.id;
  });
  return getDocument(db, id);
}

/** Update a draft (409 once finalized). `items`, if given, replaces all items; totals are recomputed. */
export function updateDocument(db: DbOrTx, id: number, patch: DocumentUpdate): DocumentDetail {
  db.transaction((tx) => {
    const doc = getRow(tx, id);
    requireDraft(doc);
    if (patch.clientId !== undefined) requireClient(tx, patch.clientId);
    const { items, ...fields } = patch;
    if (items) replaceItems(tx, id, items);
    const taxMode = fields.taxMode ?? doc.taxMode;
    tx.update(documents)
      .set({ ...fields, ...cachedTotals(items ?? getItems(tx, id), taxMode) })
      .where(eq(documents.id, id))
      .run();
  });
  return getDocument(db, id);
}

export function deleteDocument(db: DbOrTx, id: number): void {
  const doc = getRow(db, id);
  if (doc.status !== "draft") throw conflict("Nur Entwürfe können gelöscht werden");
  db.delete(documents).where(eq(documents.id, id)).run();
}

/**
 * Validate and finalize a draft in one transaction: gapless number (year of the issue date),
 * client + seller snapshots, missing due/valid-until dates filled in, totals recomputed, status "final".
 * Rendering the frozen PDF happens afterwards (see routes/documents.ts) and never rolls this back.
 */
export function finalizeDocument(db: DbOrTx, id: number): DocumentDetail {
  db.transaction((tx) => {
    const doc = getRow(tx, id);
    if (doc.status !== "draft") throw conflict("Beleg ist bereits finalisiert");
    const client = getClient(tx, doc.clientId);
    if (!client) throw unprocessable("Bitte einen Kunden auswählen");
    const items = getItems(tx, id);
    if (items.length === 0) throw unprocessable("Mindestens eine Position ist erforderlich");
    const untitled = items.findIndex((i) => !i.title.trim());
    if (untitled >= 0) throw unprocessable(`Position ${untitled + 1}: Bezeichnung fehlt`);
    if (requiresClientUid(doc.taxMode) && !client.uid.trim()) {
      throw unprocessable("Reverse Charge erfordert eine UID-Nummer beim Kunden");
    }
    if (doc.servicePeriodStart && doc.servicePeriodEnd && doc.servicePeriodEnd < doc.servicePeriodStart) {
      throw unprocessable("Leistungszeitraum: Ende liegt vor dem Beginn");
    }
    if (doc.type === "credit_note" && doc.parentId) checkCreditNote(tx, doc, cachedTotals(items, doc.taxMode).grossCents);

    const settings = getSettings(tx);
    const d = documentDefaults(tx, doc.type, doc.clientId, doc.issueDate);
    const { number } = nextNumber(tx, doc.type, Number(doc.issueDate.slice(0, 4)));
    tx.update(documents)
      .set({
        status: "final",
        number,
        clientSnapshot: clientSnapshot(client),
        sellerSnapshot: sellerSnapshot(settings),
        dueDate: doc.dueDate ?? d.dueDate,
        validUntil: doc.validUntil ?? d.validUntil,
        finalizedAt: new Date().toISOString(),
        ...cachedTotals(items, doc.taxMode),
      })
      .where(eq(documents.id, id))
      .run();
    // catalog usage drives the line-item picker order; a credit note is a correction, not a use
    if (doc.type !== "credit_note") bumpArticleUsage(tx, items.map((i) => i.articleId));
    // a credit note may settle its invoice (together with bank payments)
    else if (doc.parentId) settleInvoice(tx, doc.parentId);
  });
  return getDocument(db, id);
}

/**
 * A credit note corrects its invoice (§ 11 Abs. 1, § 16 UStG): it must use the invoice's tax mode, and all
 * finalized credit notes together (this one included) can't exceed the invoice's gross.
 */
function checkCreditNote(tx: DbOrTx, doc: Document, grossCents: number): void {
  const parent = tx.select().from(documents).where(eq(documents.id, doc.parentId!)).get();
  if (!parent || parent.type !== "invoice" || parent.status === "draft") {
    throw unprocessable("Die Gutschrift gehört zu keiner finalisierten Rechnung");
  }
  if (doc.taxMode !== parent.taxMode) {
    throw unprocessable(
      `Die Gutschrift muss die Steuerart der Rechnung ${parent.number} übernehmen (${TAX_MODE_LABELS[parent.taxMode]} statt ${TAX_MODE_LABELS[doc.taxMode]})`,
    );
  }
  const credited = creditedCentsByInvoice(tx, [parent.id]).get(parent.id) ?? 0;
  if (credited + grossCents > parent.grossCents) {
    const left = Math.max(0, parent.grossCents - credited);
    throw unprocessable(
      `Gutschriften übersteigen die Rechnung ${parent.number}: ${formatCents(credited + grossCents)} gutgeschrieben, Rechnungsbetrag ${formatCents(parent.grossCents)} (noch offen für Gutschriften: ${formatCents(left)})`,
    );
  }
}

/** Gross amount above which an invoice to a business must name the recipient's UID (§ 11 Abs. 1 Z 3 lit. i UStG). */
export const UID_REQUIRED_ABOVE_CENTS = 1_000_000;

/**
 * Non-blocking hints before finalizing a draft (finalizeDocument doesn't use them; the editor shows them in the
 * finalize dialog, GET /api/documents/:id/finalize-warnings):
 * - an Austrian invoice to a business above € 10.000 gross without the recipient's UID;
 * - reverse charge without our own UID (§ 11 Abs. 1a UStG: the invoice names both UIDs);
 * - Kleinunternehmer invoicing a foreign business: for services the place of supply is abroad (§ 3a Abs. 6 UStG),
 *   so the exemption doesn't cover them (see defaultTaxMode in shared/tax.ts).
 * Credit notes inherit their invoice's tax mode (checkCreditNote) and get no tax-mode hints.
 */
export function finalizeWarnings(db: DbOrTx, id: number): string[] {
  const doc = getRow(db, id);
  const warnings: string[] = [];
  if (doc.status !== "draft" || doc.type === "credit_note") return warnings;
  const client = getClient(db, doc.clientId);
  if (!client) return warnings;
  const s = getSettings(db);
  const ownUid = !!s.uid.trim();
  const country = client.country.toUpperCase();
  const business = client.type === "company" || !!client.uid.trim();

  if (doc.type === "invoice" && doc.taxMode === "AT_DOMESTIC") {
    const gross = cachedTotals(getItems(db, id), doc.taxMode).grossCents;
    if (client.type === "company" && !client.uid.trim() && gross > UID_REQUIRED_ABOVE_CENTS) {
      warnings.push(
        `Rechnungsbetrag über ${formatCents(UID_REQUIRED_ABOVE_CENTS)} brutto: Die UID-Nummer des Kunden muss auf der Rechnung stehen (§ 11 Abs. 1 Z 3 lit. i UStG) — beim Kunden hinterlegen.`,
      );
    }
  }
  if (doc.taxMode === "EU_REVERSE_CHARGE" && !ownUid) {
    warnings.push(
      "Reverse Charge ohne eigene UID-Nummer: Die Rechnung muss Ihre UID und die des Kunden enthalten (§ 11 Abs. 1a UStG). UID beim Finanzamt beantragen und unter Einstellungen → Unternehmen hinterlegen.",
    );
  }
  if (doc.taxMode === "SMALL_BUSINESS" && country !== "AT" && business) {
    const where = countryName(country);
    if (isEuCountry(country)) {
      warnings.push(
        `Kunde ist ein Unternehmen in ${where}: Bei Dienstleistungen liegt der Leistungsort dort (§ 3a Abs. 6 UStG), die Kleinunternehmerbefreiung gilt dafür nicht. Richtig ist „${TAX_MODE_LABELS.EU_REVERSE_CHARGE}“ mit der UID des Kunden${ownUid ? "" : " und Ihrer eigenen UID-Nummer (beim Finanzamt beantragen, unter Einstellungen → Unternehmen hinterlegen)"}; die Leistung gehört in die Zusammenfassende Meldung. Für Warenlieferungen bleibt es bei der Kleinunternehmerregelung.`,
      );
    } else {
      warnings.push(
        `Kunde ist ein Unternehmen in ${where}: Bei Dienstleistungen liegt der Leistungsort dort (§ 3a Abs. 6 UStG), nicht in Österreich. Richtig ist „${TAX_MODE_LABELS.THIRD_COUNTRY}“ (nicht steuerbar), die Kleinunternehmerbefreiung gilt dafür nicht.`,
      );
    }
  }
  return warnings;
}

export function setPdfPath(db: DbOrTx, id: number, pdfPath: string | null): void {
  db.update(documents).set({ pdfPath }).where(eq(documents.id, id)).run();
}

export const PAID_BY_BANK_MESSAGE =
  "Diese Rechnung ist durch Bankbuchungen bezahlt. Bitte die Zuordnungen ebenfalls entfernen, um die Zahlung zurückzusetzen.";

/**
 * Status transitions on finalized documents, see ALLOWED_STATUS_ACTIONS. "unpaid" is refused (409) while bank
 * allocations cover part of the invoice: the route removes them first when `removeAllocations` is set.
 */
export function changeStatus(db: DbOrTx, id: number, { action, paidAt }: Omit<DocumentStatusInput, "removeAllocations">): DocumentDetail {
  const doc = getRow(db, id);
  if (doc.status === "draft") throw conflict("Beleg muss zuerst finalisiert werden");
  const allowed = ALLOWED_STATUS_ACTIONS[doc.type][doc.status] ?? [];
  if (!allowed.includes(action)) throw conflict("Dieser Statuswechsel ist nicht möglich");
  if (action === "unpaid" && paidCentsForDocument(db, id) > 0) throw conflict(PAID_BY_BANK_MESSAGE);

  const set: Partial<Document> = (() => {
    switch (action) {
      case "sent":
        return { status: "sent", sentAt: new Date().toISOString() };
      case "accepted":
      case "declined":
        return { status: action };
      case "paid":
        // calendar date chosen by the user ("YYYY-MM-DD")
        return { status: "paid", paidAt: paidAt ?? todayIso() };
      case "unpaid":
        return { status: doc.sentAt ? "sent" : "final", paidAt: null };
    }
  })();
  db.update(documents).set(set).where(eq(documents.id, id)).run();
  return getDocument(db, id);
}

/** Set or clear an invoice's payment without the user-facing checks (automatic settlement). */
function setPaidAt(db: DbOrTx, doc: Document, paidAt: string | null): void {
  const set: Partial<Document> = paidAt ? { status: "paid", paidAt } : { status: doc.sentAt ? "sent" : "final", paidAt: null };
  db.update(documents).set(set).where(eq(documents.id, doc.id)).run();
}

/**
 * Bring an invoice's paid status in line with what settles it: its open amount (invoicePaymentState: gross −
 * finalized credit notes − bank payments + refunds on its credit notes) is 0 or less.
 * Covered → "paid" with paidAt = the latest payment or credit note date. No longer covered (or a later date) →
 * reverted/moved, but only if paidAt was set automatically: `autoDates` (booking dates of its allocations
 * before the change) or a credit note's date. A payment marked by hand stays untouched.
 * Called with a credit note (e.g. a refund allocated to it), it settles the credit note's invoice.
 */
export function settleInvoice(db: DbOrTx, invoiceId: number, autoDates: Set<string> = new Set()): void {
  const doc = db.select().from(documents).where(eq(documents.id, invoiceId)).get();
  if (doc?.type === "credit_note" && doc.parentId != null && doc.parentId !== invoiceId) {
    // the invoice's own allocations didn't change: a paidAt on its last booking date was set automatically
    const own = lastPaymentDate(db, { documentId: doc.parentId });
    return settleInvoice(db, doc.parentId, new Set(own ? [own] : []));
  }
  if (!doc || doc.type !== "invoice" || doc.status === "draft") return;
  const creditDates = db
    .select({ issueDate: documents.issueDate })
    .from(documents)
    .where(and(eq(documents.parentId, invoiceId), eq(documents.type, "credit_note"), ne(documents.status, "draft")))
    .all()
    .map((c) => c.issueDate);
  const state = invoicePaymentState(db, doc);
  const creditedCents = doc.grossCents - state.dueCents;
  const covered = creditedCents + state.paidCents > 0 && state.openCents <= 0;
  const dates = [lastPaymentDate(db, { documentId: invoiceId }), ...creditDates].filter((d): d is string => !!d).sort();
  const last = dates.at(-1) ?? null;
  const auto = doc.paidAt != null && (autoDates.has(doc.paidAt) || creditDates.includes(doc.paidAt));
  if (covered && (doc.status === "final" || doc.status === "sent")) setPaidAt(db, doc, last ?? todayIso());
  else if (doc.status === "paid" && auto) {
    if (!covered) setPaidAt(db, doc, null);
    else if (last && last !== doc.paidAt) setPaidAt(db, doc, last);
  }
}

/**
 * Offer → new draft invoice (any offer status). Copies client, tax mode, title, service period and items;
 * intro/closing texts come from the invoice defaults (offer wording doesn't fit an invoice).
 * A final/sent offer is marked accepted.
 */
export function convertOfferToInvoice(db: DbOrTx, offerId: number): DocumentDetail {
  return db.transaction((tx) => {
    const offer = getRow(tx, offerId);
    if (offer.type !== "offer") throw unprocessable("Nur Angebote können in Rechnungen umgewandelt werden");
    const invoice = createDocument(tx, {
      type: "invoice",
      clientId: offer.clientId,
      taxMode: offer.taxMode,
      title: offer.title,
      servicePeriodStart: offer.servicePeriodStart,
      servicePeriodEnd: offer.servicePeriodEnd,
      buyerReference: offer.buyerReference,
      items: copyItems(getItems(tx, offerId)),
      parentId: offer.id,
    });
    if (offer.status === "final" || offer.status === "sent") {
      tx.update(documents).set({ status: "accepted" }).where(eq(documents.id, offerId)).run();
    }
    return invoice;
  });
}

/**
 * Finalized invoice → new draft credit note with the same items (positive amounts, see top of file),
 * tax mode, client and service period. The user removes/adjusts lines for a partial credit.
 */
export function createCreditNote(db: DbOrTx, invoiceId: number): DocumentDetail {
  return db.transaction((tx) => {
    const invoice = getRow(tx, invoiceId);
    if (invoice.type !== "invoice") throw unprocessable("Gutschriften können nur zu Rechnungen erstellt werden");
    if (invoice.status === "draft") throw conflict("Rechnung muss zuerst finalisiert werden");
    return createDocument(tx, {
      type: "credit_note",
      clientId: invoice.clientId,
      taxMode: invoice.taxMode,
      title: `Gutschrift zu Rechnung ${invoice.number}`,
      servicePeriodStart: invoice.servicePeriodStart,
      servicePeriodEnd: invoice.servicePeriodEnd,
      buyerReference: invoice.buyerReference,
      items: copyItems(getItems(tx, invoiceId)),
      parentId: invoice.id,
    });
  });
}

/** Copy any document into a new draft of the same type with fresh dates. Credit notes keep their invoice reference. */
export function duplicateDocument(db: DbOrTx, id: number): DocumentDetail {
  return db.transaction((tx) => {
    const doc = getRow(tx, id);
    return createDocument(tx, {
      type: doc.type,
      clientId: doc.clientId,
      taxMode: doc.taxMode,
      title: doc.title,
      introText: doc.introText,
      closingText: doc.closingText,
      servicePeriodStart: doc.servicePeriodStart,
      servicePeriodEnd: doc.servicePeriodEnd,
      templateId: doc.templateId,
      buyerReference: doc.buyerReference,
      items: copyItems(getItems(tx, id)),
      parentId: doc.type === "credit_note" ? doc.parentId : null,
    });
  });
}
