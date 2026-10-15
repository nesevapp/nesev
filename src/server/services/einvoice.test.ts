import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { clientCreateSchema } from "../../shared/schemas/client";
import { createTestDb, type Db } from "../db/client";
import { clients, type NewClient } from "../db/schema";
import { extractEmbeddedInvoiceXml, find, parseEInvoiceXml, parseXml } from "../lib/ocr/einvoice";
import { createClient, updateClient } from "./clients";
import { createCreditNote, createDocument, finalizeDocument, getDocument, updateDocument } from "./documents";
import { buildEInvoiceFile, eInvoiceStatus } from "./einvoice";
import { updateSettings } from "./settings";

function setup(client: Partial<NewClient> = {}) {
  const db = createTestDb();
  updateSettings(db, {
    companyName: "Muster Design e.U.",
    ownerName: "Maria Muster",
    street: "Mariahilfer Straße 1",
    zip: "1060",
    city: "Wien",
    uid: "ATU12345678",
    email: "office@muster.at",
    phone: "+43 1 234",
    iban: "AT611904300234573201",
    bic: "BKAUATWW",
  });
  const c = db
    .insert(clients)
    .values({ number: 1, name: "Bundesamt für Tests", street: "Ring 1", zip: "1010", city: "Wien", country: "AT", ...client })
    .returning()
    .get();
  return { db, client: c };
}

function invoice(db: Db, clientId: number, buyerReference?: string) {
  const doc = createDocument(db, {
    type: "invoice",
    clientId,
    issueDate: "2026-03-31",
    buyerReference,
    items: [{ title: "Beratung", description: "", quantity: 2000, unit: "Std.", unitPriceCents: 10000, taxRateBp: 2000, discountBp: 0 }],
  });
  return finalizeDocument(db, doc.id);
}

async function httpError(p: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof HTTPException) return { status: e.status, message: e.message };
    throw e;
  }
  throw new Error("expected an HTTPException");
}

describe("e-invoice service", () => {
  test("client fields and the document's buyer reference are persisted", () => {
    const db = createTestDb();
    const c = createClient(
      db,
      clientCreateSchema.parse({
        type: "company",
        name: "Stadt Musterhausen",
        country: "DE",
        eInvoiceFormat: "xrechnung",
        eInvoiceBuyerReference: "04011000-1234512345-06",
        eInvoiceSupplierId: "L-77",
      }),
    );
    expect(c).toMatchObject({ eInvoiceFormat: "xrechnung", eInvoiceBuyerReference: "04011000-1234512345-06", eInvoiceSupplierId: "L-77" });
    expect(updateClient(db, c.id, { eInvoiceFormat: null }).eInvoiceSupplierId).toBe("L-77");

    const doc = createDocument(db, { type: "invoice", clientId: c.id, buyerReference: "PO-1" });
    expect(doc.buyerReference).toBe("PO-1");
    expect(updateDocument(db, doc.id, { buyerReference: "PO-2" }).buyerReference).toBe("PO-2");
  });

  test("status: default format, buyer reference fallback, problems per format", () => {
    const { db, client } = setup({ eInvoiceFormat: "ebinterface", eInvoiceBuyerReference: "4500001", eInvoiceSupplierId: "9876" });
    const doc = invoice(db, client.id);
    const status = eInvoiceStatus(db, doc.id);
    expect(status.defaultFormat).toBe("ebinterface");
    expect(status.buyerReference).toBe("4500001");
    expect(status.formats.map((f) => [f.format, f.problems])).toEqual([
      ["ebinterface", []],
      ["xrechnung", ["Kunde: E-Mail-Adresse fehlt (elektronische Adresse, da die Referenz keine Leitweg-ID ist)"]],
      ["zugferd", []],
    ]);
  });

  test("ebInterface download uses the document reference over the client default", async () => {
    const { db, client } = setup({ eInvoiceFormat: "ebinterface", eInvoiceBuyerReference: "4500001", eInvoiceSupplierId: "9876" });
    const doc = invoice(db, client.id, "4500002");
    const file = await buildEInvoiceFile(db, doc.id, "ebinterface");
    expect(file.fileName).toBe(`${doc.number}_ebinterface.xml`);
    const xml = parseXml(new TextDecoder().decode(file.bytes));
    expect(find(xml, "InvoiceRecipient", "OrderReference", "OrderID")?.text).toBe("4500002");
    expect(find(xml, "Biller", "InvoiceRecipientsBillerID")?.text).toBe("9876");
    expect(find(xml, "PayableAmount")?.text).toBe("240.00");
  });

  test("missing Leitweg-ID → 422 with the German reason", async () => {
    const { db, client } = setup({ country: "DE", email: "a@b.de" });
    const doc = invoice(db, client.id);
    const err = await httpError(buildEInvoiceFile(db, doc.id, "xrechnung"));
    expect(err.status).toBe(422);
    expect(err.message).toContain("Leitweg-ID fehlt");
  });

  test("drafts and offers are refused", async () => {
    const { db, client } = setup();
    const draft = createDocument(db, { type: "invoice", clientId: client.id });
    expect((await httpError(() => eInvoiceStatus(db, draft.id))).status).toBe(409);
    const offer = createDocument(db, { type: "offer", clientId: client.id });
    expect((await httpError(() => eInvoiceStatus(db, offer.id))).status).toBe(422);
  });

  test("credit note: XRechnung CreditNote referencing the invoice, reference carried over", async () => {
    const { db, client } = setup({ country: "DE", email: "a@b.de", eInvoiceBuyerReference: "04011000-1234512345-06" });
    const inv = invoice(db, client.id, "991-12345-06");
    const draft = createCreditNote(db, inv.id);
    expect(draft.buyerReference).toBe("991-12345-06");
    const cn = finalizeDocument(db, draft.id);
    const file = await buildEInvoiceFile(db, cn.id, "xrechnung");
    const xml = new TextDecoder().decode(file.bytes);
    expect(xml).toContain("<CreditNote ");
    expect(find(parseXml(xml), "BillingReference", "InvoiceDocumentReference", "ID")?.text).toBe(inv.number!);
    expect(parseEInvoiceXml(xml)!.fields.grossCents?.value).toBe(getDocument(db, cn.id).grossCents);
  });

  test("ZUGFeRD: rendered PDF with factur-x.xml", async () => {
    const { db, client } = setup({ eInvoiceFormat: "zugferd" });
    const doc = invoice(db, client.id);
    const file = await buildEInvoiceFile(db, doc.id, "zugferd");
    expect(file.contentType).toBe("application/pdf");
    expect(file.fileName).toBe(`${doc.number}_zugferd.pdf`);
    const xml = await extractEmbeddedInvoiceXml(file.bytes);
    expect(parseEInvoiceXml(xml!)!.fields.grossCents?.value).toBe(24000);
  });
});
