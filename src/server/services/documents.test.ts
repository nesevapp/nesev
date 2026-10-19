import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { addDays, todayIso } from "../../shared/dates";
import type { DocumentItemInput } from "../../shared/schemas/document";
import { createTestDb, type Db } from "../db/client";
import { bankAccounts, bankMatches, bankTransactions, clients, documentItems, documents, type NewClient } from "../db/schema";
import {
  changeStatus,
  convertOfferToInvoice,
  createCreditNote,
  createDocument,
  deleteDocument,
  documentDefaults,
  duplicateDocument,
  finalizeDocument,
  finalizeWarnings,
  getDocument,
  listDocuments,
  settleInvoice,
  updateDocument,
} from "./documents";
import { updateSettings } from "./settings";

const item = (over: Partial<DocumentItemInput> = {}): DocumentItemInput => ({
  title: "Beratung",
  description: "",
  quantity: 2000,
  unit: "h",
  unitPriceCents: 10000,
  taxRateBp: 2000,
  discountBp: 0,
  ...over,
});

let clientNo = 0;
function addClient(db: Db, over: Partial<NewClient> = {}) {
  return db
    .insert(clients)
    .values({ number: ++clientNo, name: "Muster GmbH", country: "AT", ...over })
    .returning()
    .get();
}

function setup() {
  const db = createTestDb();
  const client = addClient(db);
  return { db, client };
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

describe("create / update", () => {
  test("prefills texts, tax mode and dates from settings + client", () => {
    const { db } = setup();
    updateSettings(db, { paymentTermsDays: 10, offerValidityDays: 20, defaultInvoiceIntro: "Hallo RE" });
    const de = addClient(db, { country: "DE", uid: "DE123456789", paymentTermsDays: 30 });

    const inv = createDocument(db, { type: "invoice", clientId: de.id, issueDate: "2026-03-01" });
    expect(inv.status).toBe("draft");
    expect(inv.number).toBeNull();
    expect(inv.taxMode).toBe("EU_REVERSE_CHARGE");
    expect(inv.dueDate).toBe("2026-03-31");
    expect(inv.validUntil).toBeNull();
    expect(inv.introText).toBe("Hallo RE");

    const offer = createDocument(db, { type: "offer", clientId: de.id, issueDate: "2026-03-01", taxMode: "AT_DOMESTIC" });
    expect(offer.validUntil).toBe("2026-03-21");
    expect(offer.dueDate).toBeNull();
    expect(offer.taxMode).toBe("AT_DOMESTIC");

    expect(documentDefaults(db, "invoice").dueDate).toBe(addDays(todayIso(), 10));
  });

  test("caches totals on create and update, replacing items", () => {
    const { db, client } = setup();
    const doc = createDocument(db, {
      type: "invoice",
      clientId: client.id,
      items: [item(), item({ unitPriceCents: 5000, quantity: 1000, taxRateBp: 1000, discountBp: 1000 })],
    });
    // 200,00 @20 % + 45,00 @10 %
    expect([doc.netCents, doc.taxCents, doc.grossCents]).toEqual([24500, 4450, 28950]);
    expect(doc.items.map((i) => i.position)).toEqual([0, 1]);

    const updated = updateDocument(db, doc.id, { items: [item({ quantity: 1000 })] });
    expect(updated.items).toHaveLength(1);
    expect([updated.netCents, updated.taxCents, updated.grossCents]).toEqual([10000, 2000, 12000]);

    // tax mode change alone recomputes the cache from stored items
    const rc = updateDocument(db, doc.id, { taxMode: "THIRD_COUNTRY" });
    expect([rc.netCents, rc.taxCents, rc.grossCents]).toEqual([10000, 0, 10000]);
    expect(db.select().from(documentItems).where(eq(documentItems.documentId, doc.id)).all()).toHaveLength(1);
  });

  test("unknown client is rejected", () => {
    const { db } = setup();
    expectHttp(() => createDocument(db, { type: "offer", clientId: 999 }), 422, "Kunde");
  });
});

describe("finalize", () => {
  test("assigns gapless numbers per type/year, snapshots and locks", () => {
    const { db, client } = setup();
    updateSettings(db, { companyName: "Ich e.U." });
    const a = createDocument(db, { type: "invoice", clientId: client.id, issueDate: "2026-05-01", items: [item()] });
    const b = createDocument(db, { type: "invoice", clientId: client.id, issueDate: "2026-06-01", items: [item()] });
    const o = createDocument(db, { type: "offer", clientId: client.id, issueDate: "2026-06-01", items: [item()] });
    const c = createDocument(db, { type: "invoice", clientId: client.id, issueDate: "2027-01-02", items: [item()] });

    const fa = finalizeDocument(db, a.id);
    expect(fa.number).toBe("RE-2026-0001");
    expect(fa.status).toBe("final");
    expect(fa.finalizedAt).not.toBeNull();
    expect(fa.clientSnapshot?.name).toBe("Muster GmbH");
    expect(fa.sellerSnapshot?.companyName).toBe("Ich e.U.");
    expect(finalizeDocument(db, b.id).number).toBe("RE-2026-0002");
    expect(finalizeDocument(db, o.id).number).toBe("AN-2026-0001");
    expect(finalizeDocument(db, c.id).number).toBe("RE-2027-0001");

    // locked
    expectHttp(() => updateDocument(db, a.id, { title: "x" }), 409);
    expectHttp(() => deleteDocument(db, a.id), 409);
    expectHttp(() => finalizeDocument(db, a.id), 409);

    // snapshot is frozen: renaming the client doesn't change the finalized doc
    db.update(clients).set({ name: "Neu GmbH" }).where(eq(clients.id, client.id)).run();
    expect(getDocument(db, a.id).clientName).toBe("Muster GmbH");
  });

  test("validation failures do not consume a number", () => {
    const { db, client } = setup();
    const empty = createDocument(db, { type: "invoice", clientId: client.id, issueDate: "2026-01-01" });
    expectHttp(() => finalizeDocument(db, empty.id), 422, "Position");
    const untitled = createDocument(db, { type: "invoice", clientId: client.id, issueDate: "2026-01-01", items: [item({ title: " " })] });
    expectHttp(() => finalizeDocument(db, untitled.id), 422, "Bezeichnung");

    const ok = createDocument(db, { type: "invoice", clientId: client.id, issueDate: "2026-01-01", items: [item()] });
    expect(finalizeDocument(db, ok.id).number).toBe("RE-2026-0001");
    expect(getDocument(db, empty.id).number).toBeNull();
  });

  test("EU reverse charge requires the client UID", () => {
    const { db } = setup();
    const noUid = addClient(db, { country: "DE", uid: "" });
    const doc = createDocument(db, { type: "invoice", clientId: noUid.id, taxMode: "EU_REVERSE_CHARGE", items: [item()] });
    expect(doc.taxCents).toBe(0);
    expectHttp(() => finalizeDocument(db, doc.id), 422, "UID");
    db.update(clients).set({ uid: "DE123456789" }).where(eq(clients.id, noUid.id)).run();
    expect(finalizeDocument(db, doc.id).status).toBe("final");
  });

  test("credit notes: invoice's tax mode required, cumulative total capped at the invoice gross", () => {
    const { db, client } = setup();
    const inv = finalizeDocument(db, createDocument(db, { type: "invoice", clientId: client.id, items: [item()] }).id); // 240,00
    const wrongMode = createCreditNote(db, inv.id);
    updateDocument(db, wrongMode.id, { taxMode: "SMALL_BUSINESS" });
    expectHttp(() => finalizeDocument(db, wrongMode.id), 422, "Steuerart");
    expect(getDocument(db, wrongMode.id).number).toBeNull(); // no number consumed
    deleteDocument(db, wrongMode.id);

    const first = createCreditNote(db, inv.id);
    updateDocument(db, first.id, { items: [item({ quantity: 1500 })] }); // 180,00
    finalizeDocument(db, first.id);
    const second = createCreditNote(db, inv.id); // another 240,00 → 420,00 > 240,00
    expectHttp(() => finalizeDocument(db, second.id), 422, "übersteigen");
    updateDocument(db, second.id, { items: [item({ quantity: 500 })] }); // 60,00 → exactly 240,00
    expect(finalizeDocument(db, second.id).status).toBe("final");
    expect(getDocument(db, inv.id).status).toBe("paid");
    const third = createCreditNote(db, inv.id);
    updateDocument(db, third.id, { items: [item({ quantity: 1, unitPriceCents: 1000 })] }); // 0,01 € too much
    expectHttp(() => finalizeDocument(db, third.id), 422, "noch offen für Gutschriften");
  });

  test("settleInvoice uses the open amount: a refund beyond the credit note reopens an auto-paid invoice", () => {
    const { db, client } = setup();
    const account = db.insert(bankAccounts).values({ name: "Giro" }).returning().get();
    let seq = 0;
    const allocate = (documentId: number, date: string, amountCents: number) => {
      const tx = db.insert(bankTransactions).values({ accountId: account.id, bookingDate: date, amountCents, importHash: `h${++seq}`, status: "matched" }).returning().get();
      db.insert(bankMatches).values({ transactionId: tx.id, documentId, amountCents: Math.abs(amountCents) }).run();
      settleInvoice(db, documentId, new Set());
    };
    const inv = finalizeDocument(db, createDocument(db, { type: "invoice", clientId: client.id, items: [item()] }).id); // 240,00
    allocate(inv.id, "2026-03-01", 24000);
    expect(getDocument(db, inv.id)).toMatchObject({ status: "paid", paidAt: "2026-03-01" });

    const cn = createCreditNote(db, inv.id);
    updateDocument(db, cn.id, { issueDate: "2026-02-20", items: [item({ quantity: 500 })] }); // 60,00
    finalizeDocument(db, cn.id);
    allocate(cn.id, "2026-03-10", -6000); // refund of the credit note: still settled
    expect(getDocument(db, inv.id)).toMatchObject({ status: "paid", paidAt: "2026-03-01" });
    allocate(cn.id, "2026-03-12", -6000); // refunded twice → 60,00 open again
    expect(getDocument(db, inv.id)).toMatchObject({ status: "final", paidAt: null, openCents: 6000 });
  });

  test("finalize warnings: AT invoice to a business above € 10.000 gross needs the client's UID", () => {
    const { db, client } = setup();
    const big = createDocument(db, { type: "invoice", clientId: client.id, items: [item({ quantity: 1000, unitPriceCents: 833334 })] }); // 10.000,01 gross
    expect(finalizeWarnings(db, big.id)).toEqual([expect.stringContaining("§ 11 Abs. 1 Z 3 lit. i")]);
    const exact = createDocument(db, { type: "invoice", clientId: client.id, items: [item({ quantity: 1000, unitPriceCents: 833333 })] }); // 9.999,99... ≤ 10.000
    expect(finalizeWarnings(db, exact.id)).toEqual([]);
    const person = addClient(db, { type: "person" });
    expect(finalizeWarnings(db, createDocument(db, { type: "invoice", clientId: person.id, items: [item({ unitPriceCents: 900000 })] }).id)).toEqual([]);
    db.update(clients).set({ uid: "ATU12345678" }).where(eq(clients.id, client.id)).run();
    expect(finalizeWarnings(db, big.id)).toEqual([]);
    // a warning only: finalizing still works
    db.update(clients).set({ uid: "" }).where(eq(clients.id, client.id)).run();
    expect(finalizeDocument(db, big.id).status).toBe("final");
  });

  test("fills a missing due date", () => {
    const { db, client } = setup();
    const doc = createDocument(db, { type: "invoice", clientId: client.id, issueDate: "2026-02-01", dueDate: null, items: [item()] });
    expect(doc.dueDate).toBeNull();
    expect(finalizeDocument(db, doc.id).dueDate).toBe("2026-02-15");
  });
});

describe("status", () => {
  test("invoice: sent → paid → unpaid, overdue derived", () => {
    const { db, client } = setup();
    const doc = createDocument(db, { type: "invoice", clientId: client.id, issueDate: "2020-01-01", dueDate: "2020-01-15", items: [item()] });
    expectHttp(() => changeStatus(db, doc.id, { action: "sent" }), 409, "finalisiert");
    finalizeDocument(db, doc.id);
    expect(getDocument(db, doc.id).overdue).toBe(true);
    expect(listDocuments(db, { type: "invoice", status: "overdue" }).map((d) => d.id)).toEqual([doc.id]);

    const sent = changeStatus(db, doc.id, { action: "sent" });
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).not.toBeNull();
    expectHttp(() => changeStatus(db, doc.id, { action: "accepted" }), 409);

    const paid = changeStatus(db, doc.id, { action: "paid", paidAt: "2020-02-01" });
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).toBe("2020-02-01");
    expect(paid.overdue).toBe(false);
    expect(listDocuments(db, { type: "invoice", status: "overdue" })).toHaveLength(0);

    const unpaid = changeStatus(db, doc.id, { action: "unpaid" });
    expect(unpaid.status).toBe("sent");
    expect(unpaid.paidAt).toBeNull();
  });

  test("offer: sent → accepted ↔ declined; credit notes have no transitions", () => {
    const { db, client } = setup();
    const offer = createDocument(db, { type: "offer", clientId: client.id, items: [item()] });
    finalizeDocument(db, offer.id);
    expectHttp(() => changeStatus(db, offer.id, { action: "paid" }), 409);
    expect(changeStatus(db, offer.id, { action: "sent" }).status).toBe("sent");
    expect(changeStatus(db, offer.id, { action: "accepted" }).status).toBe("accepted");
    expect(changeStatus(db, offer.id, { action: "declined" }).status).toBe("declined");

    const inv = createDocument(db, { type: "invoice", clientId: client.id, items: [item()] });
    finalizeDocument(db, inv.id);
    const gs = createCreditNote(db, inv.id);
    finalizeDocument(db, gs.id);
    expectHttp(() => changeStatus(db, gs.id, { action: "sent" }), 409);
  });
});

describe("conversions", () => {
  test("offer → invoice draft copies items, links parent, accepts offer", () => {
    const { db, client } = setup();
    const offer = createDocument(db, {
      type: "offer",
      clientId: client.id,
      title: "Website",
      taxMode: "THIRD_COUNTRY",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-01-31",
      items: [item(), item({ title: "Hosting", quantity: 12000, unit: "Monat", unitPriceCents: 990 })],
    });
    finalizeDocument(db, offer.id);
    const inv = convertOfferToInvoice(db, offer.id);
    expect(inv.type).toBe("invoice");
    expect(inv.status).toBe("draft");
    expect(inv.parentId).toBe(offer.id);
    expect(inv.parent?.number).toBe("AN-" + todayIso().slice(0, 4) + "-0001");
    expect(inv.title).toBe("Website");
    expect(inv.taxMode).toBe("THIRD_COUNTRY");
    expect(inv.servicePeriodEnd).toBe("2026-01-31");
    expect(inv.items.map((i) => i.title)).toEqual(["Beratung", "Hosting"]);
    expect(inv.grossCents).toBe(offer.grossCents);
    expect(inv.dueDate).not.toBeNull();
    expect(getDocument(db, offer.id).status).toBe("accepted");
    expect(getDocument(db, offer.id).children.map((c) => c.id)).toEqual([inv.id]);

    expectHttp(() => convertOfferToInvoice(db, inv.id), 422);
  });

  test("credit note from final invoice: positive amounts, parent link", () => {
    const { db, client } = setup();
    const inv = createDocument(db, { type: "invoice", clientId: client.id, items: [item()] });
    expectHttp(() => createCreditNote(db, inv.id), 409);
    const finalInv = finalizeDocument(db, inv.id);
    const gs = createCreditNote(db, inv.id);
    expect(gs.type).toBe("credit_note");
    expect(gs.parentId).toBe(inv.id);
    expect(gs.title).toContain(finalInv.number!);
    expect(gs.grossCents).toBe(finalInv.grossCents);
    expect(gs.grossCents).toBeGreaterThan(0);
    expect(gs.dueDate).toBeNull();
    expect(finalizeDocument(db, gs.id).number).toMatch(/^GS-\d{4}-0001$/);
  });

  test("duplicate creates a fresh draft with today's dates", () => {
    const { db, client } = setup();
    const inv = createDocument(db, { type: "invoice", clientId: client.id, issueDate: "2025-01-01", title: "T", items: [item()] });
    finalizeDocument(db, inv.id);
    const dup = duplicateDocument(db, inv.id);
    expect(dup.id).not.toBe(inv.id);
    expect(dup.status).toBe("draft");
    expect(dup.number).toBeNull();
    expect(dup.issueDate).toBe(todayIso());
    expect(dup.title).toBe("T");
    expect(dup.items).toHaveLength(1);
    expect(dup.clientSnapshot).toBeNull();
    expect(dup.parentId).toBeNull();
  });

  test("delete only drafts; items cascade", () => {
    const { db, client } = setup();
    const doc = createDocument(db, { type: "offer", clientId: client.id, items: [item()] });
    deleteDocument(db, doc.id);
    expect(db.select().from(documents).all()).toHaveLength(0);
    expect(db.select().from(documentItems).all()).toHaveLength(0);
  });
});

test("list filters and search", () => {
  const { db, client } = setup();
  const other = addClient(db, { name: "Beispiel AG", country: "CH" });
  const a = createDocument(db, { type: "invoice", clientId: client.id, issueDate: "2026-01-10", items: [item()] });
  createDocument(db, { type: "invoice", clientId: other.id, issueDate: "2026-02-10", title: "Logo" });
  createDocument(db, { type: "offer", clientId: other.id, issueDate: "2026-02-10" });
  finalizeDocument(db, a.id);

  expect(listDocuments(db, { type: "invoice" })).toHaveLength(2);
  expect(listDocuments(db, { type: "invoice", status: "final" }).map((d) => d.id)).toEqual([a.id]);
  expect(listDocuments(db, { type: "invoice", clientId: other.id })).toHaveLength(1);
  expect(listDocuments(db, { type: "invoice", q: "beispiel" })[0]?.clientName).toBe("Beispiel AG");
  expect(listDocuments(db, { type: "invoice", q: "RE-2026" }).map((d) => d.id)).toEqual([a.id]);
  expect(listDocuments(db, { type: "invoice", q: "logo" })).toHaveLength(1);
  expect(listDocuments(db, { type: "invoice", from: "2026-02-01", to: "2026-02-28" })).toHaveLength(1);
  expect(listDocuments(db, { clientId: other.id })).toHaveLength(2);
});
