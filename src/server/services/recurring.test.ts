import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { addMonthsAnchored, coveredPeriod, nextRunAfter, runDatesUntil } from "../../shared/recurring";
import type { RecurringCreate } from "../../shared/schemas/recurring";
import { createTestDb, type Db } from "../db/client";
import { articles, clients, documentItems, documents, type NewClient } from "../db/schema";
import { updateSettings } from "./settings";
import {
  createRecurring,
  deleteRecurring,
  generateNow,
  getRecurring,
  listRecurring,
  runDueRecurring,
  updateRecurring,
} from "./recurring";
import { seedSeller } from "./test-seller";

let clientNo = 0;
function addClient(db: Db, over: Partial<NewClient> = {}) {
  return db
    .insert(clients)
    .values({ number: ++clientNo, name: "Alpen AG", country: "AT", ...over })
    .returning()
    .get();
}

function input(clientId: number, over: Partial<RecurringCreate> = {}): RecurringCreate {
  return {
    name: "Hosting",
    clientId,
    active: true,
    intervalUnit: "month",
    intervalCount: 1,
    startDate: "2026-01-31",
    endDate: null,
    setServicePeriod: true,
    autoFinalize: false,
    taxMode: "AT_DOMESTIC",
    title: "Hosting",
    introText: "",
    closingText: "",
    templateId: null,
    items: [
      { title: "Webhosting", description: "", quantity: 1000, unit: "Mon.", unitPriceCents: 5000, taxRateBp: 2000, discountBp: 0 },
    ],
    ...over,
  };
}

function setup() {
  const db = createTestDb();
  seedSeller(db);
  updateSettings(db, { paymentTermsDays: 14 });
  const client = addClient(db);
  return { db, client };
}

const invoicesOf = (db: Db, recurringId: number) =>
  db.select().from(documents).where(eq(documents.recurringInvoiceId, recurringId)).all();

describe("interval math", () => {
  test("month-end safe, keeps the start date's day as anchor", () => {
    const start = "2026-01-31";
    const m = { intervalUnit: "month" as const, intervalCount: 1 };
    expect(nextRunAfter("2026-01-31", start, m)).toBe("2026-02-28");
    expect(nextRunAfter("2026-02-28", start, m)).toBe("2026-03-31");
    expect(nextRunAfter("2026-03-31", start, m)).toBe("2026-04-30");
    expect(nextRunAfter("2028-01-31", "2028-01-31", m)).toBe("2028-02-29"); // leap year
    expect(addMonthsAnchored("2026-12-15", 1)).toBe("2027-01-15");
  });

  test("every 3 months and yearly", () => {
    const q = { intervalUnit: "month" as const, intervalCount: 3 };
    expect(runDatesUntil({ ...q, startDate: "2026-11-30", endDate: null }, "2026-11-30", "2027-12-31")).toEqual([
      "2026-11-30",
      "2027-02-28",
      "2027-05-30",
      "2027-08-30",
      "2027-11-30",
    ]);
    const y = { intervalUnit: "year" as const, intervalCount: 1 };
    expect(nextRunAfter("2028-02-29", "2028-02-29", y)).toBe("2029-02-28");
    expect(nextRunAfter("2029-02-28", "2028-02-29", y)).toBe("2030-02-28");
  });

  test("covered service period ends the day before the next run", () => {
    const m = { intervalUnit: "month" as const, intervalCount: 1 };
    expect(coveredPeriod("2026-01-31", "2026-01-31", m)).toEqual({ start: "2026-01-31", end: "2026-02-27" });
    expect(coveredPeriod("2026-03-01", "2026-03-01", m)).toEqual({ start: "2026-03-01", end: "2026-03-31" });
  });

  test("runDatesUntil respects endDate", () => {
    const r = { intervalUnit: "month" as const, intervalCount: 1, startDate: "2026-01-15", endDate: "2026-03-20" };
    expect(runDatesUntil(r, "2026-01-15", "2026-12-31")).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
  });
});

describe("CRUD", () => {
  test("create caches totals and defaults nextRunDate to startDate", () => {
    const { db, client } = setup();
    const r = createRecurring(db, input(client.id));
    expect(r.nextRunDate).toBe("2026-01-31");
    expect(r.netCents).toBe(5000);
    expect(r.grossCents).toBe(6000);
    expect(r.items).toHaveLength(1);
    const updated = updateRecurring(db, r.id, { active: false });
    expect(updated.active).toBe(false);
    expect(updated.items).toHaveLength(1);
    expect(listRecurring(db)[0]!.clientName).toBe("Alpen AG");
  });

  test("rejects end before start", () => {
    const { db, client } = setup();
    const r = createRecurring(db, input(client.id));
    expect(() => updateRecurring(db, r.id, { endDate: "2025-01-01" })).toThrow("Ende liegt vor dem Start");
  });
});

describe("generation", () => {
  test("catches up one invoice per missed period: issued today (never backdated), service period of the run", () => {
    const { db, client } = setup();
    const r = createRecurring(db, input(client.id));
    const created = runDueRecurring(db, "2026-04-10");
    expect(created.map((c) => c.issueDate)).toEqual(["2026-04-10", "2026-04-10", "2026-04-10"]);

    const docs = invoicesOf(db, r.id).sort((a, b) => a.id - b.id);
    expect(docs).toHaveLength(3);
    expect(docs.map((d) => d.issueDate)).toEqual(["2026-04-10", "2026-04-10", "2026-04-10"]);
    expect(docs.map((d) => d.servicePeriodStart)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(docs[1]!.status).toBe("draft");
    expect(docs[1]!.servicePeriodEnd).toBe("2026-03-30");
    expect(docs[1]!.dueDate).toBe("2026-04-24");
    expect(docs[1]!.grossCents).toBe(6000);

    const after = getRecurring(db, r.id);
    expect(after.nextRunDate).toBe("2026-04-30");
    expect(after.lastRunAt).not.toBeNull();
    expect(after.invoices).toHaveLength(3);
  });

  test("is idempotent", () => {
    const { db, client } = setup();
    const r = createRecurring(db, input(client.id));
    runDueRecurring(db, "2026-02-01");
    expect(runDueRecurring(db, "2026-02-01")).toEqual([]);
    expect(invoicesOf(db, r.id)).toHaveLength(1);
  });

  test("stops at endDate and skips inactive", () => {
    const { db, client } = setup();
    const ended = createRecurring(db, input(client.id, { endDate: "2026-02-28" }));
    const inactive = createRecurring(db, input(client.id, { active: false }));
    runDueRecurring(db, "2026-06-30");
    expect(invoicesOf(db, ended.id)).toHaveLength(2);
    expect(invoicesOf(db, inactive.id)).toHaveLength(0);
    expect(runDueRecurring(db, "2026-12-31")).toEqual([]);
  });

  test("autoFinalize assigns numbers; finalize errors keep the draft", () => {
    const { db, client } = setup();
    const r = createRecurring(db, input(client.id, { autoFinalize: true, setServicePeriod: false }));
    const created = runDueRecurring(db, "2026-02-28");
    expect(created.every((c) => c.finalized)).toBe(true);
    const docs = invoicesOf(db, r.id).sort((a, b) => a.id - b.id);
    expect(docs.map((d) => d.number)).toEqual(["RE-2026-0001", "RE-2026-0002"]);
    expect(docs.map((d) => d.issueDate)).toEqual(["2026-02-28", "2026-02-28"]);
    // without a service period: the missed January run keeps its date as Leistungsdatum, the due run needs none
    expect(docs.map((d) => [d.servicePeriodStart, d.servicePeriodEnd])).toEqual([["2026-01-31", null], [null, null]]);

    const de = addClient(db, { country: "DE", uid: "" });
    const rc = createRecurring(db, input(de.id, { autoFinalize: true, taxMode: "EU_REVERSE_CHARGE" }));
    const failed = runDueRecurring(db, "2026-01-31").filter((c) => c.recurringInvoiceId === rc.id);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.finalized).toBe(false);
    expect(failed[0]!.error).toContain("UID");
    expect(invoicesOf(db, rc.id)[0]!.status).toBe("draft");
    expect(getRecurring(db, rc.id).nextRunDate).toBe("2026-02-28");
  });

  test("generateNow bills the next period early and advances", () => {
    const { db, client } = setup();
    const r = createRecurring(db, input(client.id, { startDate: "2026-05-01" }));
    const g = generateNow(db, r.id, "2026-04-20");
    expect(g.issueDate).toBe("2026-04-20");
    const doc = invoicesOf(db, r.id)[0]!;
    expect(doc.servicePeriodStart).toBe("2026-05-01");
    expect(doc.servicePeriodEnd).toBe("2026-05-31");
    expect(getRecurring(db, r.id).nextRunDate).toBe("2026-06-01");
    expect(runDueRecurring(db, "2026-05-15")).toEqual([]);

    // an overdue run billed by hand is issued today as well, with its own service period
    const late = generateNow(db, r.id, "2026-07-03");
    expect(late.issueDate).toBe("2026-07-03");
    const lateDoc = invoicesOf(db, r.id).find((d) => d.id === late.documentId)!;
    expect([lateDoc.servicePeriodStart, lateDoc.servicePeriodEnd]).toEqual(["2026-06-01", "2026-06-30"]);
  });

  test("articleId is stored on items and copied to generated invoices; deleted articles drop the link", () => {
    const { db, client } = setup();
    const art = db.insert(articles).values({ number: 1, title: "Webhosting" }).returning().get();
    const base = input(client.id).items[0]!;
    const r = createRecurring(db, input(client.id, { items: [{ ...base, articleId: art.id }, { ...base, title: "Alt", articleId: 9999 }] }));
    expect(r.items.map((i) => i.articleId)).toEqual([art.id, null]);
    const [g] = runDueRecurring(db, "2026-01-31");
    const lines = db.select().from(documentItems).where(eq(documentItems.documentId, g!.documentId)).all();
    expect(lines.map((l) => l.articleId).sort()).toEqual([art.id, null].sort());
  });
});

describe("delete", () => {
  test("keeps generated invoices and clears their reference", () => {
    const { db, client } = setup();
    const r = createRecurring(db, input(client.id, { autoFinalize: true }));
    const created = runDueRecurring(db, "2026-02-28");
    deleteRecurring(db, r.id);
    expect(() => getRecurring(db, r.id)).toThrow("Serienrechnung nicht gefunden");
    const docs = db.select().from(documents).all();
    expect(docs.map((d) => d.id).sort()).toEqual(created.map((c) => c.documentId).sort());
    expect(docs.every((d) => d.recurringInvoiceId === null && d.status === "final")).toBe(true);
  });
});
