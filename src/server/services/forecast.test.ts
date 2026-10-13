import { describe, expect, test } from "bun:test";
import type { RecurringCreate } from "../../shared/schemas/recurring";
import { createTestDb, type Db } from "../db/client";
import { clients, documents, type NewClient, type NewDocument } from "../db/schema";
import { buildForecast, paymentDelays } from "./forecast";
import { createRecurring } from "./recurring";
import { updateSettings } from "./settings";

const TODAY = "2026-10-13";
let clientNo = 0;

function addClient(db: Db, over: Partial<NewClient> = {}) {
  return db
    .insert(clients)
    .values({ number: ++clientNo, name: `Kunde ${clientNo}`, country: "AT", ...over })
    .returning()
    .get();
}

let docNo = 0;
function addInvoice(db: Db, over: Partial<NewDocument> & { clientId: number }) {
  return db
    .insert(documents)
    .values({
      type: "invoice",
      status: "final",
      number: `RE-T-${++docNo}`,
      issueDate: "2026-09-01",
      dueDate: "2026-09-15",
      taxMode: "AT_DOMESTIC",
      netCents: 10000,
      taxCents: 2000,
      grossCents: 12000,
      ...over,
    })
    .returning()
    .get();
}

function setup() {
  const db = createTestDb();
  updateSettings(db, { paymentTermsDays: 14 });
  return db;
}

const base = { months: 3, includeDrafts: false, includeOffers: false, offerProbability: 50, today: TODAY };

describe("payment delays", () => {
  test("averages paidAt − dueDate per client with a global fallback", () => {
    const db = setup();
    const late = addClient(db);
    const punctual = addClient(db);
    addInvoice(db, { clientId: late.id, status: "paid", dueDate: "2026-05-01", paidAt: "2026-05-11" });
    addInvoice(db, { clientId: late.id, status: "paid", dueDate: "2026-06-01", paidAt: "2026-06-03" });
    addInvoice(db, { clientId: punctual.id, status: "paid", dueDate: "2026-06-10", paidAt: "2026-06-07" });
    const { byClient, global } = paymentDelays(db);
    expect(byClient.get(late.id)).toEqual({ days: 6, basis: "client", samples: 2 });
    expect(byClient.get(punctual.id)).toEqual({ days: -3, basis: "client", samples: 1 });
    expect(global).toEqual({ days: 3, basis: "global", samples: 3 });
  });

  test("no history → 0 days", () => {
    expect(paymentDelays(setup()).global).toEqual({ days: 0, basis: "none", samples: 0 });
  });
});

describe("open invoices", () => {
  test("expected = due date + client delay; overdue lands in the overdue bucket at today", () => {
    const db = setup();
    const late = addClient(db);
    addInvoice(db, { clientId: late.id, status: "paid", dueDate: "2026-05-01", paidAt: "2026-05-11" });
    const open = addInvoice(db, { clientId: late.id, dueDate: "2026-10-20" });
    const overdue = addInvoice(db, { clientId: late.id, dueDate: "2026-10-01", grossCents: 5000, taxCents: 0 });
    addInvoice(db, { clientId: late.id, status: "draft", number: null, dueDate: "2026-10-25" });

    const f = buildForecast(db, base);
    const byDoc = new Map(f.entries.map((e) => [e.documentId, e]));
    expect(f.entries).toHaveLength(2); // draft excluded by default
    expect(byDoc.get(open.id)!.expectedDate).toBe("2026-10-30");
    expect(byDoc.get(open.id)!.overdue).toBe(false);
    expect(byDoc.get(overdue.id)!.overdue).toBe(true);
    expect(byDoc.get(overdue.id)!.expectedDate).toBe(TODAY);
    expect(byDoc.get(overdue.id)!.daysOverdue).toBe(12);

    expect(f.overdueBucket.totalCents).toBe(5000);
    expect(f.kpis.overdue).toBe(5000);
    expect(f.monthly.map((m) => m.key)).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(f.monthly[0]!.bySource.invoice).toBe(12000); // overdue not double counted
    expect(f.monthly[0]!.cumulativeCents).toBe(17000);
    expect(f.kpis.total).toBe(17000);
    expect(f.kpis.tax).toBe(2000);

    expect(buildForecast(db, { ...base, includeDrafts: true }).entries.some((e) => e.source === "draft")).toBe(true);
  });

  test("credit notes reduce the open amount", () => {
    const db = setup();
    const c = addClient(db);
    const inv = addInvoice(db, { clientId: c.id, dueDate: "2026-11-01" });
    db.insert(documents)
      .values({ type: "credit_note", status: "final", clientId: c.id, issueDate: "2026-10-01", taxMode: "AT_DOMESTIC", parentId: inv.id, grossCents: 12000, taxCents: 2000, netCents: 10000 })
      .run();
    expect(buildForecast(db, base).entries).toHaveLength(0);
  });
});

describe("recurring projection", () => {
  const rec = (clientId: number, over: Partial<RecurringCreate> = {}): RecurringCreate => ({
    name: "Wartung",
    clientId,
    active: true,
    intervalUnit: "month",
    intervalCount: 1,
    startDate: "2026-10-31",
    endDate: null,
    setServicePeriod: true,
    autoFinalize: false,
    taxMode: "AT_DOMESTIC",
    title: "",
    introText: "",
    closingText: "",
    templateId: null,
    items: [{ title: "Wartung", description: "", quantity: 1000, unit: "", unitPriceCents: 10000, taxRateBp: 2000, discountBp: 0 }],
    ...over,
  });

  test("projects every run whose payment falls inside the horizon, respecting endDate and active", () => {
    const db = setup();
    const c = addClient(db, { paymentTermsDays: 10 });
    createRecurring(db, rec(c.id));
    createRecurring(db, rec(c.id, { name: "Ende", endDate: "2026-11-15" }));
    createRecurring(db, rec(c.id, { name: "Aus", active: false }));
    createRecurring(db, rec(c.id, { name: "Quartal", intervalCount: 3, startDate: "2026-10-15" }));

    const f = buildForecast(db, base); // horizon until 2026-12-31
    const wartung = f.entries.filter((e) => e.label === "Wartung");
    // runs 31.10. and 30.11. pay on 10.11./10.12.; the 31.12. run pays in January
    expect(wartung.map((e) => e.expectedDate)).toEqual(["2026-11-10", "2026-12-10"]);
    expect(wartung[0]!.grossCents).toBe(12000);
    expect(wartung[0]!.taxCents).toBe(2000);
    expect(f.entries.filter((e) => e.label === "Ende")).toHaveLength(1);
    expect(f.entries.filter((e) => e.label === "Aus")).toHaveLength(0);
    expect(f.entries.filter((e) => e.label === "Quartal").map((e) => e.issueDate)).toEqual(["2026-10-15"]);
    expect(f.kpis.recurring).toBe(4 * 12000);

    const f12 = buildForecast(db, { ...base, months: 12 });
    expect(f12.entries.filter((e) => e.label === "Quartal")).toHaveLength(4);
  });
});

describe("offers", () => {
  test("weighted by probability, off by default, expired/declined excluded", () => {
    const db = setup();
    const c = addClient(db);
    const offer = (over: Partial<NewDocument>) =>
      db.insert(documents)
        .values({ type: "offer", status: "sent", clientId: c.id, issueDate: "2026-10-01", validUntil: "2026-10-31", taxMode: "AT_DOMESTIC", netCents: 100000, taxCents: 20000, grossCents: 120000, ...over })
        .run();
    offer({});
    offer({ validUntil: "2026-10-01" });
    offer({ status: "declined" });

    expect(buildForecast(db, base).entries).toHaveLength(0);
    const f = buildForecast(db, { ...base, includeOffers: true, offerProbability: 25 });
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]!.grossCents).toBe(30000);
    expect(f.entries[0]!.taxCents).toBe(5000);
    expect(f.entries[0]!.fullGrossCents).toBe(120000);
    expect(f.entries[0]!.expectedDate).toBe("2026-10-27");
  });
});
