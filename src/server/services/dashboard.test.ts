import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "../db/client";
import { clients, documents, type NewDocument } from "../db/schema";
import { getDashboard } from "./dashboard";
import { updateSettings } from "./settings";

const TODAY = "2026-06-15";

function setup() {
  const db = createTestDb();
  const client = db.insert(clients).values({ number: 1, name: "Muster GmbH" }).returning().get();
  let seq = 0;
  const add = (over: Partial<NewDocument> & Pick<NewDocument, "type">) =>
    db
      .insert(documents)
      .values({
        clientId: client.id,
        status: "final",
        number: over.status === "draft" ? null : `X-${++seq}`,
        issueDate: "2026-03-10",
        taxMode: "AT_DOMESTIC",
        netCents: 10000,
        taxCents: 2000,
        grossCents: 12000,
        ...over,
      })
      .returning()
      .get();
  return { db, client, add };
}

describe("getDashboard", () => {
  test("revenue subtracts credit notes and ignores drafts and offers", () => {
    const { db, add } = setup();
    add({ type: "invoice", issueDate: "2026-01-05", netCents: 100000 });
    add({ type: "invoice", status: "paid", issueDate: "2026-01-20", netCents: 50000 });
    add({ type: "invoice", status: "sent", issueDate: "2026-03-01", netCents: 30000 });
    add({ type: "credit_note", issueDate: "2026-01-25", netCents: 20000 });
    add({ type: "invoice", status: "draft", issueDate: "2026-01-10", netCents: 999999 });
    add({ type: "credit_note", status: "draft", issueDate: "2026-01-10", netCents: 999999 });
    add({ type: "offer", status: "accepted", issueDate: "2026-01-10", netCents: 999999 });

    const d = getDashboard(db, 2026, TODAY);
    expect(d.monthly).toHaveLength(12);
    expect(d.monthly[0]!.cents).toBe(130000);
    expect(d.monthly[2]!.cents).toBe(30000);
    expect(d.kpis.revenue.cents).toBe(160000);
  });

  test("year boundaries bucket by issueDate; previous year is returned for comparison", () => {
    const { db, add } = setup();
    add({ type: "invoice", issueDate: "2025-12-31", netCents: 7000 });
    add({ type: "invoice", issueDate: "2026-01-01", netCents: 11000 });
    add({ type: "invoice", issueDate: "2026-12-31", netCents: 13000 });
    add({ type: "invoice", issueDate: "2027-01-01", netCents: 17000 });
    add({ type: "invoice", issueDate: "2024-12-31", netCents: 19000 });

    const d = getDashboard(db, 2026, TODAY);
    expect(d.kpis.revenue).toEqual({ cents: 24000, previousCents: 7000 });
    expect(d.monthly[0]).toEqual({ month: 0, cents: 11000, previousCents: 0 });
    expect(d.monthly[11]).toEqual({ month: 11, cents: 13000, previousCents: 7000 });
    expect(d.years).toEqual([2027, 2026, 2025, 2024]);
  });

  test("open and overdue invoices", () => {
    const { db, add } = setup();
    const old = add({ type: "invoice", status: "sent", dueDate: "2026-05-01", grossCents: 1000 });
    const older = add({ type: "invoice", status: "final", dueDate: "2026-04-01", grossCents: 2000 });
    add({ type: "invoice", status: "final", dueDate: TODAY, grossCents: 4000 }); // due today: not overdue
    add({ type: "invoice", status: "sent", dueDate: null, grossCents: 8000 }); // no due date: not overdue
    add({ type: "invoice", status: "paid", dueDate: "2026-01-01", paidAt: "2026-02-01", grossCents: 16000 });
    add({ type: "invoice", status: "draft", dueDate: "2026-01-01", grossCents: 32000 });

    const d = getDashboard(db, 2026, TODAY);
    expect(d.kpis.openInvoices).toEqual({ count: 4, cents: 15000 });
    expect(d.kpis.overdue).toEqual({ count: 2, cents: 3000 });
    expect(d.overdue.map((r) => r.id)).toEqual([older.id, old.id]);
    expect(d.overdue[0]!.daysOverdue).toBe(75);
    expect(d.overdue[0]!.clientName).toBe("Muster GmbH");
  });

  test("paid in year uses paidAt, gross", () => {
    const { db, add } = setup();
    add({ type: "invoice", status: "paid", issueDate: "2025-12-01", paidAt: "2026-01-03", grossCents: 5000 });
    add({ type: "invoice", status: "paid", issueDate: "2026-12-01", paidAt: "2027-01-03", grossCents: 7000 });
    add({ type: "invoice", status: "paid", issueDate: "2026-02-01", paidAt: "2026-02-10", grossCents: 9000 });

    expect(getDashboard(db, 2026, TODAY).kpis.paid).toEqual({ count: 2, cents: 14000 });
  });

  test("open offers are final/sent only, soonest expiry first", () => {
    const { db, add } = setup();
    const a = add({ type: "offer", status: "sent", validUntil: "2026-07-01", grossCents: 100 });
    const b = add({ type: "offer", status: "final", validUntil: "2026-06-20", grossCents: 200 });
    add({ type: "offer", status: "accepted", grossCents: 400 });
    add({ type: "offer", status: "declined", grossCents: 800 });
    add({ type: "offer", status: "draft", grossCents: 1600 });

    const d = getDashboard(db, 2026, TODAY);
    expect(d.kpis.openOffers).toEqual({ count: 2, cents: 300 });
    expect(d.openOffers.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  test("client name prefers the finalized snapshot", () => {
    const { db, add, client } = setup();
    add({
      type: "invoice",
      clientSnapshot: { name: "Alter Name GmbH" } as NewDocument["clientSnapshot"],
    });
    db.update(clients).set({ name: "Neuer Name GmbH" }).where(eq(clients.id, client.id)).run();
    add({ type: "invoice", status: "draft" });
    const names = getDashboard(db, 2026, TODAY).recent.map((r) => r.clientName).sort();
    expect(names).toEqual(["Alter Name GmbH", "Neuer Name GmbH"]);
  });

  test("setup flags for a fresh install", () => {
    const db = createTestDb();
    const d = getDashboard(db, 2026, TODAY);
    expect(d.setup).toEqual({ hasClients: false, hasDocuments: false, companyMissing: true });
    expect(d.kpis.revenue.cents).toBe(0);
    expect(d.years).toEqual([2026]);

    updateSettings(db, { companyName: "Firma", street: "Gasse 1", city: "Wien" });
    expect(getDashboard(db, 2026, TODAY).setup.companyMissing).toBe(false);
  });
});
