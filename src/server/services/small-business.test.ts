import { describe, expect, test } from "bun:test";
import { smallBusinessLevel } from "../../shared/small-business";
import { createTestDb } from "../db/client";
import { clients, documents, type NewDocument, recurringInvoices } from "../db/schema";
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

  test("dashboard includes it only for Kleinunternehmer", () => {
    const { db, add } = setup();
    add({ type: "invoice", grossCents: 100_000 });
    expect(getDashboard(db, 2026, TODAY).smallBusiness).toBeNull();
    updateSettings(db, { smallBusiness: true });
    expect(getDashboard(db, 2026, TODAY).smallBusiness?.turnoverCents).toBe(100_000);
  });
});
