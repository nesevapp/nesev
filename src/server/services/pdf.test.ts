import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { PDFDocument } from "@pdfme/pdf-lib";
import { createTestDb, type Db } from "../db/client";
import { clients, documentItems, documents, pdfTemplates } from "../db/schema";
import { epcQrPayload, mapDocumentToPdfInput } from "../lib/pdf/mapper";
import {
  buildSampleInput,
  ensureDefaultTemplates,
  freezeDocumentPdfWith,
  renderDocumentPdfWith,
  resolveTemplate,
} from "./pdf";
import { updateSettings } from "./settings";

const seller = {
  companyName: "Muster GmbH",
  ownerName: "Maria Muster",
  street: "Hauptstraße 1",
  zip: "1010",
  city: "Wien",
  country: "AT",
  uid: "ATU12345678",
  taxNumber: "",
  companyRegister: "",
  email: "office@muster.at",
  phone: "",
  website: "",
  iban: "AT61 1904 3002 3457 3201",
  bic: "BKAUATWW",
  bankName: "Bank Austria",
  logoPath: null,
};

const client = {
  clientId: 1,
  number: 1001,
  type: "company" as const,
  name: "Beispiel AG",
  contactPerson: "Max Mustermann",
  street: "Musterweg 5",
  addressExtra: "",
  zip: "80331",
  city: "München",
  country: "DE",
  uid: "DE123456789",
  email: "",
};

/** formatCents uses a no-break space after "€" */
const nbsp = (s: string | undefined) => JSON.parse(s!.replaceAll("\u00a0", " "));

const taxNotes = { taxNoteReverseCharge: "Reverse Charge.", taxNoteThirdCountry: "Drittland.", taxNoteSmallBusiness: "KU." };

describe("mapDocumentToPdfInput", () => {
  const base = {
    type: "invoice" as const,
    number: "RE-2026-0001",
    issueDate: "2026-10-13",
    servicePeriodStart: "2026-09-01",
    servicePeriodEnd: "2026-09-30",
    dueDate: "2026-10-27",
    validUntil: null,
    taxMode: "AT_DOMESTIC" as const,
    title: "Website",
    introText: "Hallo",
    closingText: "Danke",
  };
  const items = [
    { title: "Beratung", description: "vor Ort", quantity: 2500, unit: "h", unitPriceCents: 10000, taxRateBp: 2000, discountBp: 0 },
    { title: "Buch", description: "", quantity: 1000, unit: "", unitPriceCents: 2000, taxRateBp: 1000, discountBp: 1000 },
  ];

  test("formats documents, items and totals for de-AT", () => {
    const input = mapDocumentToPdfInput({ document: base, items, client, seller, taxNotes });
    expect(input.heading).toBe("Rechnung RE-2026-0001");
    expect(input.issueDate).toBe("13.10.2026");
    expect(input.servicePeriod).toBe("01.09.2026 – 30.09.2026");
    expect(input.recipientAddress).toBe("Beispiel AG\nz. Hd. Max Mustermann\nMusterweg 5\n80331 München\nDEUTSCHLAND");
    expect(input.infoLabels!.split("\n")).toEqual([
      "Rechnungsnr.",
      "Rechnungsdatum",
      "Leistungszeitraum",
      "Fällig am",
      "Kundennr.",
      "Ihre UID",
    ]);
    expect(nbsp(input.items)).toEqual([
      ["1", "Beratung\nvor Ort", "2,5 h", "€ 100,00", "20 %", "€ 250,00"],
      ["2", "Buch\nabzügl. 10 % Rabatt (€ 2,00)", "1", "€ 20,00", "10 %", "€ 18,00"],
    ]);
    expect(nbsp(input.totals)).toEqual([
      ["Summe netto", "€ 268,00"],
      ["USt 20 % von € 250,00", "€ 50,00"],
      ["USt 10 % von € 18,00", "€ 1,80"],
    ]);
    expect(input.grossTotal).toBe("€\u00a0319,80");
    expect(input.taxNote).toBe("");
    expect(input.sellerIban).toBe("AT61 1904 3002 3457 3201");
    expect(input.paymentInfo).toContain("**Zahlbar bis 27.10.2026**");
    expect(input.epcQr).toBe(
      "BCD\n002\n1\nSCT\nBKAUATWW\nMuster GmbH\nAT611904300234573201\nEUR319.80\n\n\nRE-2026-0001",
    );
    expect(input.footerBank).toContain("UID ATU12345678");
  });

  test("tax note, drafts and offers", () => {
    const input = mapDocumentToPdfInput({
      document: { ...base, type: "offer", number: null, taxMode: "EU_REVERSE_CHARGE", dueDate: null, validUntil: "2026-11-12" },
      items,
      client,
      seller,
      taxNotes,
    });
    expect(input.heading).toBe("Angebot (Entwurf)");
    expect(input.taxNote).toBe("Reverse Charge.");
    expect(input.epcQr).toBe("");
    expect(input.paymentInfo).toBe("");
    expect(input.infoValues).toContain("12.11.2026");
    expect(nbsp(input.totals)).toEqual([
      ["Summe netto", "€ 268,00"],
      ["USt 0 %", "€ 0,00"],
    ]);
  });

  test("no payment QR when settings.paymentQr is off", () => {
    const input = mapDocumentToPdfInput({ document: base, items, client, seller, taxNotes, paymentQr: false });
    expect(input.epcQr).toBe("");
    expect(input.epcQrLabel).toBe("");
    expect(input.paymentInfo).toContain("IBAN AT61");
    expect(mapDocumentToPdfInput({ document: base, items, client, seller, taxNotes }).epcQrLabel).toBe("Zahlen mit Code");
  });

  test("EPC payload is empty without IBAN or amount", () => {
    expect(epcQrPayload({ name: "X", iban: "", bic: "", amountCents: 100, reference: "" })).toBe("");
    expect(epcQrPayload({ name: "X", iban: "AT61", bic: "", amountCents: 0, reference: "" })).toBe("");
  });
});

function seedInvoice(db: Db, itemCount: number) {
  updateSettings(db, { ...seller, iban: "AT611904300234573201" });
  const c = db
    .insert(clients)
    .values({ number: 1001, name: "Beispiel AG", contactPerson: "Max Mustermann", street: "Musterweg 5", zip: "8010", city: "Graz" })
    .returning()
    .get();
  const doc = db
    .insert(documents)
    .values({ type: "invoice", clientId: c.id, issueDate: "2026-10-13", dueDate: "2026-10-27", taxMode: "AT_DOMESTIC", introText: "Vielen Dank." })
    .returning()
    .get();
  db.insert(documentItems)
    .values(
      Array.from({ length: itemCount }, (_, i) => ({
        documentId: doc.id,
        position: i,
        title: `Leistung ${i + 1}`,
        description: i % 3 === 0 ? "Ausführliche Beschreibung über mehrere Wörter, die umbrechen könnte." : "",
        quantity: 1000 + i * 250,
        unit: "Std.",
        unitPriceCents: 8500 + i * 10,
        taxRateBp: 2000,
      })),
    )
    .run();
  return doc;
}

describe("templates", () => {
  test("seeds one default per document type and resolves templates", () => {
    const db = createTestDb();
    ensureDefaultTemplates(db);
    ensureDefaultTemplates(db);
    const rows = db.select().from(pdfTemplates).all();
    expect(rows.map((r) => [r.docType, r.isDefault])).toEqual([
      ["offer", true],
      ["invoice", true],
      ["credit_note", true],
      ["reminder", true],
    ]);
    const invoiceDefault = rows.find((r) => r.docType === "invoice")!;
    expect(resolveTemplate(db, { type: "invoice", templateId: null }).id).toBe(invoiceDefault.id);
    expect(resolveTemplate(db, { type: "invoice", templateId: 999 }).id).toBe(invoiceDefault.id);
    expect(resolveTemplate(db, { type: "invoice", templateId: rows[0]!.id }).id).toBe(rows[0]!.id);
  });
});

describe("renderDocumentPdf", () => {
  test("renders a valid multi-page PDF for many items", async () => {
    const db = createTestDb();
    const doc = seedInvoice(db, 60);
    const bytes = await renderDocumentPdfWith(db, doc.id);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3);
    expect(pdf.getTitle()).toBe("Rechnung (Entwurf)");
    if (process.env.PDF_OUT) await Bun.write(process.env.PDF_OUT, bytes);
  }, 30_000);

  test("freezes the PDF to disk", async () => {
    const db = createTestDb();
    const doc = seedInvoice(db, 3);
    db.update(documents).set({ number: "RE-2026-0001", status: "final" }).where(eq(documents.id, doc.id)).run();
    const dir = mkdtempSync(join(tmpdir(), "nesev-pdf-"));
    const path = await freezeDocumentPdfWith(db, doc.id, dir);
    expect(path).toBe("pdfs/RE-2026-0001.pdf");
    expect(await Bun.file(join(dir, "RE-2026-0001.pdf")).exists()).toBe(true);
  }, 30_000);

  test("sample input covers every document type", async () => {
    const db = createTestDb();
    for (const type of ["offer", "invoice", "credit_note"] as const) {
      const input = await buildSampleInput(db, type);
      expect(JSON.parse(input.items!).length).toBe(4);
    }
  });
});
