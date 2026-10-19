import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "@pdfme/pdf-lib";
import { HTTPException } from "hono/http-exception";
import {
  calcInterestCents,
  DEFAULT_REMINDER_SETTINGS,
  daysBetween,
  fillPlaceholders,
  nextReminderLevel,
} from "../../shared/reminders";
import { createTestDb, type Db } from "../db/client";
import { clients } from "../db/schema";
import { mapReminderToPdfInput } from "../lib/pdf/reminder-mapper";
import { changeStatus, createCreditNote, createDocument, finalizeDocument } from "./documents";
import { buildSampleInput, ensureDefaultTemplates, freezeReminderPdfWith, getDefaultTemplate, renderReminderPdfWith } from "./pdf";
import {
  createReminder,
  createReminders,
  deleteReminder,
  finalizeReminder,
  getReminderSettings,
  listDueInvoices,
  listReminders,
  markReminderSent,
  updateReminder,
  updateReminderSettings,
} from "./reminders";
import { updateSettings } from "./settings";
import { seedSeller } from "./test-seller";

const TODAY = "2026-10-14";

function setup() {
  const db = createTestDb();
  seedSeller(db);
  updateSettings(db, { companyName: "Muster GmbH", iban: "AT611904300234573201", bic: "BKAUATWW" });
  const client = db.insert(clients).values({ number: 1, name: "Beispiel AG", country: "AT" }).returning().get();
  return { db, client };
}

/** Finalized invoice over € 240,00 gross (2 h × € 100 + 20 %), due on `dueDate`. */
function invoice(db: Db, clientId: number, dueDate = "2026-09-30") {
  const doc = createDocument(db, {
    type: "invoice",
    clientId,
    issueDate: "2026-09-16",
    dueDate,
    items: [{ title: "Beratung", description: "", quantity: 2000, unit: "h", unitPriceCents: 10000, taxRateBp: 2000, discountBp: 0 }],
  });
  return finalizeDocument(db, doc.id);
}

function expectHttp(fn: () => unknown, status: number, message?: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status as number).toBe(status);
    if (message) expect((err as HTTPException).message).toContain(message);
    return;
  }
  throw new Error(`expected HTTP ${status}`);
}

describe("shared rules", () => {
  test("next level = highest + 1, capped at the last level", () => {
    expect(nextReminderLevel([], 3)).toBe(1);
    expect(nextReminderLevel([1], 3)).toBe(2);
    expect(nextReminderLevel([2, 1], 3)).toBe(3);
    expect(nextReminderLevel([3], 3)).toBe(3);
    expect(nextReminderLevel([5], 3)).toBe(3);
  });

  test("interest: simple act/365 from the due date, rounded", () => {
    expect(daysBetween("2026-09-30", "2026-10-14")).toBe(14);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2); // across DST
    // 1.000,00 € × 11,2 % × 14/365 = 4,2958… → 4,30 €
    expect(calcInterestCents(100000, 1120, "2026-09-30", "2026-10-14")).toBe(430);
    expect(calcInterestCents(100000, 1120, "2026-10-14", "2026-10-14")).toBe(0);
    expect(calcInterestCents(100000, 0, "2026-09-30", "2026-10-14")).toBe(0);
  });

  test("placeholders", () => {
    expect(fillPlaceholders("{invoiceNumber} bis {dueDate} {unknown}", { invoiceNumber: "RE-1", dueDate: "1.1." })).toBe(
      "RE-1 bis 1.1. {unknown}",
    );
  });
});

describe("settings", () => {
  test("defaults when unset or invalid, round trip", () => {
    const { db } = setup();
    expect(getReminderSettings(db)).toEqual(DEFAULT_REMINDER_SETTINGS);
    updateSettings(db, { reminderLevels: { levels: "nope" } } as never);
    expect(getReminderSettings(db)).toEqual(DEFAULT_REMINDER_SETTINGS);
    const custom = { ...DEFAULT_REMINDER_SETTINGS, levels: DEFAULT_REMINDER_SETTINGS.levels.slice(0, 2), interestEnabled: true };
    expect(updateReminderSettings(db, custom)).toEqual(custom);
  });
});

describe("reminders", () => {
  test("finalize refuses without the seller's address", () => {
    const { db, client } = setup();
    const r = createReminder(db, { invoiceId: invoice(db, client.id).id }, TODAY);
    updateSettings(db, { street: "" });
    expectHttp(() => finalizeReminder(db, r.id), 422, "Unternehmensdaten fehlen: Straße.");
  });

  test("level progression, fees and deadlines from the level settings", () => {
    const { db, client } = setup();
    const inv = invoice(db, client.id);

    const r1 = createReminder(db, { invoiceId: inv.id }, TODAY);
    expect(r1).toMatchObject({ level: 1, status: "draft", number: null, openCents: 24000, feeCents: 0, interestCents: 0 });
    expect(r1).toMatchObject({ issueDate: TODAY, dueDate: "2026-10-21", title: "Zahlungserinnerung", totalCents: 24000 });

    // only one draft per invoice
    expectHttp(() => createReminder(db, { invoiceId: inv.id }, TODAY), 409, "Mahnungsentwurf");
    expect(createReminder(db, { invoiceId: inv.id, reuseDraft: true }, TODAY).id).toBe(r1.id);

    finalizeReminder(db, r1.id);
    const r2 = createReminder(db, { invoiceId: inv.id }, TODAY);
    expect(r2).toMatchObject({ level: 2, feeCents: 1000, title: "1. Mahnung", totalCents: 25000 });
    finalizeReminder(db, r2.id);
    const r3 = createReminder(db, { invoiceId: inv.id }, TODAY);
    expect(r3).toMatchObject({ level: 3, feeCents: 2000 });
    finalizeReminder(db, r3.id);
    // capped: the last level repeats
    expect(createReminder(db, { invoiceId: inv.id }, TODAY).level).toBe(3);
  });

  test("interest when enabled; open amount net of credit notes", () => {
    const { db, client } = setup();
    updateReminderSettings(db, { ...DEFAULT_REMINDER_SETTINGS, interestEnabled: true, interestRateBp: 1000 });
    const inv = invoice(db, client.id, "2026-09-14"); // 30 days before TODAY
    const r = createReminder(db, { invoiceId: inv.id }, TODAY);
    // 240,00 € × 10 % × 30/365 = 1,97 €
    expect(r.interestCents).toBe(197);

    const inv2 = invoice(db, client.id);
    const cn = createCreditNote(db, inv2.id);
    finalizeDocument(db, cn.id);
    // a full credit note settles the invoice
    expectHttp(() => createReminder(db, { invoiceId: inv2.id }, TODAY), 409, "bereits bezahlt");
  });

  test("only overdue, finalized, unpaid invoices can be reminded", () => {
    const { db, client } = setup();
    const notDue = invoice(db, client.id, TODAY);
    expectHttp(() => createReminder(db, { invoiceId: notDue.id }, TODAY), 422, "nicht überfällig");

    const draft = createDocument(db, { type: "invoice", clientId: client.id, dueDate: "2026-01-01" });
    expectHttp(() => createReminder(db, { invoiceId: draft.id }, TODAY), 422, "nicht finalisiert");

    const paid = invoice(db, client.id);
    changeStatus(db, paid.id, { action: "paid", paidAt: TODAY });
    expectHttp(() => createReminder(db, { invoiceId: paid.id }, TODAY), 409, "bereits bezahlt");
  });

  test("paying the invoice settles the dunning and blocks finalizing drafts", () => {
    const { db, client } = setup();
    const inv = invoice(db, client.id);
    const r1 = finalizeReminder(db, createReminder(db, { invoiceId: inv.id }, TODAY).id);
    const draft = createReminder(db, { invoiceId: inv.id }, TODAY);
    changeStatus(db, inv.id, { action: "paid", paidAt: TODAY });

    expectHttp(() => finalizeReminder(db, draft.id), 409, "bereits bezahlt");
    const rows = listReminders(db, { invoiceId: inv.id });
    expect(rows.map((r) => r.settled)).toEqual([true, true]);
    expect(rows.find((r) => r.id === r1.id)?.invoiceStatus).toBe("paid");
    expect(listDueInvoices(db, TODAY)).toEqual([]);
  });

  test("finalize assigns gapless MA numbers and snapshots; finalized reminders are locked", () => {
    const { db, client } = setup();
    const a = createReminder(db, { invoiceId: invoice(db, client.id).id }, TODAY);
    const b = createReminder(db, { invoiceId: invoice(db, client.id).id }, TODAY);
    const fb = finalizeReminder(db, b.id);
    const fa = finalizeReminder(db, a.id);
    expect(fb.number).toBe("MA-2026-0001");
    expect(fa.number).toBe("MA-2026-0002");
    expect(fa.clientSnapshot?.name).toBe("Beispiel AG");
    expect(fa.sellerSnapshot?.companyName).toBe("Muster GmbH");
    expect(fa.finalizedAt).toBeTruthy();

    expectHttp(() => finalizeReminder(db, a.id), 409);
    expectHttp(() => deleteReminder(db, a.id), 409);
    expectHttp(
      () =>
        updateReminder(db, a.id, {
          level: 1, issueDate: TODAY, dueDate: TODAY, feeCents: 0, interestCents: 0,
          title: "", introText: "", closingText: "", templateId: null,
        }),
      409,
    );
    expect(markReminderSent(db, a.id)).toMatchObject({ status: "sent" });
    expect(markReminderSent(db, a.id).sentAt).toBeTruthy();
  });

  test("drafts are editable and deletable", () => {
    const { db, client } = setup();
    const r = createReminder(db, { invoiceId: invoice(db, client.id).id }, TODAY);
    const updated = updateReminder(db, r.id, {
      level: 2, issueDate: TODAY, dueDate: "2026-10-30", feeCents: 1500, interestCents: 120,
      title: "Mahnung", introText: "Hallo", closingText: "", templateId: null,
    });
    expect(updated).toMatchObject({ level: 2, feeCents: 1500, interestCents: 120, totalCents: 24000 + 1620 });
    expectHttp(() => updateReminder(db, r.id, { ...updated, dueDate: "2026-10-01" }), 422);
    deleteReminder(db, r.id);
    expect(listReminders(db)).toEqual([]);
  });

  test("due list: dunning state per overdue invoice; bulk create", () => {
    const { db, client } = setup();
    const a = invoice(db, client.id, "2026-09-30");
    const b = invoice(db, client.id, "2026-10-10");
    invoice(db, client.id, "2026-10-20"); // not overdue

    let due = listDueInvoices(db, TODAY);
    expect(due.map((d) => d.invoiceId)).toEqual([a.id, b.id]);
    expect(due[0]).toMatchObject({ daysOverdue: 14, currentLevel: 0, nextLevel: 1, due: true, draftId: null });

    const res = createReminders(db, [a.id, b.id, 999], TODAY);
    expect(res.created).toHaveLength(2);
    expect(res.errors).toEqual([{ invoiceId: 999, error: "Rechnung nicht gefunden" }]);

    due = listDueInvoices(db, TODAY);
    expect(due[0]).toMatchObject({ due: false, draftId: res.created[0]!.id, nextLevel: 1 });
    finalizeReminder(db, res.created[0]!.id);
    due = listDueInvoices(db, TODAY);
    // reminder deadline (21.10.) not yet passed
    expect(due[0]).toMatchObject({ currentLevel: 1, nextLevel: 2, due: false, draftId: null });
    expect(listDueInvoices(db, "2026-10-22")[0]).toMatchObject({ due: true, nextLevelTitle: "1. Mahnung" });
  });
});

describe("reminder PDF", () => {
  test("mapper: amounts, placeholders, GiroCode with fee, tax note", () => {
    const input = mapReminderToPdfInput({
      reminder: {
        level: 2,
        number: "MA-2026-0001",
        issueDate: TODAY,
        dueDate: "2026-10-21",
        openCents: 24000,
        feeCents: 1000,
        interestCents: 0,
        title: "1. Mahnung",
        introText: "Rechnung {invoiceNumber} ist seit {daysOverdue} Tagen fällig.",
        closingText: "Bitte {total} bis {dueDate}.",
      },
      invoice: { number: "RE-2026-0001", issueDate: "2026-09-16", dueDate: "2026-09-30", grossCents: 24000 },
      client: {
        clientId: 1, number: 1, type: "company", name: "Beispiel AG", contactPerson: "", street: "", addressExtra: "",
        zip: "", city: "", country: "AT", uid: "", email: "",
      },
      seller: {
        companyName: "Muster GmbH", ownerName: "", street: "", zip: "", city: "", country: "AT", uid: "", taxNumber: "",
        companyRegister: "", email: "", phone: "", website: "", iban: "AT611904300234573201", bic: "", bankName: "",
        logoPath: null,
      },
      taxNotes: { taxNoteReverseCharge: "", taxNoteThirdCountry: "", taxNoteSmallBusiness: "" },
    });
    const n = (s: string | undefined) => s!.replaceAll(" ", " ");
    expect(input.heading).toBe("1. Mahnung MA-2026-0001");
    expect(input.introText).toBe("Rechnung RE-2026-0001 ist seit 14 Tagen fällig.");
    expect(n(input.closingText)).toBe("Bitte € 250,00 bis 21.10.2026.");
    expect(n(input.grossTotal)).toBe("€ 250,00");
    expect(JSON.parse(n(input.totals))).toEqual([
      ["Offener Rechnungsbetrag", "€ 240,00"],
      ["Mahnspesen", "€ 10,00"],
    ]);
    expect(input.epcQr).toContain("EUR250.00");
    expect(input.epcQr!.endsWith("RE-2026-0001")).toBe(true);
    expect(input.taxNote).toContain("nicht umsatzsteuerbar");
    expect(JSON.parse(input.reminderItems!)[0][0]).toBe("RE-2026-0001");
  });

  test("default reminder template exists and renders draft + frozen PDFs", async () => {
    const { db, client } = setup();
    ensureDefaultTemplates(db);
    expect(getDefaultTemplate(db, "reminder").name).toBe("Standard – Mahnung");

    const r = createReminder(db, { invoiceId: invoice(db, client.id).id }, TODAY);
    const draft = await renderReminderPdfWith(db, r.id);
    expect((await PDFDocument.load(draft)).getPageCount()).toBe(1);

    finalizeReminder(db, r.id);
    const dir = mkdtempSync(join(tmpdir(), "nesev-reminder-"));
    const path = await freezeReminderPdfWith(db, r.id, dir);
    expect(path).toBe("pdfs/MA-2026-0001.pdf");
    expect(await Bun.file(join(dir, "MA-2026-0001.pdf")).exists()).toBe(true);

    const sample = await buildSampleInput(db, "reminder");
    expect(sample.reminderItems).toBeTruthy();
  });
});
