import { and, asc, count, desc, eq, lte, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { todayIso } from "../../shared/dates";
import { isOverdue } from "../../shared/documents";
import { coveredPeriod, nextRunAfter } from "../../shared/recurring";
import type { DocumentItemInput } from "../../shared/schemas/document";
import type { RecurringCreate, RecurringUpdate } from "../../shared/schemas/recurring";
import { calcTotals } from "../../shared/totals";
import type { Db, DbOrTx } from "../db/client";
import {
  clients,
  documents,
  type RecurringInvoice,
  type RecurringInvoiceItem,
  recurringInvoiceItems,
  recurringInvoices,
} from "../db/schema";
import { existingArticleIds } from "./articles";
import { getClient } from "./clients";
import { createDocument, finalizeDocument, setPdfPath } from "./documents";
import { freezeDocumentPdf } from "./pdf";

// Recurring invoices (Serienrechnungen).
// - A recurring invoice is a template (client, items, texts, tax mode) plus a schedule. `nextRunDate` is the
//   issue date of the next invoice; it advances by the interval in the SAME transaction that creates the
//   invoice, so a run is idempotent: running twice on the same day never creates a second invoice.
// - Missed periods are caught up: one invoice per period (capped at MAX_CATCH_UP), each with the service period
//   of its run, but ALL issued today. Backdating the issue date to the missed run date would put the invoice
//   (and, with autoFinalize, its gapless number and VAT) into a period whose UVA may already be filed; an
//   invoice is issued when it is written (§ 11 UStG), the Leistungszeitraum says what it covers. Without
//   setServicePeriod a catch-up invoice records the run date as Leistungsdatum (servicePeriodStart only), so
//   the time of supply isn't lost either. The same holds for generateNow on an overdue run.
// - Generated invoices are ordinary documents created via services/documents (defaults, totals, numbering)
//   with `recurringInvoiceId` set; `autoFinalize` finalizes them right away (gapless number), otherwise
//   they stay drafts for review. A finalize error (e.g. missing UID) keeps the draft and is reported.

export type RecurringListRow = RecurringInvoice & {
  clientName: string;
  invoiceCount: number;
  lastInvoiceDate: string | null;
};

export interface GeneratedInvoiceRef {
  id: number;
  number: string | null;
  status: (typeof documents.$inferSelect)["status"];
  issueDate: string;
  dueDate: string | null;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  grossCents: number;
  paidAt: string | null;
  overdue: boolean;
}

export type RecurringDetail = RecurringInvoice & {
  clientName: string;
  items: RecurringInvoiceItem[];
  invoices: GeneratedInvoiceRef[];
};

export interface GeneratedInvoice {
  recurringInvoiceId: number;
  documentId: number;
  issueDate: string;
  finalized: boolean;
  /** set when autoFinalize failed and the invoice stayed a draft */
  error?: string;
}

const notFound = () => new HTTPException(404, { message: "Serienrechnung nicht gefunden" });
const unprocessable = (message: string) => new HTTPException(422, { message });

/** Safety net against runaway catch-up (e.g. a start date decades ago). */
const MAX_CATCH_UP = 120;

// ── Reads ───────────────────────────────────────────────────────────────────────

export function listRecurring(db: DbOrTx): RecurringListRow[] {
  const stats = db
    .select({ id: documents.recurringInvoiceId, n: count(), last: max(documents.issueDate) })
    .from(documents)
    .where(eq(documents.type, "invoice"))
    .groupBy(documents.recurringInvoiceId)
    .all();
  const byId = new Map(stats.map((s) => [s.id, s]));
  return db
    .select({ r: recurringInvoices, clientName: clients.name })
    .from(recurringInvoices)
    .innerJoin(clients, eq(clients.id, recurringInvoices.clientId))
    .orderBy(desc(recurringInvoices.active), asc(recurringInvoices.nextRunDate), asc(recurringInvoices.name))
    .all()
    .map(({ r, clientName }) => ({
      ...r,
      clientName,
      invoiceCount: byId.get(r.id)?.n ?? 0,
      lastInvoiceDate: byId.get(r.id)?.last ?? null,
    }));
}

function getRow(db: DbOrTx, id: number): RecurringInvoice {
  const row = db.select().from(recurringInvoices).where(eq(recurringInvoices.id, id)).get();
  if (!row) throw notFound();
  return row;
}

function getItems(db: DbOrTx, id: number): RecurringInvoiceItem[] {
  return db
    .select()
    .from(recurringInvoiceItems)
    .where(eq(recurringInvoiceItems.recurringInvoiceId, id))
    .orderBy(asc(recurringInvoiceItems.position))
    .all();
}

export function getRecurring(db: DbOrTx, id: number): RecurringDetail {
  const row = getRow(db, id);
  const today = todayIso();
  const invoices = db
    .select({
      id: documents.id,
      type: documents.type,
      number: documents.number,
      status: documents.status,
      issueDate: documents.issueDate,
      dueDate: documents.dueDate,
      servicePeriodStart: documents.servicePeriodStart,
      servicePeriodEnd: documents.servicePeriodEnd,
      grossCents: documents.grossCents,
      paidAt: documents.paidAt,
    })
    .from(documents)
    .where(and(eq(documents.recurringInvoiceId, id), eq(documents.type, "invoice")))
    .orderBy(desc(documents.issueDate), desc(documents.id))
    .all()
    .map(({ type, ...d }) => ({ ...d, overdue: isOverdue({ type, ...d }, today) }));
  return {
    ...row,
    clientName: getClient(db, row.clientId)?.name ?? "",
    items: getItems(db, id),
    invoices,
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────────

function cachedTotals(items: DocumentItemInput[], taxMode: RecurringInvoice["taxMode"]) {
  const t = calcTotals(items, taxMode);
  return { netCents: t.netCents, grossCents: t.grossCents };
}

function replaceItems(tx: DbOrTx, recurringInvoiceId: number, items: DocumentItemInput[]) {
  tx.delete(recurringInvoiceItems).where(eq(recurringInvoiceItems.recurringInvoiceId, recurringInvoiceId)).run();
  if (items.length) {
    // the referenced article may have been deleted meanwhile: keep the line, drop the link
    const known = existingArticleIds(tx, items.map((i) => i.articleId));
    tx.insert(recurringInvoiceItems)
      .values(
        items.map(({ articleId, ...item }, position) => ({
          ...item,
          articleId: articleId && known.has(articleId) ? articleId : null,
          recurringInvoiceId,
          position,
        })),
      )
      .run();
  }
}

function requireClient(db: DbOrTx, clientId: number) {
  if (!getClient(db, clientId)) throw unprocessable("Kunde nicht gefunden");
}

function checkDates(r: Pick<RecurringInvoice, "startDate" | "endDate" | "nextRunDate">) {
  if (r.endDate && r.endDate < r.startDate) throw unprocessable("Ende liegt vor dem Start");
  if (r.nextRunDate < r.startDate) throw unprocessable("Nächste Ausführung liegt vor dem Start");
}

export function createRecurring(db: DbOrTx, input: RecurringCreate): RecurringDetail {
  const id = db.transaction((tx) => {
    requireClient(tx, input.clientId);
    const { items, ...fields } = input;
    const values = { ...fields, nextRunDate: input.nextRunDate ?? input.startDate };
    checkDates(values);
    const row = tx
      .insert(recurringInvoices)
      .values({ ...values, ...cachedTotals(items, input.taxMode) })
      .returning({ id: recurringInvoices.id })
      .get();
    replaceItems(tx, row.id, items);
    return row.id;
  });
  return getRecurring(db, id);
}

/** Partial update; `items`, if given, replaces all items. Totals are recomputed. */
export function updateRecurring(db: DbOrTx, id: number, patch: RecurringUpdate): RecurringDetail {
  db.transaction((tx) => {
    const row = getRow(tx, id);
    if (patch.clientId !== undefined) requireClient(tx, patch.clientId);
    const { items, ...fields } = patch;
    checkDates({ ...row, ...fields });
    if (items) replaceItems(tx, id, items);
    const taxMode = fields.taxMode ?? row.taxMode;
    tx.update(recurringInvoices)
      .set({ ...fields, ...cachedTotals(items ?? getItems(tx, id), taxMode) })
      .where(eq(recurringInvoices.id, id))
      .run();
  });
  return getRecurring(db, id);
}

/**
 * Generated invoices stay; their reference is cleared explicitly (DBs migrated before the fix lack
 * ON DELETE SET NULL on documents.recurring_invoice_id).
 */
export function deleteRecurring(db: DbOrTx, id: number): void {
  db.transaction((tx) => {
    getRow(tx, id);
    tx.update(documents).set({ recurringInvoiceId: null }).where(eq(documents.recurringInvoiceId, id)).run();
    tx.delete(recurringInvoices).where(eq(recurringInvoices.id, id)).run();
  });
}

// ── Generation ──────────────────────────────────────────────────────────────────

/**
 * Create one invoice for the period starting at `runDate`, issued on `issueDate`. Runs inside `tx`.
 * A catch-up (`runDate` before `issueDate`) without a service period gets the run date as Leistungsdatum.
 */
function generateOne(tx: DbOrTx, r: RecurringInvoice, runDate: string, issueDate: string): GeneratedInvoice {
  const items = getItems(tx, r.id).map(
    ({ id: _id, recurringInvoiceId: _r, position: _p, ...item }) => item,
  );
  const period = r.setServicePeriod
    ? coveredPeriod(runDate, r.startDate, r)
    : runDate < issueDate
      ? { start: runDate, end: null }
      : null;
  const doc = createDocument(tx, {
    type: "invoice",
    clientId: r.clientId,
    issueDate,
    taxMode: r.taxMode,
    title: r.title,
    introText: r.introText,
    closingText: r.closingText,
    templateId: r.templateId,
    servicePeriodStart: period?.start ?? null,
    servicePeriodEnd: period?.end ?? null,
    items,
  });
  tx.update(documents).set({ recurringInvoiceId: r.id }).where(eq(documents.id, doc.id)).run();

  const result: GeneratedInvoice = { recurringInvoiceId: r.id, documentId: doc.id, issueDate, finalized: false };
  if (r.autoFinalize) {
    try {
      // nested transaction = savepoint: a validation error rolls back only the finalize
      finalizeDocument(tx, doc.id);
      result.finalized = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
  }
  return result;
}

/**
 * Generate every due invoice (nextRunDate <= today, within endDate) of every active recurring invoice,
 * catching up missed periods. One transaction per recurring invoice. Returns what was created.
 */
export function runDueRecurring(db: DbOrTx, today = todayIso()): GeneratedInvoice[] {
  const due = db
    .select({ id: recurringInvoices.id })
    .from(recurringInvoices)
    .where(and(eq(recurringInvoices.active, true), lte(recurringInvoices.nextRunDate, today)))
    .all();
  const out: GeneratedInvoice[] = [];
  for (const { id } of due) {
    out.push(
      ...db.transaction((tx) => {
        // re-read inside the transaction: another run may have advanced it already
        const r = getRow(tx, id);
        const created: GeneratedInvoice[] = [];
        if (!r.active || !getClient(tx, r.clientId)) return created;
        let next = r.nextRunDate;
        while (next <= today && (!r.endDate || next <= r.endDate) && created.length < MAX_CATCH_UP) {
          // issued today, never backdated to the missed run date (see top of file)
          created.push(generateOne(tx, r, next, today));
          next = nextRunAfter(next, r.startDate, r);
        }
        if (created.length) {
          tx.update(recurringInvoices)
            .set({ nextRunDate: next, lastRunAt: new Date().toISOString() })
            .where(eq(recurringInvoices.id, id))
            .run();
        }
        return created;
      }),
    );
  }
  return out;
}

/**
 * "Rechnung jetzt erstellen": invoice the next scheduled period right away and advance the schedule.
 * Issue date = today, also for an overdue run (no backdating, see top of file); early billing keeps today too.
 */
export function generateNow(db: DbOrTx, id: number, today = todayIso()): GeneratedInvoice {
  return db.transaction((tx) => {
    const r = getRow(tx, id);
    if (r.endDate && r.nextRunDate > r.endDate) throw unprocessable("Die Serienrechnung ist bereits beendet");
    if (getItems(tx, id).length === 0) throw unprocessable("Mindestens eine Position ist erforderlich");
    const created = generateOne(tx, r, r.nextRunDate, today);
    tx.update(recurringInvoices)
      .set({ nextRunDate: nextRunAfter(r.nextRunDate, r.startDate, r), lastRunAt: new Date().toISOString() })
      .where(eq(recurringInvoices.id, id))
      .run();
    return created;
  });
}

/** Freeze PDFs of finalized generated invoices (like POST /documents/:id/finalize). Never throws. */
export async function freezeGeneratedPdfs(db: DbOrTx, generated: GeneratedInvoice[]): Promise<void> {
  for (const g of generated) {
    if (!g.finalized) continue;
    try {
      const pdfPath = await freezeDocumentPdf(g.documentId);
      if (pdfPath) setPdfPath(db, g.documentId, pdfPath);
    } catch (err) {
      console.error(`freezeDocumentPdf(${g.documentId}) failed`, err);
    }
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────────

const SCHEDULER_KEY = Symbol.for("nesev.recurringScheduler");
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Generate due invoices on server start, then check hourly. Idempotent across `bun --hot` reloads. */
export function startRecurringScheduler(db: Db): void {
  const g = globalThis as { [SCHEDULER_KEY]?: Timer };
  if (g[SCHEDULER_KEY]) return;
  const run = async () => {
    try {
      const created = runDueRecurring(db);
      if (created.length) console.log(`nesev recurring: ${created.length} Rechnung(en) erstellt`);
      for (const c of created) if (c.error) console.warn(`nesev recurring: Beleg ${c.documentId} bleibt Entwurf: ${c.error}`);
      await freezeGeneratedPdfs(db, created);
    } catch (err) {
      console.error("nesev recurring run failed", err);
    }
  };
  void run();
  g[SCHEDULER_KEY] = setInterval(() => void run(), CHECK_INTERVAL_MS);
  g[SCHEDULER_KEY].unref?.();
}
