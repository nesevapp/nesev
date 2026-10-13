import { and, asc, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
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
import { defaultTaxMode, requiresClientUid, type TaxMode } from "../../shared/tax";
import { calcTotals } from "../../shared/totals";
import type { DbOrTx } from "../db/client";
import { type Client, type Document, type DocumentItem, clients, documentItems, documents } from "../db/schema";
import { nextNumber } from "../lib/numbering";
import { bumpArticleUsage, existingArticleIds } from "./articles";
import { clientSnapshot, getClient } from "./clients";
import { getSettings, sellerSnapshot } from "./settings";

// Business rules for offers, invoices and credit notes.
// - Drafts are freely editable; finalize assigns the gapless number, freezes client + seller snapshots
//   and locks the document (edits → 409). Corrections to invoices only via credit note.
// - Credit notes store POSITIVE amounts (items copied 1:1 from the invoice). Their meaning
//   (amount owed to the client) comes from type = "credit_note"; reports must subtract them.
// - Totals are cached on the document (net/tax/gross) whenever items or the tax mode change.

export interface DocumentRef {
  id: number;
  type: DocumentType;
  number: string | null;
  status: DocumentStatus;
}

export type DocumentListRow = Document & { clientName: string; overdue: boolean };
export type DocumentDetail = DocumentListRow & {
  items: DocumentItem[];
  parent: DocumentRef | null;
  children: DocumentRef[];
};

const notFound = () => new HTTPException(404, { message: "Beleg nicht gefunden" });
const unprocessable = (message: string) => new HTTPException(422, { message });
const conflict = (message: string) => new HTTPException(409, { message });

// ── Reads ───────────────────────────────────────────────────────────────────────

function withDerived(doc: Document, liveClientName: string | null, today: string): DocumentListRow {
  return {
    ...doc,
    clientName: doc.clientSnapshot?.name ?? liveClientName ?? "",
    overdue: isOverdue(doc, today),
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

  const rows = db
    .select({ doc: documents, clientName: clients.name })
    .from(documents)
    .leftJoin(clients, eq(clients.id, documents.clientId))
    .where(and(...where))
    .orderBy(desc(documents.issueDate), desc(documents.id))
    .all()
    .map((r) => withDerived(r.doc, r.clientName, today));

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
  return { ...withDerived(doc, client?.name ?? null, todayIso()), items: getItems(db, id), parent, children };
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
  });
  return getDocument(db, id);
}

export function setPdfPath(db: DbOrTx, id: number, pdfPath: string | null): void {
  db.update(documents).set({ pdfPath }).where(eq(documents.id, id)).run();
}

/** Status transitions on finalized documents, see ALLOWED_STATUS_ACTIONS. */
export function changeStatus(db: DbOrTx, id: number, { action, paidAt }: DocumentStatusInput): DocumentDetail {
  const doc = getRow(db, id);
  if (doc.status === "draft") throw conflict("Beleg muss zuerst finalisiert werden");
  const allowed = ALLOWED_STATUS_ACTIONS[doc.type][doc.status] ?? [];
  if (!allowed.includes(action)) throw conflict("Dieser Statuswechsel ist nicht möglich");

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
      items: copyItems(getItems(tx, id)),
      parentId: doc.type === "credit_note" ? doc.parentId : null,
    });
  });
}
