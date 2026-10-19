import { describe, expect, test } from "bun:test";
import { smallBusinessLevel } from "../../shared/small-business";
import { createTestDb } from "../db/client";
import { bankAccounts, bankMatches, bankTransactions, clients, documents, type NewDocument, recurringInvoices } from "../db/schema";
import { getDashboard } from "./dashboard";
import { getSmallBusinessLimit } from "./small-business";
import { updateSettings } from "./settings";

const TODAY = "2026-06-15";

function setup() {
  const db = createTestDb();
  const client = db.insert(clients).values({ number: 1, name: "Muster GmbH" }).returning().get();
  let seq = 0;
  const add = (over: Partial<NewDocument> & Pick<NewDocument, "type" | "grossCents">) =>
    db
      .insert(documents)
      .values({
        clientId: client.id,
        status: "final",
        number: over.status === "draft" ? null : `X-${++seq}`,
        issueDate: "2026-03-10",
        taxMode: "SMALL_BUSINESS",
        netCents: over.grossCents,
        taxCents: 0,
        ...over,
      })
      .returning()
      .get();
  return { db, client, add };
}

describe("smallBusinessLevel", () => {
  test("80 % warning, 10 % tolerance, exceeded above € 60.500", () => {
    expect(smallBusinessLevel(4_399_999)).toBe("ok");
    expect(smallBusinessLevel(4_400_000)).toBe("warn");
    expect(smallBusinessLevel(5_500_000)).toBe("warn");
    expect(smallBusinessLevel(5_500_001)).toBe("tolerance");
    expect(smallBusinessLevel(6_050_000)).toBe("tolerance");
    expect(smallBusinessLevel(6_050_001)).toBe("exceeded");
  });
});

describe("getSmallBusinessLimit", () => {
  test("gross turnover of the year minus credit notes; drafts, offers and other years don't count", () => {
    const { db, add } = setup();
    add({ type: "invoice", grossCents: 3_000_000, issueDate: "2026-01-10" });
    add({ type: "invoice", status: "paid", grossCents: 1_000_000, issueDate: "2026-02-10" });
    add({ type: "credit_note", grossCents: 500_000, issueDate: "2026-02-20" });
    add({ type: "invoice", status: "draft", grossCents: 200_000, issueDate: "2026-07-01" });
    add({ type: "offer", grossCents: 9_000_000 });
    add({ type: "invoice", grossCents: 2_000_000, issueDate: "2025-12-31" });

    const l = getSmallBusinessLimit(db, 2026, TODAY);
    expect(l.turnoverCents).toBe(3_500_000);
    expect(l.level).toBe("ok");
    expect(l.previousYearCents).toBe(2_000_000);
    expect(l.previousYearExceeded).toBe(false);
    expect(l.exceededOn).toBeNull();
    expect(l.projectedCents).toBe(3_700_000); // + draft invoice
  });

  test("projection adds the remaining runs of active recurring invoices until 31.12.", () => {
    const { db, client, add } = setup();
    add({ type: "invoice", grossCents: 4_000_000 });
    const rec = (over: Partial<typeof recurringInvoices.$inferInsert>) =>
      db
        .insert(recurringInvoices)
        .values({ clientId: client.id, name: "Wartung", startDate: "2026-01-01", nextRunDate: "2026-07-01", taxMode: "SMALL_BUSINESS", netCents: 300_000, grossCents: 300_000, ...over })
        .run();
    rec({}); // Jul–Dec: 6 runs
    rec({ active: false });
    rec({ intervalCount: 3, nextRunDate: "2026-10-01", grossCents: 100_000 }); // Oct only

    const l = getSmallBusinessLimit(db, 2026, TODAY);
    expect(l.projectedCents).toBe(4_000_000 + 6 * 300_000 + 100_000);
    expect(l.level).toBe("ok");
    expect(l.projectedLevel).toBe("tolerance"); // € 59.000
    // past years get no projection
    expect(getSmallBusinessLimit(db, 2025, TODAY).projectedCents).toBe(0);
  });

  test("tolerance and the date the exemption ended", () => {
    const { db, add } = setup();
    add({ type: "invoice", grossCents: 5_800_000, issueDate: "2026-04-01" });
    expect(getSmallBusinessLimit(db, 2026, TODAY).level).toBe("tolerance");
    add({ type: "invoice", grossCents: 400_000, issueDate: "2026-05-02" });
    add({ type: "invoice", grossCents: 100_000, issueDate: "2026-05-20" });
    const l = getSmallBusinessLimit(db, 2026, TODAY);
    expect(l.level).toBe("exceeded");
    expect(l.exceededOn).toBe("2026-05-02");
    expect(getSmallBusinessLimit(db, 2027, "2027-01-10").previousYearExceeded).toBe(true);
  });

  test("counts by service date (period end → start → invoice date), whatever the VAT basis", () => {
    const { db, add } = setup();
    updateSettings(db, { vatBasis: "cash" });
    // December 2025 service, invoiced in January 2026 → 2025
    add({ type: "invoice", grossCents: 1_000_000, issueDate: "2026-01-05", servicePeriodStart: "2025-12-01", servicePeriodEnd: "2025-12-31" });
    // only a start date → that date
    add({ type: "invoice", grossCents: 200_000, issueDate: "2027-01-03", servicePeriodStart: "2026-12-20" });
    // no service date → invoice date
    add({ type: "invoice", grossCents: 300_000, issueDate: "2026-04-01" });
    // a credit note counts by its own date, even if its invoice belongs to 2025
    add({ type: "credit_note", grossCents: 100_000, issueDate: "2026-02-01", servicePeriodEnd: "2025-12-31" });

    const l = getSmallBusinessLimit(db, 2026, TODAY);
    expect(l.turnoverCents).toBe(200_000 + 300_000 - 100_000);
    expect(l.previousYearCents).toBe(1_000_000);
  });

  test("received: invoices marked paid in full, others by their bank allocations", () => {
    const { db, add } = setup();
    const paid = add({ type: "invoice", status: "paid", grossCents: 500_000, issueDate: "2026-02-01" });
    add({ type: "credit_note", parentId: paid.id, grossCents: 50_000, issueDate: "2026-02-10" });
    const partly = add({ type: "invoice", grossCents: 400_000, issueDate: "2026-03-01" });
    add({ type: "invoice", grossCents: 300_000, issueDate: "2026-04-01" }); // unpaid
    const account = db.insert(bankAccounts).values({ name: "Giro" }).returning().get();
    const tx = db
      .insert(bankTransactions)
      .values({ accountId: account.id, bookingDate: "2026-03-20", amountCents: 150_000, importHash: "h1" })
      .returning()
      .get();
    db.insert(bankMatches).values({ transactionId: tx.id, documentId: partly.id, amountCents: 150_000 }).run();

    const l = getSmallBusinessLimit(db, 2026, TODAY);
    expect(l.turnoverCents).toBe(500_000 - 50_000 + 400_000 + 300_000);
    expect(l.receivedCents).toBe(450_000 + 150_000);
  });

  test("a recurring run counts by the end of the period it covers", () => {
    const { db, client } = setup();
    db.insert(recurringInvoices)
      .values({ clientId: client.id, name: "Jahreslizenz", intervalUnit: "year", startDate: "2026-12-01", nextRunDate: "2026-12-01", taxMode: "SMALL_BUSINESS", netCents: 100_000, grossCents: 100_000 })
      .run();
    db.insert(recurringInvoices)
      .values({ clientId: client.id, name: "Ohne Zeitraum", intervalUnit: "year", startDate: "2026-12-01", nextRunDate: "2026-12-01", setServicePeriod: false, taxMode: "SMALL_BUSINESS", netCents: 70_000, grossCents: 70_000 })
      .run();
    expect(getSmallBusinessLimit(db, 2026, TODAY).projectedCents).toBe(70_000); // the licence covers 2027
  });

  test("only turnover taxable in Austria: EU reverse charge and third country (incl. their credit notes) don't count", () => {
    const { db, client, add } = setup();
    add({ type: "invoice", grossCents: 1_000_000 });
    add({ type: "credit_note", grossCents: 100_000, issueDate: "2026-03-20" });
    const eu = add({ type: "invoice", grossCents: 2_000_000, taxMode: "EU_REVERSE_CHARGE" });
    add({ type: "credit_note", parentId: eu.id, grossCents: 500_000, taxMode: "EU_REVERSE_CHARGE", issueDate: "2026-03-20" });
    add({ type: "invoice", grossCents: 3_000_000, taxMode: "THIRD_COUNTRY" });
    add({ type: "invoice", status: "draft", grossCents: 400_000, taxMode: "THIRD_COUNTRY" });
    add({ type: "invoice", status: "draft", grossCents: 50_000, taxMode: "AT_DOMESTIC" });
    db.insert(recurringInvoices)
      .values({ clientId: client.id, name: "CH", intervalUnit: "year", startDate: "2026-07-01", nextRunDate: "2026-07-01", taxMode: "THIRD_COUNTRY", netCents: 900_000, grossCents: 900_000 })
      .run();
    add({ type: "invoice", grossCents: 7_000_000, taxMode: "EU_REVERSE_CHARGE", issueDate: "2025-05-01" });

    const l = getSmallBusinessLimit(db, 2026, TODAY);
    expect(l.turnoverCents).toBe(1_000_000 - 100_000);
    expect(l.projectedCents).toBe(1_000_000 - 100_000 + 50_000);
    expect(l.previousYearCents).toBe(0);
    expect(l.previousYearExceeded).toBe(false);
  });

  test("dashboard includes it only for Kleinunternehmer", () => {
    const { db, add } = setup();
    add({ type: "invoice", grossCents: 100_000 });
    expect(getDashboard(db, 2026, TODAY).smallBusiness).toBeNull();
    updateSettings(db, { smallBusiness: true });
    expect(getDashboard(db, 2026, TODAY).smallBusiness?.turnoverCents).toBe(100_000);
  });
});
