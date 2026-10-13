import { and, asc, desc, eq, inArray, lt, ne, type SQL, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { addDays, todayIso } from "../../shared/dates";
import {
  calcInterestCents,
  DEFAULT_REMINDER_SETTINGS,
  daysBetween,
  levelConfig,
  nextReminderLevel,
  type ReminderSettings,
  type ReminderStatus,
  reminderTotalCents,
} from "../../shared/reminders";
import {
  type ReminderCreate,
  type ReminderListQuery,
  type ReminderUpdate,
  reminderSettingsSchema,
} from "../../shared/schemas/reminder";
import type { DbOrTx } from "../db/client";
import { clients, type Document, documents, type Reminder, reminders, settings } from "../db/schema";
import { nextNumber } from "../lib/numbering";
import { paidCentsForDocument } from "./bank";
import { clientSnapshot, getClient } from "./clients";
import { getSettings, sellerSnapshot } from "./settings";

// Payment reminders (Mahnungen), see src/shared/reminders.ts for the rules.
// - Drafts are editable; finalize assigns MA-YYYY-NNNN (gapless, same sequence table as documents),
//   freezes client + seller snapshots and locks the reminder. The frozen PDF is rendered by the route.
// - openCents = invoice gross minus finalized credit notes and partial bank payments for it, captured when
//   the draft is created.

const notFound = () => new HTTPException(404, { message: "Mahnung nicht gefunden" });
const unprocessable = (message: string) => new HTTPException(422, { message });
const conflict = (message: string) => new HTTPException(409, { message });

// ── Settings ────────────────────────────────────────────────────────────────────

/** Level settings from settings.reminder_levels; missing or invalid JSON falls back to the defaults. */
export function getReminderSettings(db: DbOrTx): ReminderSettings {
  const parsed = reminderSettingsSchema.safeParse(getSettings(db).reminderLevels);
  return parsed.success ? parsed.data : DEFAULT_REMINDER_SETTINGS;
}

export function updateReminderSettings(db: DbOrTx, data: ReminderSettings): ReminderSettings {
  getSettings(db);
  db.update(settings).set({ reminderLevels: data }).where(eq(settings.id, 1)).run();
  return getReminderSettings(db);
}

// ── Reads ───────────────────────────────────────────────────────────────────────

export interface InvoiceRef {
  id: number;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  grossCents: number;
  status: Document["status"];
  paidAt: string | null;
}

export type ReminderListRow = Reminder & {
  invoiceNumber: string | null;
  invoiceStatus: Document["status"];
  clientId: number;
  clientName: string;
  totalCents: number;
  /** invoice paid → dunning finished */
  settled: boolean;
};

export type ReminderDetail = ReminderListRow & {
  invoice: InvoiceRef;
  /** other reminders of the same invoice (newest first) */
  siblings: { id: number; level: number; number: string | null; status: ReminderStatus; issueDate: string }[];
};

const clientNameSql = sql<string>`coalesce(json_extract(${reminders.clientSnapshot}, '$.name'), json_extract(${documents.clientSnapshot}, '$.name'), ${clients.name}, '')`;

function selectRows(db: DbOrTx, where?: SQL) {
  return db
    .select({
      reminder: reminders,
      invoiceNumber: documents.number,
      invoiceStatus: documents.status,
      clientId: documents.clientId,
      clientName: clientNameSql,
    })
    .from(reminders)
    .innerJoin(documents, eq(documents.id, reminders.invoiceId))
    .leftJoin(clients, eq(clients.id, documents.clientId))
    .where(where)
    .orderBy(desc(reminders.issueDate), desc(reminders.id))
    .all()
    .map(
      ({ reminder, ...r }): ReminderListRow => ({
        ...reminder,
        ...r,
        totalCents: reminderTotalCents(reminder),
        settled: r.invoiceStatus === "paid",
      }),
    );
}

export function listReminders(db: DbOrTx, query: ReminderListQuery = {}): ReminderListRow[] {
  const conds: SQL[] = [];
  if (query.invoiceId) conds.push(eq(reminders.invoiceId, query.invoiceId));
  if (query.status) conds.push(eq(reminders.status, query.status));
  return selectRows(db, conds.length ? and(...conds) : undefined);
}

function getRow(db: DbOrTx, id: number): Reminder {
  const row = db.select().from(reminders).where(eq(reminders.id, id)).get();
  if (!row) throw notFound();
  return row;
}

export function getReminder(db: DbOrTx, id: number): ReminderDetail {
  const row = selectRows(db, eq(reminders.id, id))[0];
  if (!row) throw notFound();
  const invoice = db.select().from(documents).where(eq(documents.id, row.invoiceId)).get()!;
  const siblings = db
    .select({
      id: reminders.id,
      level: reminders.level,
      number: reminders.number,
      status: reminders.status,
      issueDate: reminders.issueDate,
    })
    .from(reminders)
    .where(and(eq(reminders.invoiceId, row.invoiceId), ne(reminders.id, id)))
    .orderBy(desc(reminders.level), desc(reminders.id))
    .all();
  return {
    ...row,
    invoice: {
      id: invoice.id,
      number: invoice.number,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      grossCents: invoice.grossCents,
      status: invoice.status,
      paidAt: invoice.paidAt,
    },
    siblings,
  };
}

/** Invoice gross minus finalized credit notes issued for it minus bank payments allocated to it. */
export function openAmountCents(db: DbOrTx, invoice: Pick<Document, "id" | "grossCents">): number {
  const credited = db
    .select({ cents: sql<number>`coalesce(sum(${documents.grossCents}), 0)` })
    .from(documents)
    .where(and(eq(documents.parentId, invoice.id), eq(documents.type, "credit_note"), ne(documents.status, "draft")))
    .get();
  return invoice.grossCents - (credited?.cents ?? 0) - paidCentsForDocument(db, invoice.id);
}

export interface DueInvoiceRow {
  invoiceId: number;
  number: string | null;
  clientId: number;
  clientName: string;
  issueDate: string;
  dueDate: string;
  grossCents: number;
  openCents: number;
  daysOverdue: number;
  /** highest level of existing (non-draft) reminders, 0 = none */
  currentLevel: number;
  lastReminder: { id: number; number: string | null; level: number; status: ReminderStatus; dueDate: string } | null;
  /** id of an existing draft reminder */
  draftId: number | null;
  nextLevel: number;
  nextLevelTitle: string;
  /** no draft and the deadline of the last reminder (if any) has passed */
  due: boolean;
}

/** Overdue, unpaid invoices with their dunning state ("Fällig zum Mahnen"), most overdue first. */
export function listDueInvoices(db: DbOrTx, today: string = todayIso()): DueInvoiceRow[] {
  const config = getReminderSettings(db);
  const invoices = db
    .select({
      invoice: documents,
      clientName: sql<string>`coalesce(json_extract(${documents.clientSnapshot}, '$.name'), ${clients.name}, '')`,
    })
    .from(documents)
    .leftJoin(clients, eq(clients.id, documents.clientId))
    .where(
      and(
        eq(documents.type, "invoice"),
        inArray(documents.status, ["final", "sent"]),
        lt(documents.dueDate, today),
      ),
    )
    .orderBy(asc(documents.dueDate), asc(documents.id))
    .all();
  if (invoices.length === 0) return [];

  const all = db
    .select()
    .from(reminders)
    .where(inArray(reminders.invoiceId, invoices.map((r) => r.invoice.id)))
    .orderBy(asc(reminders.level), asc(reminders.id))
    .all();

  return invoices.flatMap(({ invoice, clientName }): DueInvoiceRow[] => {
    const openCents = openAmountCents(db, invoice);
    if (openCents <= 0) return [];
    const own = all.filter((r) => r.invoiceId === invoice.id);
    const issued = own.filter((r) => r.status !== "draft");
    const last = issued.at(-1) ?? null;
    const draft = own.find((r) => r.status === "draft") ?? null;
    const nextLevel = draft ? draft.level : nextReminderLevel(issued.map((r) => r.level), config.levels.length);
    return [
      {
        invoiceId: invoice.id,
        number: invoice.number,
        clientId: invoice.clientId,
        clientName,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate!,
        grossCents: invoice.grossCents,
        openCents,
        daysOverdue: daysBetween(invoice.dueDate!, today),
        currentLevel: last?.level ?? 0,
        lastReminder: last && { id: last.id, number: last.number, level: last.level, status: last.status, dueDate: last.dueDate },
        draftId: draft?.id ?? null,
        nextLevel,
        nextLevelTitle: levelConfig(config, nextLevel).title,
        due: !draft && (!last || last.dueDate < today),
      },
    ];
  });
}

// ── Writes ──────────────────────────────────────────────────────────────────────

function requireRemindableInvoice(db: DbOrTx, invoiceId: number, today: string): Document {
  const invoice = db.select().from(documents).where(eq(documents.id, invoiceId)).get();
  if (!invoice || invoice.type !== "invoice") throw unprocessable("Rechnung nicht gefunden");
  if (invoice.status === "draft") throw unprocessable("Die Rechnung ist noch nicht finalisiert");
  if (invoice.status === "paid") throw conflict(`Rechnung ${invoice.number} ist bereits bezahlt`);
  if (!invoice.dueDate || invoice.dueDate >= today) throw unprocessable(`Rechnung ${invoice.number} ist noch nicht überfällig`);
  return invoice;
}

/** New draft for an overdue invoice with level, fee, interest, deadline and texts from the level settings. */
export function createReminder(db: DbOrTx, data: ReminderCreate, today: string = todayIso()): ReminderDetail {
  const id = db.transaction((tx) => {
    const invoice = requireRemindableInvoice(tx, data.invoiceId, today);
    const existing = tx.select().from(reminders).where(eq(reminders.invoiceId, invoice.id)).all();
    const draft = existing.find((r) => r.status === "draft");
    if (draft) {
      if (data.reuseDraft) return draft.id;
      throw conflict(`Für Rechnung ${invoice.number} gibt es bereits einen Mahnungsentwurf`);
    }
    const openCents = openAmountCents(tx, invoice);
    if (openCents <= 0) throw unprocessable(`Rechnung ${invoice.number} hat keinen offenen Betrag`);

    const config = getReminderSettings(tx);
    const level = data.level ?? nextReminderLevel(existing.map((r) => r.level), config.levels.length);
    const lvl = levelConfig(config, level);
    const issueDate = data.issueDate ?? today;
    return tx
      .insert(reminders)
      .values({
        invoiceId: invoice.id,
        level,
        status: "draft",
        issueDate,
        dueDate: addDays(issueDate, lvl.days),
        openCents,
        feeCents: lvl.feeCents,
        interestCents: config.interestEnabled
          ? calcInterestCents(openCents, config.interestRateBp, invoice.dueDate!, issueDate)
          : 0,
        title: lvl.title,
        introText: lvl.introText,
        closingText: lvl.closingText,
      })
      .returning({ id: reminders.id })
      .get().id;
  });
  return getReminder(db, id);
}

/** Drafts for several invoices; invoices that can't be reminded are reported, not fatal. */
export function createReminders(db: DbOrTx, invoiceIds: number[], today: string = todayIso()) {
  const created: ReminderDetail[] = [];
  const errors: { invoiceId: number; error: string }[] = [];
  for (const invoiceId of [...new Set(invoiceIds)]) {
    try {
      created.push(createReminder(db, { invoiceId }, today));
    } catch (err) {
      errors.push({ invoiceId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { created, errors };
}

function requireDraft(r: Reminder) {
  if (r.status !== "draft") throw conflict("Finalisierte Mahnungen können nicht mehr bearbeitet werden");
}

export function updateReminder(db: DbOrTx, id: number, data: ReminderUpdate): ReminderDetail {
  const row = getRow(db, id);
  requireDraft(row);
  if (data.dueDate < data.issueDate) throw unprocessable("Die Zahlungsfrist liegt vor dem Mahndatum");
  db.update(reminders).set(data).where(eq(reminders.id, id)).run();
  return getReminder(db, id);
}

export function deleteReminder(db: DbOrTx, id: number): void {
  const row = getRow(db, id);
  if (row.status !== "draft") throw conflict("Nur Entwürfe können gelöscht werden");
  db.delete(reminders).where(eq(reminders.id, id)).run();
}

/** Assigns the number and freezes client + seller snapshots. The PDF is frozen afterwards by the route. */
export function finalizeReminder(db: DbOrTx, id: number): ReminderDetail {
  db.transaction((tx) => {
    const row = getRow(tx, id);
    requireDraft(row);
    const invoice = tx.select().from(documents).where(eq(documents.id, row.invoiceId)).get()!;
    if (invoice.status === "paid") throw conflict(`Rechnung ${invoice.number} ist bereits bezahlt`);
    const client = getClient(tx, invoice.clientId);
    const snapshot = client ? clientSnapshot(client) : invoice.clientSnapshot;
    const { number } = nextNumber(tx, "reminder", Number(row.issueDate.slice(0, 4)));
    tx.update(reminders)
      .set({
        status: "final",
        number,
        clientSnapshot: snapshot,
        sellerSnapshot: sellerSnapshot(getSettings(tx)),
        finalizedAt: new Date().toISOString(),
      })
      .where(eq(reminders.id, id))
      .run();
  });
  return getReminder(db, id);
}

export function markReminderSent(db: DbOrTx, id: number): ReminderDetail {
  const row = getRow(db, id);
  if (row.status === "draft") throw conflict("Mahnung muss zuerst finalisiert werden");
  if (row.status !== "sent") {
    db.update(reminders).set({ status: "sent", sentAt: new Date().toISOString() }).where(eq(reminders.id, id)).run();
  }
  return getReminder(db, id);
}

export function setReminderPdfPath(db: DbOrTx, id: number, pdfPath: string | null): void {
  db.update(reminders).set({ pdfPath }).where(eq(reminders.id, id)).run();
}
